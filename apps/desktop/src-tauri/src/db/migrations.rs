//! Migrations SQLite versionnées.
//!
//! Garanties :
//! * chaque migration s'exécute dans sa propre transaction (tout ou rien) ;
//! * checksum SHA-256 enregistré ; une migration déjà appliquée puis modifiée => refus ;
//! * base plus récente que l'application => refus (jamais de « rétrogradation » silencieuse) ;
//! * un rappel de sauvegarde est invoqué avant toute migration sur une base existante.

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "init",
        sql: include_str!("../../migrations/0001_init.sql"),
    },
    Migration {
        version: 2,
        name: "pages",
        sql: include_str!("../../migrations/0002_pages.sql"),
    },
    Migration {
        version: 3,
        name: "databases",
        sql: include_str!("../../migrations/0003_databases.sql"),
    },
    Migration {
        version: 4,
        name: "calendar_view",
        sql: include_str!("../../migrations/0004_calendar_view.sql"),
    },
    Migration {
        version: 5,
        name: "pin",
        sql: include_str!("../../migrations/0005_pin.sql"),
    },
    Migration {
        version: 6,
        name: "reminders",
        sql: include_str!("../../migrations/0006_reminders.sql"),
    },
    Migration {
        version: 7,
        name: "habits",
        sql: include_str!("../../migrations/0007_habits.sql"),
    },
    Migration {
        version: 8,
        name: "page_versions",
        sql: include_str!("../../migrations/0008_page_versions.sql"),
    },
    Migration {
        version: 9,
        name: "comments",
        sql: include_str!("../../migrations/0009_comments.sql"),
    },
    Migration {
        version: 10,
        name: "sync",
        sql: include_str!("../../migrations/0010_sync.sql"),
    },
    Migration {
        version: 11,
        name: "sync_databases",
        sql: include_str!("../../migrations/0011_sync_databases.sql"),
    },
    Migration {
        version: 12,
        name: "sync_workspaces",
        sql: include_str!("../../migrations/0012_sync_workspaces.sql"),
    },
    Migration {
        version: 13,
        name: "sync_purge",
        sql: include_str!("../../migrations/0013_sync_purge.sql"),
    },
    Migration {
        version: 14,
        name: "sync_comments",
        sql: include_str!("../../migrations/0014_sync_comments.sql"),
    },
];

/// Une migration qui reconstruit une table référencée doit s'exécuter clés étrangères désactivées
/// (impossible dans une transaction). Elle l'indique par cet en-tête ; le moteur vérifie ensuite `foreign_key_check`.
const FK_OFF_MARKER: &str = "-- slate:foreign_keys=off";

pub fn checksum(sql: &str) -> String {
    format!("{:x}", Sha256::digest(sql.as_bytes()))
}

pub fn latest_version(migrations: &[Migration]) -> i64 {
    migrations.iter().map(|m| m.version).max().unwrap_or(0)
}

/// Applique les migrations en attente. Retourne la version du schéma après exécution.
/// `backup` n'est appelé que si la base contient déjà des migrations et qu'il en reste à appliquer.
pub fn run(
    conn: &mut Connection,
    migrations: &[Migration],
    backup: impl FnOnce(&Connection) -> AppResult<()>,
) -> AppResult<i64> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
           version    INTEGER PRIMARY KEY NOT NULL,
           name       TEXT NOT NULL,
           checksum   TEXT NOT NULL,
           applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ) STRICT;",
    )?;

    let applied: HashMap<i64, String> = {
        let mut stmt = conn.prepare("SELECT version, checksum FROM _migrations")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };

    let supported = latest_version(migrations);
    let max_applied = applied.keys().copied().max().unwrap_or(0);
    if max_applied > supported {
        return Err(AppError::DbNewerThanApp {
            found: max_applied,
            supported,
        });
    }
    for m in migrations {
        if let Some(stored) = applied.get(&m.version) {
            if *stored != checksum(m.sql) {
                return Err(AppError::MigrationChecksum { version: m.version });
            }
        }
    }
    // Une version appliquée mais inconnue de ce binaire (trou) est une anomalie : on refuse.
    for v in applied.keys() {
        if !migrations.iter().any(|m| m.version == *v) {
            return Err(AppError::DbNewerThanApp {
                found: *v,
                supported,
            });
        }
    }

    let mut pending: Vec<&Migration> = migrations
        .iter()
        .filter(|m| !applied.contains_key(&m.version))
        .collect();
    pending.sort_by_key(|m| m.version);
    if pending.is_empty() {
        return Ok(max_applied);
    }
    if !applied.is_empty() {
        backup(conn)?;
    }

    for m in pending {
        let fk_off = m.sql.trim_start().starts_with(FK_OFF_MARKER);
        if fk_off {
            conn.execute_batch("PRAGMA foreign_keys = OFF")?;
        }
        let outcome = apply_one(conn, m, fk_off);
        if fk_off {
            // Toujours réactiver, y compris après un échec.
            conn.execute_batch("PRAGMA foreign_keys = ON")?;
        }
        outcome?;
        tracing::info!(version = m.version, name = m.name, "migration appliquée");
    }
    Ok(latest_version(migrations))
}

fn apply_one(conn: &mut Connection, m: &Migration, check_fk: bool) -> AppResult<()> {
    let tx = conn.transaction()?;
    let result = tx.execute_batch(m.sql).and_then(|_| {
        tx.execute(
            "INSERT INTO _migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
            params![m.version, m.name, checksum(m.sql)],
        )
        .map(|_| ())
    });
    if let Err(e) = result {
        // `tx` est abandonnée => ROLLBACK automatique.
        return Err(AppError::Migration {
            version: m.version,
            reason: e.to_string(),
        });
    }
    if check_fk {
        let violations: i64 = tx
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .map_err(|e| AppError::Migration {
                version: m.version,
                reason: e.to_string(),
            })?;
        if violations > 0 {
            return Err(AppError::Migration {
                version: m.version,
                reason: format!("{violations} violation(s) de clé étrangère après migration"),
            });
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const M1: Migration = Migration {
        version: 1,
        name: "a",
        sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);",
    };
    const M2: Migration = Migration {
        version: 2,
        name: "b",
        sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);",
    };

    fn mem() -> Connection {
        Connection::open_in_memory().unwrap()
    }
    fn no_backup(_: &Connection) -> AppResult<()> {
        Ok(())
    }
    fn table_exists(c: &Connection, n: &str) -> bool {
        c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name=?1",
            [n],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            == 1
    }

    #[test]
    fn migrations_reelles_s_appliquent_sur_base_vide() {
        let mut c = mem();
        let v = run(&mut c, MIGRATIONS, no_backup).unwrap();
        assert_eq!(v, latest_version(MIGRATIONS));
        assert!(table_exists(&c, "device") && table_exists(&c, "settings"));
    }

    #[test]
    fn les_versions_sont_uniques_et_croissantes() {
        let vs: Vec<i64> = MIGRATIONS.iter().map(|m| m.version).collect();
        let mut sorted = vs.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(vs, sorted);
    }

    #[test]
    fn rejouer_est_idempotent_et_sans_sauvegarde() {
        let mut c = mem();
        run(&mut c, &[M1], no_backup).unwrap();
        let called = Cell::new(false);
        run(&mut c, &[M1], |_| {
            called.set(true);
            Ok(())
        })
        .unwrap();
        assert!(!called.get(), "aucune sauvegarde si rien à migrer");
    }

    #[test]
    fn pas_de_sauvegarde_sur_base_neuve_mais_sauvegarde_avant_mise_a_niveau() {
        let mut c = mem();
        let fresh = Cell::new(false);
        run(&mut c, &[M1], |_| {
            fresh.set(true);
            Ok(())
        })
        .unwrap();
        assert!(!fresh.get());
        let upgrade = Cell::new(false);
        let v = run(&mut c, &[M1, M2], |_| {
            upgrade.set(true);
            Ok(())
        })
        .unwrap();
        assert!(upgrade.get());
        assert_eq!(v, 2);
        assert!(table_exists(&c, "b"));
    }

    #[test]
    fn echec_de_sauvegarde_bloque_la_migration() {
        let mut c = mem();
        run(&mut c, &[M1], no_backup).unwrap();
        let r = run(&mut c, &[M1, M2], |_| {
            Err(AppError::Io("disque plein".into()))
        });
        assert!(matches!(r, Err(AppError::Io(_))));
        assert!(!table_exists(&c, "b"), "pas de migration sans sauvegarde");
    }

    #[test]
    fn base_plus_recente_que_l_application_est_refusee() {
        let mut c = mem();
        run(&mut c, &[M1, M2], no_backup).unwrap();
        let r = run(&mut c, &[M1], no_backup);
        assert!(matches!(
            r,
            Err(AppError::DbNewerThanApp {
                found: 2,
                supported: 1
            })
        ));
    }

    #[test]
    fn migration_modifiee_apres_application_est_refusee() {
        let mut c = mem();
        run(&mut c, &[M1], no_backup).unwrap();
        let tampered = Migration {
            version: 1,
            name: "a",
            sql: "CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT);",
        };
        let r = run(&mut c, &[tampered], no_backup);
        assert!(matches!(r, Err(AppError::MigrationChecksum { version: 1 })));
    }

    #[test]
    fn migration_en_echec_est_annulee_et_n_est_pas_enregistree() {
        let mut c = mem();
        run(&mut c, &[M1], no_backup).unwrap();
        c.execute("INSERT INTO a (id) VALUES (7)", []).unwrap();
        let bad = Migration {
            version: 2,
            name: "bad",
            sql: "CREATE TABLE ok_avant (id INTEGER); INSERT INTO table_inexistante VALUES (1);",
        };
        let r = run(&mut c, &[M1, bad], no_backup);
        assert!(matches!(r, Err(AppError::Migration { version: 2, .. })));
        assert!(
            !table_exists(&c, "ok_avant"),
            "la transaction doit être annulée en entier"
        );
        let n: i64 = c
            .query_row("SELECT count(*) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let kept: i64 = c
            .query_row("SELECT count(*) FROM a", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "les données existantes sont intactes");
    }
}
