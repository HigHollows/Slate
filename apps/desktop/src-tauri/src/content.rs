//! Contenu des pages : état Yjs + instantané JSON + texte brut + liens, enregistrés en UNE transaction.
//! Règle de fiabilité : soit tout est écrit (contenu, index de recherche, liens), soit rien ne change.

use crate::error::{AppError, AppResult};
use crate::{search, tree};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const MAX_STATE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_LINKS: usize = 5_000;
pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedPage {
    pub updated_at: String,
    pub version: i64,
}

// `content_json` : instantané dérivé, lu par les tests ; réservé à l'export et à la restauration (Phases 9-10).
#[cfg_attr(not(test), allow(dead_code))]
pub struct PageContent {
    pub doc_state: Vec<u8>,
    pub content_json: String,
    pub updated_at: String,
}

#[cfg(test)]
thread_local! {
    /// Injection de panne (tests) : échoue après l'écriture du contenu, avant la fin de la transaction.
    pub static FAIL_AFTER_CONTENT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn get(conn: &Connection, node_id: &str) -> AppResult<Option<PageContent>> {
    let node = tree::get(conn, node_id)?;
    if node.kind != "page" || node.deleted_at.is_some() {
        return Err(AppError::NotFound(format!("page {node_id}")));
    }
    Ok(conn
        .query_row(
            "SELECT doc_state, content_json, updated_at FROM page_content WHERE node_id = ?1",
            [node_id],
            |r| {
                Ok(PageContent {
                    doc_state: r.get(0)?,
                    content_json: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            },
        )
        .optional()?)
}

pub fn save(
    conn: &Connection,
    node_id: &str,
    doc_state: &[u8],
    content_json: &str,
    text_plain: &str,
    link_targets: &[String],
) -> AppResult<SavedPage> {
    if doc_state.is_empty()
        || doc_state.len() > MAX_STATE_BYTES
        || content_json.len() > MAX_STATE_BYTES
    {
        return Err(AppError::Invalid("contenu vide ou trop volumineux".into()));
    }
    if text_plain.len() > MAX_TEXT_BYTES || link_targets.len() > MAX_LINKS {
        return Err(AppError::Invalid("texte ou liens trop volumineux".into()));
    }
    serde_json::from_str::<serde_json::Value>(content_json)
        .map_err(|_| AppError::Invalid("instantané JSON invalide".into()))?;

    let tx = crate::db::begin(conn)?;
    let node = tree::get(&tx, node_id)?;
    if node.kind != "page" || node.deleted_at.is_some() {
        return Err(AppError::NotFound(format!("page {node_id}")));
    }
    let ts = tree::now(&tx)?;
    tx.execute(
        "INSERT INTO page_content (node_id, doc_state, content_json, text_plain, schema_version, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(node_id) DO UPDATE SET doc_state = excluded.doc_state, content_json = excluded.content_json,
           text_plain = excluded.text_plain, schema_version = excluded.schema_version, updated_at = excluded.updated_at",
        params![node_id, doc_state, content_json, text_plain, SCHEMA_VERSION, ts],
    )?;
    #[cfg(test)]
    if FAIL_AFTER_CONTENT.with(|f| f.get()) {
        return Err(AppError::Db("panne simulée".into()));
    }
    tx.execute(
        "UPDATE node SET updated_at = ?2, version = version + 1 WHERE id = ?1",
        params![node_id, ts],
    )?;
    // Liens : uniquement vers des pages existantes et vivantes, sans auto-référence, dédoublonnés.
    tx.execute(
        "DELETE FROM link WHERE source_id = ?1 AND kind = 'mention'",
        [node_id],
    )?;
    for target in link_targets
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
    {
        if target == node_id {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO link (source_id, target_id, kind)
             SELECT ?1, id, 'mention' FROM node WHERE id = ?2 AND kind = 'page' AND deleted_at IS NULL",
            params![node_id, target],
        )?;
    }
    search::reindex(&tx, node_id)?;
    crate::versions::maybe_auto(&tx, node_id, &ts)?;
    let version: i64 = tx.query_row("SELECT version FROM node WHERE id = ?1", [node_id], |r| {
        r.get(0)
    })?;
    tx.commit()?;
    Ok(SavedPage {
        updated_at: ts,
        version,
    })
}

pub fn backlinks(conn: &Connection, node_id: &str) -> AppResult<Vec<tree::NodeRow>> {
    let mut st = conn.prepare(
        "SELECT n.id, n.workspace_id, n.parent_id, n.kind, n.title, n.position, n.is_favorite, n.updated_at, n.deleted_at
         FROM link l JOIN node n ON n.id = l.source_id
         WHERE l.target_id = ?1 AND n.deleted_at IS NULL ORDER BY n.title, n.id",
    )?;
    let rows = st.query_map([node_id], |r| {
        Ok(tree::NodeRow {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            parent_id: r.get(2)?,
            kind: r.get(3)?,
            title: r.get(4)?,
            position: r.get(5)?,
            is_favorite: r.get::<_, i64>(6)? == 1,
            updated_at: r.get(7)?,
            deleted_at: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, Connection, String) {
        let d = tempdir().unwrap();
        let c = db::open(d.path()).unwrap();
        let ws = tree::ensure_default_workspace(&c, "P").unwrap();
        (d, c, ws)
    }
    const DOC: &str = "{\"type\":\"doc\",\"content\":[]}";

    #[test]
    fn page_neuve_sans_contenu_puis_aller_retour_binaire() {
        let (_d, c, ws) = setup();
        let p = tree::create_node(&c, &ws, None, "page", "P", None).unwrap();
        assert!(get(&c, &p.id).unwrap().is_none());
        let state: Vec<u8> = (0..=255u8).collect();
        let saved = save(&c, &p.id, &state, DOC, "texte", &[]).unwrap();
        assert!(saved.version >= 2);
        let got = get(&c, &p.id).unwrap().unwrap();
        assert_eq!(
            got.doc_state, state,
            "les octets Yjs doivent revenir à l'identique"
        );
        assert_eq!(got.content_json, DOC);
    }

    #[test]
    fn les_dossiers_et_pages_supprimees_n_ont_pas_de_contenu() {
        let (_d, c, ws) = setup();
        let f = tree::create_node(&c, &ws, None, "folder", "F", None).unwrap();
        assert!(save(&c, &f.id, b"x", DOC, "", &[]).is_err());
        let p = tree::create_node(&c, &ws, None, "page", "P", None).unwrap();
        tree::soft_delete(&c, &p.id).unwrap();
        assert!(save(&c, &p.id, b"x", DOC, "", &[]).is_err());
        assert!(matches!(get(&c, "inconnu"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn validations() {
        let (_d, c, ws) = setup();
        let p = tree::create_node(&c, &ws, None, "page", "P", None).unwrap();
        assert!(save(&c, &p.id, b"", DOC, "", &[]).is_err());
        assert!(save(&c, &p.id, b"x", "{pas json", "", &[]).is_err());
        assert!(save(&c, &p.id, &vec![0u8; MAX_STATE_BYTES + 1], DOC, "", &[]).is_err());
        assert!(
            get(&c, &p.id).unwrap().is_none(),
            "aucune écriture partielle"
        );
    }

    /// Fiabilité : une panne en cours d'enregistrement n'altère NI le contenu précédent NI l'index NI les liens.
    #[test]
    fn panne_en_cours_de_sauvegarde_ne_laisse_aucune_ecriture_partielle() {
        let (_d, c, ws) = setup();
        let p = tree::create_node(&c, &ws, None, "page", "P", None).unwrap();
        let t = tree::create_node(&c, &ws, None, "page", "Cible", None).unwrap();
        save(
            &c,
            &p.id,
            b"v1",
            DOC,
            "ancien texte",
            std::slice::from_ref(&t.id),
        )
        .unwrap();

        FAIL_AFTER_CONTENT.with(|f| f.set(true));
        let r = save(&c, &p.id, b"v2", DOC, "nouveau texte", &[]);
        FAIL_AFTER_CONTENT.with(|f| f.set(false));
        assert!(r.is_err());

        assert_eq!(get(&c, &p.id).unwrap().unwrap().doc_state, b"v1");
        assert_eq!(search::search(&c, &ws, "ancien", 5).unwrap().len(), 1);
        assert!(search::search(&c, &ws, "nouveau", 5).unwrap().is_empty());
        assert_eq!(backlinks(&c, &t.id).unwrap().len(), 1);
        // et la connexion reste utilisable (transaction annulée, pas bloquée)
        save(&c, &p.id, b"v3", DOC, "autre", &[]).unwrap();
    }

    #[test]
    fn la_base_rouverte_contient_le_dernier_contenu_valide() {
        let d = tempdir().unwrap();
        let (id, ws);
        {
            let c = db::open(d.path()).unwrap();
            ws = tree::ensure_default_workspace(&c, "P").unwrap();
            id = tree::create_node(&c, &ws, None, "page", "P", None)
                .unwrap()
                .id;
            save(&c, &id, b"durable", DOC, "ok", &[]).unwrap();
            // fermeture brutale simulée : la connexion est abandonnée sans fermeture ordonnée
            std::mem::forget(c);
        }
        let c2 = db::open(d.path()).unwrap();
        assert_eq!(get(&c2, &id).unwrap().unwrap().doc_state, b"durable");
        assert!(db::integrity_ok(&c2).unwrap());
    }

    #[test]
    fn backlinks_filtrent_cibles_inexistantes_autoreference_et_doublons() {
        let (_d, c, ws) = setup();
        let a = tree::create_node(&c, &ws, None, "page", "A", None).unwrap();
        let b = tree::create_node(&c, &ws, None, "page", "B", None).unwrap();
        let f = tree::create_node(&c, &ws, None, "folder", "F", None).unwrap();
        save(
            &c,
            &a.id,
            b"x",
            DOC,
            "",
            &[
                b.id.clone(),
                b.id.clone(),
                a.id.clone(),
                f.id.clone(),
                "nimporte".into(),
            ],
        )
        .unwrap();
        let bl = backlinks(&c, &b.id).unwrap();
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].id, a.id);
        assert!(backlinks(&c, &a.id).unwrap().is_empty());
        assert!(backlinks(&c, &f.id).unwrap().is_empty());
        let n: i64 = c
            .query_row("SELECT count(*) FROM link", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn retirer_un_lien_met_a_jour_les_backlinks_et_la_suppression_les_masque() {
        let (_d, c, ws) = setup();
        let a = tree::create_node(&c, &ws, None, "page", "A", None).unwrap();
        let b = tree::create_node(&c, &ws, None, "page", "B", None).unwrap();
        save(&c, &a.id, b"x", DOC, "", std::slice::from_ref(&b.id)).unwrap();
        tree::soft_delete(&c, &a.id).unwrap();
        assert!(
            backlinks(&c, &b.id).unwrap().is_empty(),
            "source dans la corbeille"
        );
        tree::restore(&c, &a.id).unwrap();
        assert_eq!(backlinks(&c, &b.id).unwrap().len(), 1);
        save(&c, &a.id, b"y", DOC, "", &[]).unwrap();
        assert!(backlinks(&c, &b.id).unwrap().is_empty());
    }
}
