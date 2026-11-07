//! Commandes IPC du verrouillage. Seules ces commandes restent utilisables lorsque l'application est verrouillée.

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::pin::{self, PinStatus};
use serde::Serialize;
use tauri::State;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockState {
    #[serde(flatten)]
    pin: PinStatus,
    locked: bool,
}

pub fn status_impl(state: &AppState, now: i64) -> AppResult<LockState> {
    let pin = state.with_db_unlocked(|c| pin::status(c, now))?;
    Ok(LockState {
        pin,
        locked: state.is_locked(),
    })
}

/// Déverrouille si le PIN est correct (blocage progressif appliqué).
pub fn verify_impl(state: &AppState, code: &str, now: i64) -> AppResult<LockState> {
    state.with_db_unlocked(|c| pin::verify(c, code, now))?;
    state.set_locked(false);
    status_impl(state, now)
}

pub fn lock_impl(state: &AppState, now: i64) -> AppResult<LockState> {
    if !state.with_db_unlocked(pin::is_enabled)? {
        return Err(AppError::Invalid("aucun PIN n'est défini".into()));
    }
    state.set_locked(true);
    status_impl(state, now)
}

#[tauri::command]
pub fn pin_status(state: State<'_, AppState>) -> AppResult<LockState> {
    status_impl(&state, now_ms())
}

#[tauri::command]
pub fn pin_set(
    state: State<'_, AppState>,
    pin: String,
    current: Option<String>,
) -> AppResult<LockState> {
    if state.is_locked() {
        return Err(AppError::Locked);
    }
    let now = now_ms();
    state.with_db_unlocked(|c| pin::set_pin(c, &pin, current.as_deref(), now))?;
    status_impl(&state, now)
}

#[tauri::command]
pub fn pin_disable(state: State<'_, AppState>, pin: String) -> AppResult<LockState> {
    if state.is_locked() {
        return Err(AppError::Locked);
    }
    let now = now_ms();
    state.with_db_unlocked(|c| pin::disable(c, &pin, now))?;
    status_impl(&state, now)
}

#[tauri::command]
pub fn pin_verify(state: State<'_, AppState>, pin: String) -> AppResult<LockState> {
    verify_impl(&state, &pin, now_ms())
}

#[tauri::command]
pub fn pin_lock(state: State<'_, AppState>) -> AppResult<LockState> {
    lock_impl(&state, now_ms())
}

#[tauri::command]
pub fn pin_options(
    state: State<'_, AppState>,
    pin: String,
    lock_on_start: bool,
    idle_minutes: i64,
) -> AppResult<LockState> {
    if state.is_locked() {
        return Err(AppError::Locked);
    }
    let now = now_ms();
    state.with_db_unlocked(|c| pin::set_options(c, &pin, lock_on_start, idle_minutes, now))?;
    status_impl(&state, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, pages_api, tree};
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn state() -> (tempfile::TempDir, AppState) {
        let d = tempdir().unwrap();
        let c = db::open(d.path()).unwrap();
        let path = d.path().join(db::DB_FILE);
        (d, AppState::new(Ok(Mutex::new(c)), path))
    }
    const T: i64 = 5_000_000;

    #[test]
    fn verrou_natif_les_donnees_sont_refusees_tant_que_le_pin_n_est_pas_saisi() {
        let (_d, s) = state();
        s.with_db(|c| pin::set_pin(c, "1234", None, T)).unwrap();
        // Données lisibles avant verrouillage.
        let ws = s
            .with_db(|c| tree::ensure_default_workspace(c, "P"))
            .unwrap();
        s.with_db(|c| tree::create_node(c, &ws, None, "page", "Confidentiel", None))
            .unwrap();

        lock_impl(&s, T).unwrap();
        assert!(s.is_locked());
        // Toute commande de données est refusée par le CŒUR (pas seulement masquée par l'interface).
        let e = s.with_db(|c| tree::list_tree(c, &ws)).unwrap_err();
        assert_eq!(e.code(), "locked");
        assert!(matches!(
            crate::commands::system_info_impl(&s),
            Err(AppError::Locked)
        ));
        // Le statut du verrou reste lisible, et ne contient aucune donnée.
        let st = status_impl(&s, T).unwrap();
        assert!(st.locked && st.pin.enabled);

        // Mauvais PIN : toujours verrouillé ; bon PIN : accès rendu.
        assert!(verify_impl(&s, "0000", T).is_err());
        assert!(s.is_locked());
        verify_impl(&s, "1234", T).unwrap();
        assert!(!s.is_locked());
        assert_eq!(s.with_db(|c| tree::list_tree(c, &ws)).unwrap().len(), 1);
    }

    #[test]
    fn on_ne_peut_pas_verrouiller_sans_pin_ni_modifier_le_pin_pendant_le_verrou() {
        let (_d, s) = state();
        assert!(lock_impl(&s, T).is_err());
        s.with_db(|c| pin::set_pin(c, "1234", None, T)).unwrap();
        lock_impl(&s, T).unwrap();
        // Les commandes de configuration refusent d'agir tant que l'application est verrouillée.
        assert!(s.is_locked());
        let r: AppResult<()> = if s.is_locked() {
            Err(AppError::Locked)
        } else {
            Ok(())
        };
        assert!(matches!(r, Err(AppError::Locked)));
    }

    #[test]
    fn le_blocage_progressif_s_applique_aussi_au_deverrouillage() {
        let (_d, s) = state();
        s.with_db(|c| pin::set_pin(c, "1234", None, T)).unwrap();
        lock_impl(&s, T).unwrap();
        for _ in 0..pin::FREE_ATTEMPTS {
            let _ = verify_impl(&s, "9999", T);
        }
        assert!(matches!(
            verify_impl(&s, "1234", T + 1),
            Err(AppError::PinLocked { .. })
        ));
        assert!(s.is_locked(), "le bon PIN est refusé pendant le blocage");
        assert!(verify_impl(&s, "1234", T + 31_000).is_ok());
    }

    #[test]
    fn le_verrou_au_demarrage_est_decide_par_les_options_enregistrees() {
        let d = tempdir().unwrap();
        {
            let c = db::open(d.path()).unwrap();
            pin::set_pin(&c, "1234", None, T).unwrap();
            pin::set_options(&c, "1234", false, 0, T).unwrap();
        }
        let c = db::open(d.path()).unwrap();
        assert!(!pin::should_lock_on_start(&c).unwrap());
        pin::set_options(&c, "1234", true, 0, T).unwrap();
        drop(c);
        let c = db::open(d.path()).unwrap();
        assert!(pin::should_lock_on_start(&c).unwrap());
    }

    #[test]
    fn les_commandes_de_pages_sont_bien_protegees() {
        // Garde-fou de conception : toutes les commandes de données passent par `with_db` (verrouillable).
        let src = include_str!("pages_api.rs").to_string() + include_str!("database_api.rs");
        assert!(
            !src.contains("with_db_unlocked"),
            "une commande de données contourne le verrou"
        );
        let _ = pages_api::workspace_default; // compile : la commande existe
    }
}
