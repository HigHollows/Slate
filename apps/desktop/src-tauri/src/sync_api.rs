//! Commandes IPC de la synchronisation (aucun accès réseau ici : voir `sync.rs`).

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::sync::{
    self, AckResult, ApplyReport, DocForMerge, DocOutcome, PendingOp, RemoteNode, RemoteStruct,
    SyncStatus,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::State;

#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> AppResult<SyncStatus> {
    state.with_db(sync::status)
}

#[tauri::command]
pub fn sync_enable(state: State<'_, AppState>, workspace_id: String) -> AppResult<SyncStatus> {
    state.with_db(|c| sync::enable(c, &workspace_id))
}

#[tauri::command]
pub fn sync_disable(state: State<'_, AppState>) -> AppResult<SyncStatus> {
    state.with_db(sync::disable)
}

#[tauri::command]
pub fn sync_pending(state: State<'_, AppState>, limit: Option<usize>) -> AppResult<Vec<PendingOp>> {
    state.with_db(|c| sync::pending_ops(c, limit.unwrap_or(100)))
}

#[tauri::command]
pub fn sync_ack(state: State<'_, AppState>, results: Vec<AckResult>) -> AppResult<()> {
    state.with_db(|c| sync::ack(c, &results))
}

#[tauri::command]
pub fn sync_apply_nodes(
    state: State<'_, AppState>,
    workspace_id: String,
    nodes: Vec<RemoteNode>,
    cursor: Option<i64>,
) -> AppResult<ApplyReport> {
    state.with_db(|c| sync::apply_remote_nodes(c, &workspace_id, &nodes, cursor))
}

#[tauri::command]
pub fn sync_apply_struct(
    state: State<'_, AppState>,
    workspace_id: String,
    items: Vec<RemoteStruct>,
    cursor: Option<i64>,
) -> AppResult<ApplyReport> {
    state.with_db(|c| sync::apply_remote_struct(c, &workspace_id, &items, cursor))
}

#[tauri::command]
pub fn sync_doc_get(state: State<'_, AppState>, node_id: String) -> AppResult<Option<DocForMerge>> {
    state.with_db(|c| sync::doc_for_merge(c, &node_id))
}

#[tauri::command]
pub fn sync_apply_doc(
    state: State<'_, AppState>,
    node_id: String,
    doc_state: String,
    content_json: String,
    text_plain: String,
    expected_updated_at: Option<String>,
) -> AppResult<DocOutcome> {
    let bytes = B64
        .decode(doc_state)
        .map_err(|_| AppError::Invalid("état de document illisible".into()))?;
    state.with_db(|c| {
        sync::apply_remote_doc(
            c,
            &node_id,
            &bytes,
            &content_json,
            &text_plain,
            expected_updated_at.as_deref(),
        )
    })
}

#[tauri::command]
pub fn sync_set_doc_cursor(
    state: State<'_, AppState>,
    workspace_id: String,
    cursor: i64,
) -> AppResult<()> {
    state.with_db(|c| sync::set_doc_cursor(c, &workspace_id, cursor))
}

#[tauri::command]
pub fn sync_record_error(
    state: State<'_, AppState>,
    workspace_id: String,
    message: String,
) -> AppResult<()> {
    state.with_db(|c| sync::record_error(c, &workspace_id, &message))
}

#[tauri::command]
pub fn sync_join_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
    role: String,
) -> AppResult<SyncStatus> {
    state.with_db(|c| sync::join_workspace(c, &workspace_id, &name, &role))
}

#[tauri::command]
pub fn sync_set_role(
    state: State<'_, AppState>,
    workspace_id: String,
    role: Option<String>,
) -> AppResult<SyncStatus> {
    state.with_db(|c| sync::set_workspace_role(c, &workspace_id, role.as_deref()))
}
