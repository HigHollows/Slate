//! Recherche plein texte locale (FTS5) : pages et dossiers, hors ligne, sans IA.
//! L'index est maintenu dans la même transaction que les écritures qui le concernent.

use crate::error::AppResult;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const HIT_START: char = '\u{2}';
pub const HIT_END: char = '\u{3}';

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub node_id: String,
    pub kind: String,
    pub title: String,
    /// Extrait ; les correspondances sont encadrées par U+0002 / U+0003 (jamais du HTML).
    pub snippet: String,
    pub updated_at: String,
}

/// (Ré)écrit la ligne d'index d'un nœud vivant à partir de son titre et du texte stocké.
pub fn reindex(conn: &Connection, node_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM search_index WHERE node_id = ?1", [node_id])?;
    // Corps indexé = texte de la page + valeurs textuelles des propriétés (si le nœud est une ligne de base de données).
    let row: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT n.title, c.text_plain,
                    (SELECT group_concat(CAST(j.value AS TEXT), ' ')
                       FROM db_row r, json_each(r.props_json) j
                       JOIN db_property p ON p.id = j.key AND p.deleted_at IS NULL
                                         AND p.type IN ('text', 'longtext', 'url', 'email', 'phone')
                      WHERE r.node_id = n.id AND j.type = 'text')
             FROM node n LEFT JOIN page_content c ON c.node_id = n.id
             WHERE n.id = ?1 AND n.deleted_at IS NULL",
            [node_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((title, body, props)) = row {
        let body = format!("{} {}", body.unwrap_or_default(), props.unwrap_or_default());
        conn.execute(
            "INSERT INTO search_index (node_id, title, body) VALUES (?1, ?2, ?3)",
            params![node_id, title, body.trim()],
        )?;
    }
    Ok(())
}

/// Transforme une saisie libre en requête FTS5 sûre : mots alphanumériques, chacun en préfixe, ET implicite.
pub fn build_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .take(8)
        .map(|t| format!("\"{}\"*", t.chars().take(64).collect::<String>()))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

pub fn search(
    conn: &Connection,
    workspace_id: &str,
    input: &str,
    limit: usize,
) -> AppResult<Vec<SearchHit>> {
    let Some(q) = build_query(input) else {
        return Ok(vec![]);
    };
    let mut st = conn.prepare(
        "SELECT n.id, n.kind, n.title, n.updated_at,
                snippet(search_index, -1, ?4, ?5, '…', 12)
         FROM search_index JOIN node n ON n.id = search_index.node_id
         WHERE search_index MATCH ?1 AND n.workspace_id = ?2 AND n.deleted_at IS NULL
         ORDER BY bm25(search_index, 0.0, 5.0, 1.0) LIMIT ?3",
    )?;
    let rows = st.query_map(
        params![
            q,
            workspace_id,
            limit.min(100) as i64,
            HIT_START.to_string(),
            HIT_END.to_string()
        ],
        |r| {
            Ok(SearchHit {
                node_id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                updated_at: r.get(3)?,
                snippet: r.get(4)?,
            })
        },
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content;
    use crate::db;
    use crate::tree::{self, soft_delete};
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, Connection, String) {
        let d = tempdir().unwrap();
        let c = db::open(d.path()).unwrap();
        let ws = tree::ensure_default_workspace(&c, "P").unwrap();
        (d, c, ws)
    }
    fn save(c: &Connection, id: &str, text: &str) {
        content::save(c, id, b"x", "{\"type\":\"doc\"}", text, &[]).unwrap();
    }

    #[test]
    fn requete_sure() {
        assert_eq!(build_query("  "), None);
        assert_eq!(build_query("é\"*()-"), Some("\"é\"*".into()));
        assert_eq!(build_query("foo bar").unwrap(), "\"foo\"* \"bar\"*");
        // Les opérateurs FTS (NEAR, OR…) deviennent de simples mots entre guillemets : jamais interprétés.
        assert!(build_query("NEAR(a b) OR x").unwrap().contains("\"OR\"*"));
        assert_eq!(
            build_query(&"a ".repeat(30)).unwrap().matches('*').count(),
            8
        );
    }

    #[test]
    fn insensible_aux_accents_et_a_la_casse_avec_prefixe() {
        let (_d, c, ws) = setup();
        let p = tree::create_node(&c, &ws, None, "page", "Réunion équipe", None).unwrap();
        save(&c, &p.id, "Préparer le budget prévisionnel");
        for q in ["reunion", "REUNION", "equip", "previsionnel", "budget prev"] {
            let hits = search(&c, &ws, q, 10).unwrap();
            assert_eq!(hits.len(), 1, "requête {q:?}");
        }
        assert!(search(&c, &ws, "inexistant", 10).unwrap().is_empty());
    }

    #[test]
    fn extrait_avec_marqueurs_de_correspondance() {
        let (_d, c, ws) = setup();
        let p = tree::create_node(&c, &ws, None, "page", "Notes", None).unwrap();
        save(
            &c,
            &p.id,
            "Un long texte où apparaît le mot précieux au milieu de la phrase",
        );
        let h = &search(&c, &ws, "precieux", 10).unwrap()[0];
        assert!(
            h.snippet.contains(&format!("{HIT_START}précieux{HIT_END}")),
            "{}",
            h.snippet
        );
    }

    #[test]
    fn titre_prioritaire_sur_corps() {
        let (_d, c, ws) = setup();
        let a = tree::create_node(&c, &ws, None, "page", "Autre", None).unwrap();
        save(&c, &a.id, "contient projet dans le corps");
        let b = tree::create_node(&c, &ws, None, "page", "Projet", None).unwrap();
        assert_eq!(search(&c, &ws, "projet", 10).unwrap()[0].node_id, b.id);
    }

    #[test]
    fn renommer_et_supprimer_met_l_index_a_jour() {
        let (_d, c, ws) = setup();
        let p = tree::create_node(&c, &ws, None, "page", "Ancien", None).unwrap();
        save(&c, &p.id, "contenu");
        tree::rename_node(&c, &p.id, "Nouveau").unwrap();
        assert!(search(&c, &ws, "ancien", 10).unwrap().is_empty());
        assert_eq!(search(&c, &ws, "nouveau", 10).unwrap().len(), 1);
        assert_eq!(
            search(&c, &ws, "contenu", 10).unwrap().len(),
            1,
            "le corps est conservé au renommage"
        );
        soft_delete(&c, &p.id).unwrap();
        assert!(search(&c, &ws, "nouveau", 10).unwrap().is_empty());
        tree::restore(&c, &p.id).unwrap();
        assert_eq!(
            search(&c, &ws, "contenu", 10).unwrap().len(),
            1,
            "réindexé à la restauration"
        );
    }

    #[test]
    fn isolation_par_espace() {
        let (_d, c, ws) = setup();
        c.execute("INSERT INTO workspace (id, name, created_at, updated_at) VALUES ('w2','Autre','t','t')", []).unwrap();
        let p = tree::create_node(&c, &ws, None, "page", "Secret", None).unwrap();
        assert_eq!(search(&c, &ws, "secret", 10).unwrap().len(), 1);
        assert!(search(&c, "w2", "secret", 10).unwrap().is_empty());
        let _ = p;
    }

    #[test]
    fn injection_fts_inoperante() {
        let (_d, c, ws) = setup();
        tree::create_node(&c, &ws, None, "page", "Test", None).unwrap();
        for q in ["\" OR 1=1 --", "test*)(", "NOT", "title:test", "a AND"] {
            assert!(search(&c, &ws, q, 10).is_ok(), "{q}");
        }
    }
}
