//! Commandes IPC du coffre de session. Refusées tant que l'application est verrouillée par le PIN.

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::vault;
use tauri::State;

fn ensure_unlocked(state: &AppState) -> AppResult<()> {
    if state.is_locked() {
        Err(AppError::Locked)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn vault_load(state: State<'_, AppState>) -> AppResult<Option<String>> {
    ensure_unlocked(&state)?;
    vault::load()
}

#[tauri::command]
pub fn vault_save(state: State<'_, AppState>, token: String) -> AppResult<()> {
    ensure_unlocked(&state)?;
    vault::save(&token)
}

#[tauri::command]
pub fn vault_clear(state: State<'_, AppState>) -> AppResult<()> {
    ensure_unlocked(&state)?;
    vault::clear()
}
