//! Historique des versions d'une page.
//!
//! Stratégie (jamais une version par frappe) :
//!  * une version AUTOMATIQUE au plus toutes les 10 minutes, créée lors d'un enregistrement dont le contenu a changé ;
//!  * des versions MANUELLES (avec nom) et de RESTAURATION (sauvegarde de l'état courant juste avant de restaurer),
//!    conservées sans limite de durée ;
//!  * conservation des automatiques : toutes celles des dernières 24 h, puis la dernière de chaque jour pendant 30 jours,
//!    100 au plus par page.
//!
//! Restaurer ne réécrit JAMAIS l'état courant en silence : l'interface sauvegarde d'abord l'état actuel (raison `restore`),
//! puis applique l'ancien contenu comme une modification ordinaire (annulable).

use crate::error::{AppError, AppResult};
use crate::tree;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const AUTO_INTERVAL_SECS: f64 = 600.0;
const KEEP_ALL_SECS: f64 = 86_400.0;
const KEEP_DAILY_SECS: f64 = 30.0 * 86_400.0;
const MAX_AUTO: usize = 100;
const MAX_VERSIONS_PER_PAGE: i64 = 1_000;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub id: String,
    pub node_id: String,
    pub created_at: String,
    pub reason: String,
    pub label: Option<String>,
    pub author: Option<String>,
    pub bytes: i64,
    pub words: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionData {
    #[serde(flatten)]
    pub meta: VersionMeta,
    pub content_json: String,
    pub text_plain: String,
}

fn words(text: &str) -> i64 {
    text.split_whitespace().count() as i64
}

fn map_meta(r: &rusqlite::Row<'_>) -> rusqlite::Result<VersionMeta> {
    let text: String = r.get(8)?;
    Ok(VersionMeta {
        id: r.get(0)?,
        node_id: r.get(1)?,
        created_at: r.get(2)?,
        reason: r.get(3)?,
        label: r.get(4)?,
        author: r.get(5)?,
        bytes: r.get(6)?,
        words: words(&text),
    })
}
const META_COLS: &str = "id, node_id, created_at, reason, label, author, bytes, '', text_plain";

fn latest(conn: &Connection, node_id: &str) -> AppResult<Option<(String, String, String)>> {
    Ok(conn
        .query_row(
            "SELECT id, content_json, created_at FROM page_version WHERE node_id = ?1
             ORDER BY created_at DESC, id DESC LIMIT 1",
            [node_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

fn clean(opt: Option<&str>, max: usize) -> AppResult<Option<String>> {
    match opt.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if s.chars().count() > max => Err(AppError::Invalid("texte trop long".into())),
        Some(s) => Ok(Some(s.replace(['\n', '\r'], " "))),
    }
}

/// Instantané du contenu ENREGISTRÉ de la page. Si le dernier instantané est identique, il est réutilisé
/// (une version manuelle peut le nommer) : pas de doublons.
pub fn snapshot(
    conn: &Connection,
    node_id: &str,
    reason: &str,
    label: Option<&str>,
    author: Option<&str>,
) -> AppResult<VersionMeta> {
    if !matches!(reason, "auto" | "manual" | "restore") {
        return Err(AppError::Invalid("raison de version inconnue".into()));
    }
    let label = clean(label, 200)?;
    let author = clean(author, 320)?;
    let tx = crate::db::begin(conn)?;
    let page = tx
        .query_row(
            "SELECT doc_state, content_json, text_plain FROM page_content WHERE node_id = ?1",
            [node_id],
            |r| {
                Ok((
                    r.get::<_, Vec<u8>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("contenu de la page {node_id}")))?;
    if let Some((id, json, _)) = latest(&tx, node_id)? {
        if json == page.1 {
            if reason != "auto" {
                tx.execute(
                    "UPDATE page_version SET reason = CASE WHEN reason = 'auto' THEN ?2 ELSE reason END,
                       label = COALESCE(?3, label), author = COALESCE(author, ?4) WHERE id = ?1",
                    params![id, reason, label, author],
                )?;
            }
            let m = tx.query_row(
                &format!("SELECT {META_COLS} FROM page_version WHERE id = ?1"),
                [&id],
                map_meta,
            )?;
            tx.commit()?;
            return Ok(m);
        }
    }
    let n: i64 = tx.query_row(
        "SELECT count(*) FROM page_version WHERE node_id = ?1",
        [node_id],
        |r| r.get(0),
    )?;
    if n >= MAX_VERSIONS_PER_PAGE {
        return Err(AppError::Invalid("trop de versions pour cette page".into()));
    }
    let id = uuid::Uuid::now_v7().to_string();
    let ts = tree::now(&tx)?;
    let bytes = (page.0.len() + page.1.len() + page.2.len()) as i64;
    tx.execute(
        "INSERT INTO page_version (id, node_id, created_at, reason, label, author, doc_state, content_json, text_plain, bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, node_id, ts, reason, label, author, page.0, page.1, page.2, bytes],
    )?;
    prune_at(&tx, node_id, &ts)?;
    let m = tx.query_row(
        &format!("SELECT {META_COLS} FROM page_version WHERE id = ?1"),
        [&id],
        map_meta,
    )?;
    tx.commit()?;
    Ok(m)
}

/// Appelé par `content::save` dans la même transaction : crée une version automatique si c'est pertinent.
pub fn maybe_auto(conn: &Connection, node_id: &str, now: &str) -> AppResult<()> {
    let (json, text): (String, String) = conn.query_row(
        "SELECT content_json, text_plain FROM page_content WHERE node_id = ?1",
        [node_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    match latest(conn, node_id)? {
        None if text.trim().is_empty() => Ok(()), // page vide : rien à conserver
        None => snapshot(conn, node_id, "auto", None, None).map(|_| ()),
        Some((_, last_json, last_at)) => {
            let age: f64 = conn.query_row(
                "SELECT (julianday(?1) - julianday(?2)) * 86400.0",
                params![now, last_at],
                |r| r.get(0),
            )?;
            if age >= AUTO_INTERVAL_SECS && last_json != json {
                snapshot(conn, node_id, "auto", None, None).map(|_| ())
            } else {
                Ok(())
            }
        }
    }
}

/// Politique de conservation (voir l'en-tête du module). `now` est injectable pour les tests.
pub fn prune_at(conn: &Connection, node_id: &str, now: &str) -> AppResult<usize> {
    let mut st = conn.prepare(
        "SELECT id, (julianday(?2) - julianday(created_at)) * 86400.0, substr(created_at, 1, 10)
         FROM page_version WHERE node_id = ?1 AND reason = 'auto' ORDER BY created_at DESC, id DESC",
    )?;
    let rows: Vec<(String, f64, String)> = st
        .query_map(params![node_id, now], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut doomed = Vec::new();
    let mut days = std::collections::BTreeSet::new();
    let mut kept = 0usize;
    for (id, age, day) in rows {
        let keep = if age <= KEEP_ALL_SECS {
            true
        } else if age <= KEEP_DAILY_SECS {
            days.insert(day) // la plus récente de chaque jour (liste triée du plus récent au plus ancien)
        } else {
            false
        };
        if keep && kept < MAX_AUTO {
            kept += 1;
        } else {
            doomed.push(id);
        }
    }
    for id in &doomed {
        conn.execute("DELETE FROM page_version WHERE id = ?1", [id])?;
    }
    Ok(doomed.len())
}

pub fn list(conn: &Connection, node_id: &str) -> AppResult<Vec<VersionMeta>> {
    let mut st = conn.prepare(&format!(
        "SELECT {META_COLS} FROM page_version WHERE node_id = ?1 ORDER BY created_at DESC, id DESC"
    ))?;
    let v = st
        .query_map([node_id], map_meta)?
        .collect::<Result<_, _>>()?;
    Ok(v)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<VersionData> {
    conn.query_row(
        &format!("SELECT {META_COLS}, content_json FROM page_version WHERE id = ?1"),
        [id],
        |r| {
            let meta = map_meta(r)?;
            let text: String = r.get(8)?;
            Ok(VersionData {
                meta,
                content_json: r.get(9)?,
                text_plain: text,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("version {id}")))
}

pub fn rename(conn: &Connection, id: &str, label: Option<&str>) -> AppResult<()> {
    let label = clean(label, 200)?;
    let n = conn.execute(
        "UPDATE page_version SET label = ?2, reason = CASE WHEN reason = 'auto' AND ?2 IS NOT NULL THEN 'manual' ELSE reason END
         WHERE id = ?1",
        params![id, label],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("version {id}")));
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM page_version WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("version {id}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
