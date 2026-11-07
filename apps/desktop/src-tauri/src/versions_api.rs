//! Commandes IPC de l'historique des versions.

use crate::commands::AppState;
use crate::error::AppResult;
use crate::versions::{self, VersionData, VersionMeta};
use tauri::State;

#[tauri::command]
pub fn version_create(
    state: State<'_, AppState>,
    node_id: String,
    reason: String,
    label: Option<String>,
    author: Option<String>,
) -> AppResult<VersionMeta> {
    state.with_db(|c| versions::snapshot(c, &node_id, &reason, label.as_deref(), author.as_deref()))
}

#[tauri::command]
pub fn version_list(state: State<'_, AppState>, node_id: String) -> AppResult<Vec<VersionMeta>> {
    state.with_db(|c| versions::list(c, &node_id))
}

#[tauri::command]
pub fn version_get(state: State<'_, AppState>, id: String) -> AppResult<VersionData> {
    state.with_db(|c| versions::get(c, &id))
}

#[tauri::command]
pub fn version_rename(
    state: State<'_, AppState>,
    id: String,
    label: Option<String>,
) -> AppResult<()> {
    state.with_db(|c| versions::rename(c, &id, label.as_deref()))
}

#[tauri::command]
pub fn version_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.with_db(|c| versions::delete(c, &id))
}
