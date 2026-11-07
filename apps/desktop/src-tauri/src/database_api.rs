//! Commandes IPC des bases de données (validation et règles métier dans `database.rs`).

use crate::commands::AppState;
use crate::database::{self, CellChange, DatabaseOut, PropertyOut, RowOut, ViewOut};
use crate::error::AppResult;
use crate::tree::{self, NodeRow};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    node: NodeRow,
    /// Base de données dont ce nœud est une ligne, le cas échéant.
    database_id: Option<String>,
}

#[tauri::command]
pub fn node_get(state: State<'_, AppState>, id: String) -> AppResult<NodeInfo> {
    state.with_db(|c| {
        let node = tree::get(c, &id)?;
        let database_id = database::database_of(c, &id)?;
        Ok(NodeInfo { node, database_id })
    })
}

#[tauri::command]
pub fn db_create(
    state: State<'_, AppState>,
    workspace_id: String,
    parent_id: Option<String>,
    title: String,
    title_property_name: String,
    view_name: String,
) -> AppResult<DatabaseOut> {
    state.with_db(|c| {
        database::create_database(
            c,
            &workspace_id,
            parent_id.as_deref(),
            &title,
            &title_property_name,
            &view_name,
        )
    })
}

#[tauri::command]
pub fn db_get(state: State<'_, AppState>, id: String) -> AppResult<DatabaseOut> {
    state.with_db(|c| database::get_database(c, &id))
}

#[tauri::command]
pub fn db_rows(state: State<'_, AppState>, id: String) -> AppResult<Vec<RowOut>> {
    state.with_db(|c| database::rows(c, &id))
}

#[tauri::command]
pub fn row_get(state: State<'_, AppState>, id: String) -> AppResult<RowOut> {
    state.with_db(|c| database::row(c, &id))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn prop_create(
    state: State<'_, AppState>,
    database_id: String,
    name: String,
    kind: String,
    config: Value,
    before_id: Option<String>,
    two_way_name: Option<String>,
) -> AppResult<PropertyOut> {
    state.with_db(|c| {
        database::create_property(
            c,
            &database_id,
            &name,
            &kind,
            &config,
            before_id.as_deref(),
            two_way_name.as_deref(),
        )
    })
}

#[tauri::command]
pub fn prop_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    config: Option<Value>,
    kind: Option<String>,
) -> AppResult<PropertyOut> {
    state.with_db(|c| {
        database::update_property(c, &id, name.as_deref(), config.as_ref(), kind.as_deref())
    })
}

#[tauri::command]
pub fn prop_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.with_db(|c| database::delete_property(c, &id))
}

#[tauri::command]
pub fn prop_move(
    state: State<'_, AppState>,
    id: String,
    before_id: Option<String>,
) -> AppResult<PropertyOut> {
    state.with_db(|c| database::move_property(c, &id, before_id.as_deref()))
}

#[tauri::command]
pub fn view_create(
    state: State<'_, AppState>,
    database_id: String,
    name: String,
    layout: String,
    config: Value,
) -> AppResult<ViewOut> {
    state.with_db(|c| database::create_view(c, &database_id, &name, &layout, &config))
}

#[tauri::command]
pub fn view_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    config: Option<Value>,
) -> AppResult<ViewOut> {
    state.with_db(|c| database::update_view(c, &id, name.as_deref(), config.as_ref()))
}

#[tauri::command]
pub fn view_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.with_db(|c| database::delete_view(c, &id))
}

#[tauri::command]
pub fn cells_set(state: State<'_, AppState>, changes: Vec<CellChange>) -> AppResult<Vec<RowOut>> {
    state.with_db(|c| database::set_cells(c, &changes))
}

#[tauri::command]
pub fn row_create(
    state: State<'_, AppState>,
    database_id: String,
    title: String,
    props: Option<Map<String, Value>>,
) -> AppResult<RowOut> {
    state.with_db(|c| database::create_row(c, &database_id, &title, &props.unwrap_or_default()))
}

#[tauri::command]
pub fn rows_delete(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<usize> {
    state.with_db(|c| database::delete_rows(c, &ids))
}
