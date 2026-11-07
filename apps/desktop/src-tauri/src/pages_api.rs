//! Commandes IPC des pages. Chaque commande valide ses entrées et délègue à `tree`, `content`, `search`.

use crate::commands::AppState;
use crate::content::{self, SavedPage};
use crate::error::{AppError, AppResult};
use crate::search::{self, SearchHit};
use crate::tree::{self, NodeRow};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use tauri::State;

const DEFAULT_WORKSPACE_NAME: &str = "Personnel";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageData {
    /// État Yjs encodé en base64 ; `None` pour une page jamais enregistrée.
    doc_state: Option<String>,
    updated_at: Option<String>,
}

#[tauri::command]
pub fn workspace_default(state: State<'_, AppState>) -> AppResult<WorkspaceInfo> {
    state.with_db(|c| {
        let id = tree::ensure_default_workspace(c, DEFAULT_WORKSPACE_NAME)?;
        Ok(WorkspaceInfo {
            id,
            name: DEFAULT_WORKSPACE_NAME.into(),
        })
    })
}

#[tauri::command]
pub fn workspace_list(state: State<'_, AppState>) -> AppResult<Vec<tree::WorkspaceRow>> {
    state.with_db(tree::list_workspaces)
}

#[tauri::command]
pub fn tree_list(state: State<'_, AppState>, workspace_id: String) -> AppResult<Vec<NodeRow>> {
    state.with_db(|c| tree::list_tree(c, &workspace_id))
}

#[tauri::command]
pub fn node_create(
    state: State<'_, AppState>,
    workspace_id: String,
    parent_id: Option<String>,
    kind: String,
    title: String,
    before_id: Option<String>,
) -> AppResult<NodeRow> {
    state.with_db(|c| {
        tree::create_node(
            c,
            &workspace_id,
            parent_id.as_deref(),
            &kind,
            &title,
            before_id.as_deref(),
        )
    })
}

#[tauri::command]
pub fn node_rename(state: State<'_, AppState>, id: String, title: String) -> AppResult<NodeRow> {
    state.with_db(|c| tree::rename_node(c, &id, &title))
}

#[tauri::command]
pub fn node_move(
    state: State<'_, AppState>,
    id: String,
    new_parent_id: Option<String>,
    before_id: Option<String>,
) -> AppResult<NodeRow> {
    state.with_db(|c| tree::move_node(c, &id, new_parent_id.as_deref(), before_id.as_deref()))
}

#[tauri::command]
pub fn node_set_favorite(
    state: State<'_, AppState>,
    id: String,
    favorite: bool,
) -> AppResult<NodeRow> {
    state.with_db(|c| tree::set_favorite(c, &id, favorite))
}

#[tauri::command]
pub fn node_delete(state: State<'_, AppState>, id: String) -> AppResult<usize> {
    state.with_db(|c| tree::soft_delete(c, &id))
}

#[tauri::command]
pub fn node_restore(state: State<'_, AppState>, id: String) -> AppResult<NodeRow> {
    state.with_db(|c| tree::restore(c, &id))
}

#[tauri::command]
pub fn trash_list(state: State<'_, AppState>, workspace_id: String) -> AppResult<Vec<NodeRow>> {
    state.with_db(|c| tree::list_trash(c, &workspace_id))
}

/// Suppression définitive : uniquement pour un élément déjà dans la corbeille.
#[tauri::command]
pub fn node_purge(state: State<'_, AppState>, id: String) -> AppResult<usize> {
    state.with_db(|c| {
        let n = tree::purge(c, &id)?;
        tracing::info!(node = %id, removed = n, "suppression définitive");
        Ok(n)
    })
}

#[tauri::command]
pub fn trash_empty(state: State<'_, AppState>, workspace_id: String) -> AppResult<usize> {
    state.with_db(|c| {
        let n = tree::empty_trash(c, &workspace_id)?;
        tracing::info!(removed = n, "corbeille vidée");
        Ok(n)
    })
}

#[tauri::command]
pub fn recent_touch(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.with_db(|c| tree::touch_recent(c, &id))
}

#[tauri::command]
pub fn recent_list(
    state: State<'_, AppState>,
    workspace_id: String,
    limit: Option<usize>,
) -> AppResult<Vec<NodeRow>> {
    state.with_db(|c| tree::list_recent(c, &workspace_id, limit.unwrap_or(10).min(50)))
}

#[tauri::command]
pub fn page_get(state: State<'_, AppState>, id: String) -> AppResult<PageData> {
    state.with_db(|c| {
        Ok(match content::get(c, &id)? {
            Some(p) => PageData {
                doc_state: Some(B64.encode(p.doc_state)),
                updated_at: Some(p.updated_at),
            },
            None => PageData {
                doc_state: None,
                updated_at: None,
            },
        })
    })
}

#[tauri::command]
pub fn page_save(
    state: State<'_, AppState>,
    id: String,
    doc_state: String,
    content_json: String,
    text_plain: String,
    link_targets: Vec<String>,
) -> AppResult<SavedPage> {
    let bytes = B64
        .decode(doc_state)
        .map_err(|_| AppError::Invalid("état de document illisible".into()))?;
    state.with_db(|c| content::save(c, &id, &bytes, &content_json, &text_plain, &link_targets))
}

#[tauri::command]
pub fn backlinks_list(state: State<'_, AppState>, id: String) -> AppResult<Vec<NodeRow>> {
    state.with_db(|c| content::backlinks(c, &id))
}

#[tauri::command]
pub fn search_pages(
    state: State<'_, AppState>,
    workspace_id: String,
    query: String,
    limit: Option<usize>,
) -> AppResult<Vec<SearchHit>> {
    if query.chars().count() > 200 {
        return Err(AppError::Invalid("requête trop longue".into()));
    }
    state.with_db(|c| search::search(c, &workspace_id, &query, limit.unwrap_or(20)))
}
