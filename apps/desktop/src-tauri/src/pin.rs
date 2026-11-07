//! Verrouillage local par PIN (4 ou 6 chiffres).
//!
//! * le PIN n'est jamais stocké : seulement une empreinte **Argon2id** (sel aléatoire propre à chaque PIN) ;
//! * protection contre les tentatives répétées : 5 essais libres, puis blocage de 30 s doublé à chaque échec
//!   supplémentaire (plafonné à 1 h), **persistant** (survit au redémarrage) ;
//! * le PIN est indépendant du mot de passe du compte ;
//! * limite assumée : c'est un verrou d'accès à l'application (le cœur refuse toute donnée tant qu'il est actif),
//!   pas un chiffrement : le fichier SQLite n'est pas chiffré (SECURITY.md, D-009).

use crate::error::{AppError, AppResult};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use rusqlite::{params, Connection};
use serde::Serialize;

pub const FREE_ATTEMPTS: i64 = 5;
const BASE_LOCK_MS: u64 = 30_000;
const MAX_LOCK_MS: u64 = 3_600_000;
const MAX_IDLE_MINUTES: i64 = 240;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PinStatus {
    pub enabled: bool,
    pub lock_on_start: bool,
    pub idle_minutes: i64,
    pub failed_count: i64,
    /// Temps restant avant de pouvoir réessayer (0 = essai possible).
    pub retry_after_ms: u64,
}

fn hasher() -> AppResult<Argon2<'static>> {
    // Paramètres OWASP (m = 19 Mio, t = 2, p = 1).
    let p = Params::new(19 * 1024, 2, 1, None).map_err(|e| AppError::Invalid(e.to_string()))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, p))
}

pub fn validate_format(pin: &str) -> AppResult<()> {
    if (pin.len() == 4 || pin.len() == 6) && pin.bytes().all(|b| b.is_ascii_digit()) {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "le PIN doit comporter 4 ou 6 chiffres".into(),
        ))
    }
}

fn hash(pin: &str) -> AppResult<String> {
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(uuid::Uuid::new_v4().as_bytes()); // aléatoire système
    let salt = SaltString::encode_b64(&bytes).map_err(|e| AppError::Invalid(e.to_string()))?;
    Ok(hasher()?
        .hash_password(pin.as_bytes(), &salt)
        .map_err(|e| AppError::Invalid(e.to_string()))?
        .to_string())
}

struct Row {
    hash: Option<String>,
    lock_on_start: bool,
    idle: i64,
    failed: i64,
    locked_until: i64,
}

fn load(conn: &Connection) -> AppResult<Row> {
    Ok(conn.query_row(
        "SELECT pin_hash, lock_on_start, idle_minutes, failed_count, locked_until FROM security_local WHERE id = 1",
        [],
        |r| {
            Ok(Row {
                hash: r.get(0)?,
                lock_on_start: r.get::<_, i64>(1)? == 1,
                idle: r.get(2)?,
                failed: r.get(3)?,
                locked_until: r.get(4)?,
            })
        },
    )?)
}

pub fn status(conn: &Connection, now_ms: i64) -> AppResult<PinStatus> {
    let r = load(conn)?;
    Ok(PinStatus {
        enabled: r.hash.is_some(),
        lock_on_start: r.lock_on_start,
        idle_minutes: r.idle,
        failed_count: r.failed,
        retry_after_ms: (r.locked_until - now_ms).max(0) as u64,
    })
}

pub fn is_enabled(conn: &Connection) -> AppResult<bool> {
    Ok(load(conn)?.hash.is_some())
}

/// Faut-il verrouiller l'application au démarrage ?
pub fn should_lock_on_start(conn: &Connection) -> AppResult<bool> {
    let r = load(conn)?;
    Ok(r.hash.is_some() && r.lock_on_start)
}

fn lock_duration_ms(failed: i64) -> u64 {
    let extra = (failed - FREE_ATTEMPTS).clamp(0, 20) as u32;
    BASE_LOCK_MS.saturating_mul(1u64 << extra).min(MAX_LOCK_MS)
}

/// Vérifie un PIN en appliquant le blocage progressif. Toute vérification (déverrouillage, changement, désactivation)
/// passe par ici : il n'existe aucun chemin contournant le compteur.
pub fn verify(conn: &Connection, pin: &str, now_ms: i64) -> AppResult<()> {
    let tx = crate::db::begin(conn)?;
    let r = load(&tx)?;
    let Some(stored) = r.hash else {
        return Err(AppError::Invalid("aucun PIN n'est défini".into()));
    };
    if r.locked_until > now_ms {
        return Err(AppError::PinLocked {
            retry_after_ms: (r.locked_until - now_ms) as u64,
        });
    }
    // Un format invalide compte comme un échec (pas d'oracle sur la forme du PIN).
    let ok = validate_format(pin).is_ok()
        && PasswordHash::new(&stored).ok().is_some_and(|h| {
            hasher()
                .ok()
                .is_some_and(|a| a.verify_password(pin.as_bytes(), &h).is_ok())
        });
    if ok {
        tx.execute(
            "UPDATE security_local SET failed_count = 0, locked_until = 0 WHERE id = 1",
            [],
        )?;
        tx.commit()?;
        return Ok(());
    }
    let failed = r.failed + 1;
    let until = if failed >= FREE_ATTEMPTS {
        now_ms + lock_duration_ms(failed) as i64
    } else {
        0
    };
    tx.execute(
        "UPDATE security_local SET failed_count = ?1, locked_until = ?2 WHERE id = 1",
        params![failed, until],
    )?;
    tx.commit()?;
    tracing::warn!(failed, "PIN incorrect");
    if until > 0 {
        Err(AppError::PinLocked {
            retry_after_ms: (until - now_ms) as u64,
        })
    } else {
        Err(AppError::PinInvalid { failed })
    }
}

/// Définit ou change le PIN. S'il en existe déjà un, l'ancien est exigé.
pub fn set_pin(
    conn: &Connection,
    new_pin: &str,
    current: Option<&str>,
    now_ms: i64,
) -> AppResult<()> {
    validate_format(new_pin)?;
    if is_enabled(conn)? {
        verify(conn, current.unwrap_or(""), now_ms)?;
    }
    let h = hash(new_pin)?;
    conn.execute(
        "UPDATE security_local SET pin_hash = ?1, failed_count = 0, locked_until = 0,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
        [h],
    )?;
    tracing::info!("PIN défini ou modifié");
    Ok(())
}

pub fn disable(conn: &Connection, pin: &str, now_ms: i64) -> AppResult<()> {
    verify(conn, pin, now_ms)?;
    conn.execute(
        "UPDATE security_local SET pin_hash = NULL, failed_count = 0, locked_until = 0,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
        [],
    )?;
    tracing::info!("PIN désactivé");
    Ok(())
}

/// Options de verrouillage (au démarrage, après inactivité) : exigent le PIN, pour qu'on ne puisse pas les affaiblir sans lui.
pub fn set_options(
    conn: &Connection,
    pin: &str,
    lock_on_start: bool,
    idle_minutes: i64,
    now_ms: i64,
) -> AppResult<()> {
    if !(0..=MAX_IDLE_MINUTES).contains(&idle_minutes) {
        return Err(AppError::Invalid("délai d'inactivité invalide".into()));
    }
    verify(conn, pin, now_ms)?;
    conn.execute(
        "UPDATE security_local SET lock_on_start = ?1, idle_minutes = ?2,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1",
        params![lock_on_start as i64, idle_minutes],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::tempdir;

    const T0: i64 = 1_000_000;
    fn open() -> (tempfile::TempDir, Connection) {
        let d = tempdir().unwrap();
        let c = db::open(d.path()).unwrap();
        (d, c)
    }

    #[test]
    fn par_defaut_aucun_pin() {
        let (_d, c) = open();
        let s = status(&c, T0).unwrap();
        assert!(!s.enabled && s.failed_count == 0 && s.retry_after_ms == 0);
        assert!(!should_lock_on_start(&c).unwrap());
        assert!(verify(&c, "1234", T0).is_err());
    }

    #[test]
    fn formats_acceptes_et_refuses() {
        for ok in ["1234", "123456", "0000"] {
            assert!(validate_format(ok).is_ok(), "{ok}");
        }
        for ko in [
            "", "123", "12345", "1234567", "12a4", "١٢٣٤", " 1234", "12 34", "12.4",
        ] {
            assert!(validate_format(ko).is_err(), "{ko:?}");
        }
    }

    #[test]
    fn le_pin_n_est_jamais_stocke_en_clair() {
        let (d, c) = open();
        set_pin(&c, "482913", None, T0).unwrap();
        let stored: String = c
            .query_row("SELECT pin_hash FROM security_local", [], |r| r.get(0))
            .unwrap();
        assert!(stored.starts_with("$argon2id$"), "{stored}");
        assert!(!stored.contains("482913"));
        drop(c);
        // Aucune trace du PIN dans le fichier de base ni dans le WAL.
        for f in std::fs::read_dir(d.path())
            .unwrap()
            .flatten()
            .filter(|f| f.path().is_file())
        {
            let bytes = std::fs::read(f.path()).unwrap();
            assert!(
                !bytes.windows(6).any(|w| w == b"482913"),
                "PIN en clair dans {:?}",
                f.path()
            );
        }
    }

    #[test]
    fn deux_pins_identiques_ont_des_empreintes_differentes_sel_unique() {
        let (_d, c) = open();
        set_pin(&c, "1234", None, T0).unwrap();
        let a: String = c
            .query_row("SELECT pin_hash FROM security_local", [], |r| r.get(0))
            .unwrap();
        set_pin(&c, "5678", Some("1234"), T0).unwrap();
        set_pin(&c, "1234", Some("5678"), T0).unwrap();
        let b: String = c
            .query_row("SELECT pin_hash FROM security_local", [], |r| r.get(0))
            .unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn verification_bonne_et_mauvaise() {
        let (_d, c) = open();
        set_pin(&c, "1234", None, T0).unwrap();
        assert!(status(&c, T0).unwrap().enabled);
        assert!(verify(&c, "1234", T0).is_ok());
        assert!(matches!(
            verify(&c, "9999", T0),
            Err(AppError::PinInvalid { failed: 1 })
        ));
        assert!(
            matches!(
                verify(&c, "abcd", T0),
                Err(AppError::PinInvalid { failed: 2 })
            ),
            "forme invalide = échec compté"
        );
        assert!(verify(&c, "1234", T0).is_ok());
        assert_eq!(
            status(&c, T0).unwrap().failed_count,
            0,
            "le succès remet le compteur à zéro"
        );
    }

    #[test]
    fn blocage_progressif_apres_cinq_echecs_et_doublement() {
        let (_d, c) = open();
        set_pin(&c, "1234", None, T0).unwrap();
        for i in 1..FREE_ATTEMPTS {
            assert!(
                matches!(verify(&c, "0000", T0), Err(AppError::PinInvalid { failed }) if failed == i)
            );
        }
        // 5e échec : blocage 30 s
        assert!(matches!(
            verify(&c, "0000", T0),
            Err(AppError::PinLocked {
                retry_after_ms: 30_000
            })
        ));
        // Pendant le blocage, même le BON PIN est refusé (et ne change rien).
        assert!(matches!(
            verify(&c, "1234", T0 + 10_000),
            Err(AppError::PinLocked {
                retry_after_ms: 20_000
            })
        ));
        assert_eq!(status(&c, T0 + 10_000).unwrap().retry_after_ms, 20_000);
        // Après expiration : le bon PIN passe.
        assert!(verify(&c, "1234", T0 + 31_000).is_ok());
        assert_eq!(status(&c, T0 + 31_000).unwrap().failed_count, 0);
    }

    #[test]
    fn le_delai_double_et_est_plafonne() {
        let (_d, c) = open();
        set_pin(&c, "1234", None, T0).unwrap();
        let mut now = T0;
        let mut expected = vec![];
        for i in 1..=14 {
            match verify(&c, "0000", now) {
                Err(AppError::PinLocked { retry_after_ms }) => {
                    expected.push((i, retry_after_ms));
                    now += retry_after_ms as i64 + 1;
                }
                Err(AppError::PinInvalid { .. }) => {}
                other => panic!("{other:?}"),
            }
        }
        let delays: Vec<u64> = expected.iter().map(|e| e.1).collect();
        assert_eq!(&delays[..4], &[30_000, 60_000, 120_000, 240_000]);
        assert!(delays.iter().all(|d| *d <= MAX_LOCK_MS));
        assert_eq!(*delays.last().unwrap(), MAX_LOCK_MS);
    }

    #[test]
    fn le_blocage_survit_au_redemarrage() {
        let d = tempdir().unwrap();
        {
            let c = db::open(d.path()).unwrap();
            set_pin(&c, "1234", None, T0).unwrap();
            for _ in 0..FREE_ATTEMPTS {
                let _ = verify(&c, "0000", T0);
            }
        }
        let c = db::open(d.path()).unwrap();
        assert!(
            matches!(
                verify(&c, "1234", T0 + 1_000),
                Err(AppError::PinLocked { .. })
            ),
            "fermer l'application ne réinitialise pas le blocage"
        );
        assert_eq!(status(&c, T0 + 1_000).unwrap().failed_count, FREE_ATTEMPTS);
    }

    #[test]
    fn changer_ou_desactiver_exige_l_ancien_pin_et_respecte_le_blocage() {
        let (_d, c) = open();
        set_pin(&c, "1234", None, T0).unwrap();
        assert!(set_pin(&c, "5678", None, T0).is_err(), "pas d'ancien PIN");
        assert!(
            set_pin(&c, "5678", Some("0000"), T0).is_err(),
            "mauvais ancien PIN"
        );
        assert!(
            set_pin(&c, "12", Some("1234"), T0).is_err(),
            "nouveau format invalide"
        );
        assert!(
            verify(&c, "1234", T0).is_ok(),
            "l'ancien PIN reste valable après un refus"
        );
        set_pin(&c, "567890", Some("1234"), T0).unwrap();
        assert!(verify(&c, "1234", T0).is_err());
        assert!(verify(&c, "567890", T0).is_ok());
        assert!(disable(&c, "1234", T0).is_err());
        assert!(status(&c, T0).unwrap().enabled);
        disable(&c, "567890", T0).unwrap();
        assert!(!status(&c, T0).unwrap().enabled);
        let h: Option<String> = c
            .query_row("SELECT pin_hash FROM security_local", [], |r| r.get(0))
            .unwrap();
        assert!(h.is_none(), "l'empreinte est effacée");
    }

    #[test]
    fn options_de_verrouillage_validees_et_protegees_par_le_pin() {
        let (_d, c) = open();
        set_pin(&c, "1234", None, T0).unwrap();
        assert!(should_lock_on_start(&c).unwrap());
        assert!(set_options(&c, "0000", false, 5, T0).is_err());
        assert!(set_options(&c, "1234", false, 241, T0).is_err());
        assert!(set_options(&c, "1234", false, -1, T0).is_err());
        set_options(&c, "1234", false, 15, T0).unwrap();
        let s = status(&c, T0).unwrap();
        assert_eq!((s.lock_on_start, s.idle_minutes), (false, 15));
        assert!(!should_lock_on_start(&c).unwrap());
    }

    #[test]
    fn les_essais_echoues_ne_fuient_pas_dans_les_logs_ni_les_erreurs() {
        let e = AppError::PinInvalid { failed: 2 };
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("1234"));
        assert!(json.contains("\"failedCount\":2"));
        let l = serde_json::to_value(AppError::PinLocked {
            retry_after_ms: 5000,
        })
        .unwrap();
        assert_eq!(l["retryAfterMs"], 5000);
        assert_eq!(l["retryable"], false);
    }
}
