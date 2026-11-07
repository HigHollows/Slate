//! Commentaires ancrés à des sélections de texte : fils (`comment_thread`) et messages (`comment`).
//!
//! L'ancrage lui-même est une marque du document (voir l'éditeur) : il suit le texte quand le document évolue. Si le
//! texte ancré est entièrement supprimé, le fil devient « orphelin » : il reste lisible (avec la citation d'origine)
//! et peut être supprimé. Il n'y a pas encore de membres ni de rôles : tout utilisateur local peut tout faire ;
//! l'auteur est l'adresse du compte connecté, sinon aucun.

use crate::error::{AppError, AppResult};
use crate::tree;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const MAX_BODY: usize = 5_000;
const MAX_QUOTE: usize = 400;
const MAX_THREADS_PER_PAGE: i64 = 2_000;
const MAX_COMMENTS_PER_THREAD: i64 = 500;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommentOut {
    pub id: String,
    pub thread_id: String,
    pub body: String,
    pub author: Option<String>,
    pub created_at: String,
    pub edited_at: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOut {
    pub id: String,
    pub node_id: String,
    pub quote: String,
    pub created_at: String,
    pub created_by: Option<String>,
    pub resolved_at: Option<String>,
    pub resolved_by: Option<String>,
    pub comments: Vec<CommentOut>,
}

fn body(b: &str) -> AppResult<String> {
    let t = b.trim();
    if t.is_empty() || t.chars().count() > MAX_BODY {
        return Err(AppError::Invalid(
            "commentaire vide ou trop long (5 000 caractères maximum)".into(),
        ));
    }
    Ok(t.to_string())
}
fn author(a: Option<&str>) -> AppResult<Option<String>> {
    match a.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.chars().count() > 320 => Err(AppError::Invalid("auteur invalide".into())),
        Some(s) => Ok(Some(s.to_string())),
        None => Ok(None),
    }
}
fn live_page(conn: &Connection, node_id: &str) -> AppResult<()> {
    let n = tree::get(conn, node_id)?;
    if n.kind != "page" || n.deleted_at.is_some() {
        return Err(AppError::NotFound(format!("page {node_id}")));
    }
    Ok(())
}
fn comments_of(conn: &Connection, thread_id: &str) -> AppResult<Vec<CommentOut>> {
    let mut st = conn.prepare(
        "SELECT id, thread_id, body, author, created_at, edited_at FROM comment
         WHERE thread_id = ?1 ORDER BY created_at, id",
    )?;
    let v = st
        .query_map([thread_id], |r| {
            Ok(CommentOut {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                body: r.get(2)?,
                author: r.get(3)?,
                created_at: r.get(4)?,
                edited_at: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(v)
}
pub fn thread(conn: &Connection, id: &str) -> AppResult<ThreadOut> {
    let mut t = conn
        .query_row(
            "SELECT id, node_id, quote, created_at, created_by, resolved_at, resolved_by
             FROM comment_thread WHERE id = ?1",
            [id],
            |r| {
                Ok(ThreadOut {
                    id: r.get(0)?,
                    node_id: r.get(1)?,
                    quote: r.get(2)?,
                    created_at: r.get(3)?,
                    created_by: r.get(4)?,
                    resolved_at: r.get(5)?,
                    resolved_by: r.get(6)?,
                    comments: vec![],
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("fil de commentaires {id}")))?;
    t.comments = comments_of(conn, id)?;
    Ok(t)
}

pub fn list(conn: &Connection, node_id: &str) -> AppResult<Vec<ThreadOut>> {
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM comment_thread WHERE node_id = ?1 ORDER BY created_at, id")?
        .query_map([node_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    ids.iter().map(|id| thread(conn, id)).collect()
}

/// Crée un fil avec son premier message, en une transaction. `id` est choisi par l'appelant pour pouvoir poser la
/// marque d'ancrage dans le document avec le même identifiant.
pub fn create_thread(
    conn: &Connection,
    id: &str,
    node_id: &str,
    quote: &str,
    first: &str,
    by: Option<&str>,
) -> AppResult<ThreadOut> {
    if !is_thread_id(id) {
        return Err(AppError::Invalid("identifiant de fil invalide".into()));
    }
    let quote: String = quote.trim().chars().take(MAX_QUOTE).collect();
    let first = body(first)?;
    let by = author(by)?;
    let tx = crate::db::begin(conn)?;
    live_page(&tx, node_id)?;
    let n: i64 = tx.query_row(
        "SELECT count(*) FROM comment_thread WHERE node_id = ?1",
        [node_id],
        |r| r.get(0),
    )?;
    if n >= MAX_THREADS_PER_PAGE {
        return Err(AppError::Invalid(
            "trop de commentaires sur cette page".into(),
        ));
    }
    let ts = tree::now(&tx)?;
    tx.execute(
        "INSERT INTO comment_thread (id, node_id, quote, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, node_id, quote, ts, by],
    )
    .map_err(|_| AppError::Invalid("ce fil existe déjà".into()))?;
    tx.execute(
        "INSERT INTO comment (id, thread_id, body, author, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![uuid::Uuid::now_v7().to_string(), id, first, by, ts],
    )?;
    let t = thread(&tx, id)?;
    tx.commit()?;
    Ok(t)
}

/// Identifiant de fil : UUID en minuscules (c'est aussi la valeur de la marque d'ancrage dans le document).
pub fn is_thread_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => matches!(c, b'0'..=b'9' | b'a'..=b'f'),
        })
}

pub fn add_comment(
    conn: &Connection,
    thread_id: &str,
    text: &str,
    by: Option<&str>,
) -> AppResult<CommentOut> {
    let text = body(text)?;
    let by = author(by)?;
    let tx = crate::db::begin(conn)?;
    thread(&tx, thread_id)?;
    let n: i64 = tx.query_row(
        "SELECT count(*) FROM comment WHERE thread_id = ?1",
        [thread_id],
        |r| r.get(0),
    )?;
    if n >= MAX_COMMENTS_PER_THREAD {
        return Err(AppError::Invalid("trop de réponses dans ce fil".into()));
    }
    let id = uuid::Uuid::now_v7().to_string();
    let ts = tree::now(&tx)?;
    tx.execute(
        "INSERT INTO comment (id, thread_id, body, author, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, thread_id, text, by, ts],
    )?;
    let c = comments_of(&tx, thread_id)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::NotFound("commentaire".into()))?;
    tx.commit()?;
    Ok(c)
}

pub fn edit_comment(conn: &Connection, id: &str, text: &str) -> AppResult<CommentOut> {
    let text = body(text)?;
    let ts = tree::now(conn)?;
    let n = conn.execute(
        "UPDATE comment SET body = ?2, edited_at = ?3 WHERE id = ?1",
        params![id, text, ts],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("commentaire {id}")));
    }
    let tid: String = conn.query_row("SELECT thread_id FROM comment WHERE id = ?1", [id], |r| {
        r.get(0)
    })?;
    comments_of(conn, &tid)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::NotFound(format!("commentaire {id}")))
}

/// Supprime un message. Si c'était le dernier du fil, le fil est supprimé aussi ; retourne alors `true`.
pub fn delete_comment(conn: &Connection, id: &str) -> AppResult<bool> {
    let tx = crate::db::begin(conn)?;
    let tid: String = tx
        .query_row("SELECT thread_id FROM comment WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("commentaire {id}")))?;
    tx.execute("DELETE FROM comment WHERE id = ?1", [id])?;
    let left: i64 = tx.query_row(
        "SELECT count(*) FROM comment WHERE thread_id = ?1",
        [&tid],
        |r| r.get(0),
    )?;
    let gone = left == 0;
    if gone {
        tx.execute("DELETE FROM comment_thread WHERE id = ?1", [&tid])?;
    }
    tx.commit()?;
    Ok(gone)
}

pub fn resolve(
    conn: &Connection,
    thread_id: &str,
    resolved: bool,
    by: Option<&str>,
) -> AppResult<ThreadOut> {
    let by = author(by)?;
    let ts = tree::now(conn)?;
    let n = if resolved {
        conn.execute(
            "UPDATE comment_thread SET resolved_at = ?2, resolved_by = ?3 WHERE id = ?1",
            params![thread_id, ts, by],
        )?
    } else {
        conn.execute(
            "UPDATE comment_thread SET resolved_at = NULL, resolved_by = NULL WHERE id = ?1",
            [thread_id],
        )?
    };
    if n == 0 {
        return Err(AppError::NotFound(format!(
            "fil de commentaires {thread_id}"
        )));
    }
    thread(conn, thread_id)
}

pub fn delete_thread(conn: &Connection, thread_id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM comment_thread WHERE id = ?1", [thread_id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!(
            "fil de commentaires {thread_id}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
