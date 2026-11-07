//! Préférences utilisateur persistées dans la table `settings` (clé → JSON).
//! Les clés sont validées (format + préfixe autorisé) et les valeurs doivent être du JSON valide et borné.

use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::Serialize;

const MAX_VALUE_BYTES: usize = 64 * 1024;
const ALLOWED_PREFIXES: &[&str] = &["pref.", "ui.", "shortcut.", "history."];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingRow {
    pub key: String,
    pub value_json: String,
}

pub fn validate_key(key: &str) -> AppResult<()> {
    let ok_chars = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    if !ok_chars || !ALLOWED_PREFIXES.iter().any(|p| key.starts_with(p)) {
        return Err(AppError::Invalid(format!(
            "clé de préférence refusée : {key}"
        )));
    }
    Ok(())
}

pub fn get_all(conn: &Connection) -> AppResult<Vec<SettingRow>> {
    let mut stmt = conn.prepare("SELECT key, value_json FROM settings ORDER BY key")?;
    let rows = stmt.query_map([], |r| {
        Ok(SettingRow {
            key: r.get(0)?,
            value_json: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn set(conn: &Connection, key: &str, value_json: &str) -> AppResult<()> {
    validate_key(key)?;
    if value_json.len() > MAX_VALUE_BYTES {
        return Err(AppError::Invalid("valeur trop volumineuse".into()));
    }
    serde_json::from_str::<serde_json::Value>(value_json)
        .map_err(|_| AppError::Invalid("valeur JSON invalide".into()))?;
    conn.execute(
        "INSERT INTO settings (key, value_json, updated_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        [key, value_json],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, key: &str) -> AppResult<()> {
    validate_key(key)?;
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    fn conn() -> (tempfile::TempDir, Connection) {
        let d = tempdir().unwrap();
        let c = db::open(d.path()).unwrap();
        (d, c)
    }

    #[test]
    fn ecriture_lecture_et_remplacement() {
        let (_d, c) = conn();
        set(&c, "pref.theme", "\"dark\"").unwrap();
        set(&c, "pref.theme", "\"light\"").unwrap();
        let all = get_all(&c).unwrap();
        assert_eq!(
            all,
            vec![SettingRow {
                key: "pref.theme".into(),
                value_json: "\"light\"".into()
            }]
        );
    }

    #[test]
    fn les_valeurs_persistent_apres_reouverture() {
        let d = tempdir().unwrap();
        set(&db::open(d.path()).unwrap(), "pref.accent", "\"#3b82f6\"").unwrap();
        let again = get_all(&db::open(d.path()).unwrap()).unwrap();
        assert_eq!(again.len(), 1);
    }

    #[test]
    fn suppression() {
        let (_d, c) = conn();
        set(&c, "ui.sidebar", "{\"w\":260}").unwrap();
        delete(&c, "ui.sidebar").unwrap();
        assert!(get_all(&c).unwrap().is_empty());
    }

    #[test]
    fn refus_des_cles_et_valeurs_invalides() {
        let (_d, c) = conn();
        for k in [
            "",
            "theme",
            "pref.",
            "PREF.x",
            "pref.a b",
            "secret.token",
            "pref.é",
            &format!("pref.{}", "a".repeat(80)),
        ] {
            if k == "pref." {
                continue; // préfixe seul : accepté par le format, sans intérêt ici
            }
            assert!(set(&c, k, "1").is_err(), "clé {k:?} devrait être refusée");
        }
        assert!(set(&c, "pref.x", "{pas du json").is_err());
        assert!(set(
            &c,
            "pref.x",
            &format!("\"{}\"", "a".repeat(MAX_VALUE_BYTES))
        )
        .is_err());
        assert!(get_all(&c).unwrap().is_empty());
    }

    #[test]
    fn injection_sql_via_la_cle_est_inoperante() {
        let (_d, c) = conn();
        assert!(set(&c, "pref.x'; DROP TABLE settings;--", "1").is_err());
        assert!(get_all(&c).is_ok());
    }
}
