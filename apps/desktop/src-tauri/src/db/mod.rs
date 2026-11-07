//! Accès SQLite. Seul le cœur Rust touche à la base (le WebView n'a aucun accès SQL).

pub mod migrations;

use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{AppError, AppResult};
use migrations::{Migration, MIGRATIONS};
use rusqlite::{Connection, OptionalExtension};
use std::path::{Path, PathBuf};

pub const DB_FILE: &str = "slate.sqlite";

fn configure(conn: &Connection) -> AppResult<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    // `journal_mode` renvoie une ligne : on la lit pour valider l'activation de WAL.
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") && !mode.eq_ignore_ascii_case("memory") {
        return Err(AppError::DbOpen(format!(
            "mode WAL indisponible (obtenu : {mode})"
        )));
    }
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")?;
    Ok(())
}

/// Copie cohérente de la base (`VACUUM INTO`) avant une migration.
fn backup_before_migration(conn: &Connection, dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let target: PathBuf = dir.join(format!("pre-migration-{stamp}.sqlite"));
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    tracing::info!(path = %target.display(), "sauvegarde pré-migration créée");
    Ok(())
}

pub fn open(dir: &Path) -> AppResult<Connection> {
    open_with(dir, MIGRATIONS)
}

pub fn open_with(dir: &Path, migrations: &[Migration]) -> AppResult<Connection> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(DB_FILE);
    let mut conn = Connection::open(&path)
        .map_err(|e| AppError::DbOpen(format!("{}: {e}", path.display())))?;
    configure(&conn)?;
    let backups = dir.join("backups");
    migrations::run(&mut conn, migrations, |c| {
        backup_before_migration(c, &backups)
    })?;
    Ok(conn)
}

pub fn schema_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        [],
        |r| r.get(0),
    )?)
}

/// Identifiant stable de l'appareil (UUID v7), créé au premier lancement.
pub fn ensure_device_id(conn: &Connection) -> AppResult<String> {
    if let Some(id) = conn
        .query_row("SELECT id FROM device LIMIT 1", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
    {
        return Ok(id);
    }
    let id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO device (id, created_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        [&id],
    )?;
    Ok(id)
}

pub fn integrity_ok(conn: &Connection) -> AppResult<bool> {
    let res: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(res == "ok")
}

static SAVEPOINT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Transaction imbriquable : `SAVEPOINT` (ouvre une transaction si aucune n'est active).
/// Abandonnée sans `commit`, elle annule tout ce qu'elle a écrit (y compris au sein d'une transaction englobante).
pub struct Tx<'a> {
    conn: &'a Connection,
    name: String,
    done: bool,
}

pub fn begin(conn: &Connection) -> AppResult<Tx<'_>> {
    let name = format!("slate_sp_{}", SAVEPOINT_SEQ.fetch_add(1, Ordering::Relaxed));
    conn.execute_batch(&format!("SAVEPOINT {name}"))?;
    Ok(Tx {
        conn,
        name,
        done: false,
    })
}

impl Tx<'_> {
    pub fn commit(mut self) -> AppResult<()> {
        self.conn.execute_batch(&format!("RELEASE {}", self.name))?;
        self.done = true;
        Ok(())
    }
}

impl std::ops::Deref for Tx<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn
    }
}

impl Drop for Tx<'_> {
    fn drop(&mut self) {
        if !self.done {
            let _ = self
                .conn
                .execute_batch(&format!("ROLLBACK TO {0}; RELEASE {0}", self.name));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ouverture_cree_la_base_active_wal_et_cles_etrangeres() {
        let dir = tempdir().unwrap();
        let conn = open(dir.path()).unwrap();
        assert!(dir.path().join(DB_FILE).exists());
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
        assert_eq!(
            schema_version(&conn).unwrap(),
            migrations::latest_version(MIGRATIONS)
        );
        assert!(integrity_ok(&conn).unwrap());
    }

    #[test]
    fn l_identifiant_d_appareil_est_stable_entre_deux_lancements() {
        let dir = tempdir().unwrap();
        let a = ensure_device_id(&open(dir.path()).unwrap()).unwrap();
        let b = ensure_device_id(&open(dir.path()).unwrap()).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 36);
    }

    #[test]
    fn mise_a_niveau_cree_une_sauvegarde_exploitable() {
        let dir = tempdir().unwrap();
        let v1 = [Migration {
            version: 1,
            name: "a",
            sql: "CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);",
        }];
        {
            let c = open_with(dir.path(), &v1).unwrap();
            c.execute("INSERT INTO a (v) VALUES ('précieux')", [])
                .unwrap();
        }
        let v2 = [
            Migration {
                version: 1,
                name: "a",
                sql: v1[0].sql,
            },
            Migration {
                version: 2,
                name: "b",
                sql: "ALTER TABLE a ADD COLUMN w TEXT;",
            },
        ];
        let c = open_with(dir.path(), &v2).unwrap();
        assert_eq!(schema_version(&c).unwrap(), 2);

        let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups"))
            .unwrap()
            .collect();
        assert_eq!(backups.len(), 1);
        let b = Connection::open(backups[0].as_ref().unwrap().path()).unwrap();
        let v: String = b.query_row("SELECT v FROM a", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "précieux");
        assert_eq!(
            schema_version(&b).unwrap(),
            1,
            "la sauvegarde est l'état d'avant migration"
        );
    }

    #[test]
    fn base_plus_recente_refusee_au_demarrage_sans_toucher_aux_donnees() {
        let dir = tempdir().unwrap();
        let v2 = [
            Migration {
                version: 1,
                name: "a",
                sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);",
            },
            Migration {
                version: 2,
                name: "b",
                sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);",
            },
        ];
        drop(open_with(dir.path(), &v2).unwrap());
        let r = open_with(dir.path(), &v2[..1]);
        assert!(matches!(
            r,
            Err(AppError::DbNewerThanApp {
                found: 2,
                supported: 1
            })
        ));
    }
}
