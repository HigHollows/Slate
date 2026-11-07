//! Commandes IPC exposées au WebView. Chaque commande valide ses entrées.

use crate::db;
use crate::error::{AppError, AppResult};
use crate::settings::{self, SettingRow};
use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

/// État partagé. Si la base n'a pas pu s'ouvrir, l'erreur est conservée et renvoyée à l'UI
/// (l'application affiche un écran d'erreur explicite plutôt que de planter).
pub struct AppState {
    pub db: Result<Mutex<Connection>, AppError>,
    pub db_path: PathBuf,
    /// Verrou applicatif : tant qu'il est actif, le cœur refuse toute commande de données (voir `pin.rs`).
    pub locked: std::sync::atomic::AtomicBool,
}

impl AppState {
    pub fn new(db: Result<Mutex<Connection>, AppError>, db_path: PathBuf) -> Self {
        Self {
            db,
            db_path,
            locked: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn is_locked(&self) -> bool {
        self.locked.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn set_locked(&self, v: bool) {
        self.locked.store(v, std::sync::atomic::Ordering::SeqCst);
    }

    /// Accès aux données : refusé tant que l'application est verrouillée.
    pub(crate) fn with_db<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        if self.is_locked() {
            return Err(AppError::Locked);
        }
        self.with_db_unlocked(f)
    }

    /// Accès réservé au verrouillage lui-même (état du PIN, déverrouillage).
    pub(crate) fn with_db_unlocked<T>(
        &self,
        f: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        match &self.db {
            Ok(m) => {
                let guard = m
                    .lock()
                    .map_err(|_| AppError::Db("verrou de base empoisonné".into()))?;
                f(&guard)
            }
            Err(e) => Err(e.clone()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    app_version: String,
    schema_version: i64,
    device_id: String,
    db_path: String,
    integrity_ok: bool,
}

pub fn ping_impl(message: &str) -> AppResult<String> {
    if message.chars().count() > 1000 {
        return Err(AppError::Invalid("message trop long".into()));
    }
    Ok(format!("pong: {message}"))
}

pub fn system_info_impl(state: &AppState) -> AppResult<SystemInfo> {
    state.with_db(|c| {
        Ok(SystemInfo {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version: db::schema_version(c)?,
            device_id: db::ensure_device_id(c)?,
            db_path: state.db_path.display().to_string(),
            integrity_ok: db::integrity_ok(c)?,
        })
    })
}

#[tauri::command]
pub fn settings_get_all(state: tauri::State<'_, AppState>) -> AppResult<Vec<SettingRow>> {
    state.with_db(settings::get_all)
}

#[tauri::command]
pub fn settings_set(
    state: tauri::State<'_, AppState>,
    key: String,
    value_json: String,
) -> AppResult<()> {
    state.with_db(|c| settings::set(c, &key, &value_json))
}

#[tauri::command]
pub fn settings_delete(state: tauri::State<'_, AppState>, key: String) -> AppResult<()> {
    state.with_db(|c| settings::delete(c, &key))
}

#[tauri::command]
pub fn ping(message: String) -> AppResult<String> {
    ping_impl(&message)
}

#[tauri::command]
pub fn system_info(state: tauri::State<'_, AppState>) -> AppResult<SystemInfo> {
    system_info_impl(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ping_aller_retour_et_validation() {
        assert_eq!(ping_impl("salut").unwrap(), "pong: salut");
        assert!(matches!(
            ping_impl(&"x".repeat(1001)),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn system_info_reflete_la_vraie_base() {
        let dir = tempdir().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let state = AppState::new(Ok(Mutex::new(conn)), dir.path().join(db::DB_FILE));
        let info = system_info_impl(&state).unwrap();
        assert_eq!(
            info.schema_version,
            db::migrations::latest_version(db::migrations::MIGRATIONS)
        );
        assert!(info.integrity_ok);
        assert_eq!(info.device_id.len(), 36);
    }

    #[test]
    fn une_base_inutilisable_renvoie_l_erreur_d_origine_a_l_ui() {
        let state = AppState::new(
            Err(AppError::DbNewerThanApp {
                found: 5,
                supported: 1,
            }),
            PathBuf::new(),
        );
        let e = system_info_impl(&state).err().unwrap();
        assert_eq!(e.code(), "db.newer_than_app");
    }
}
