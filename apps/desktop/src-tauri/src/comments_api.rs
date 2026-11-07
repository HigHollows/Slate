//! Commandes IPC des commentaires.

use crate::commands::AppState;
use crate::comments::{self, CommentOut, ThreadOut};
use crate::error::AppResult;
use tauri::State;

#[tauri::command]
pub fn thread_create(
    state: State<'_, AppState>,
    id: String,
    node_id: String,
    quote: String,
    body: String,
    author: Option<String>,
) -> AppResult<ThreadOut> {
    state.with_db(|c| comments::create_thread(c, &id, &node_id, &quote, &body, author.as_deref()))
}

#[tauri::command]
pub fn thread_list(state: State<'_, AppState>, node_id: String) -> AppResult<Vec<ThreadOut>> {
    state.with_db(|c| comments::list(c, &node_id))
}

#[tauri::command]
pub fn comment_add(
    state: State<'_, AppState>,
    thread_id: String,
    body: String,
    author: Option<String>,
) -> AppResult<CommentOut> {
    state.with_db(|c| comments::add_comment(c, &thread_id, &body, author.as_deref()))
}

#[tauri::command]
pub fn comment_edit(state: State<'_, AppState>, id: String, body: String) -> AppResult<CommentOut> {
    state.with_db(|c| comments::edit_comment(c, &id, &body))
}

#[tauri::command]
pub fn comment_delete(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    state.with_db(|c| comments::delete_comment(c, &id))
}

#[tauri::command]
pub fn thread_resolve(
    state: State<'_, AppState>,
    thread_id: String,
    resolved: bool,
    author: Option<String>,
) -> AppResult<ThreadOut> {
    state.with_db(|c| comments::resolve(c, &thread_id, resolved, author.as_deref()))
}

#[tauri::command]
pub fn thread_delete(state: State<'_, AppState>, thread_id: String) -> AppResult<()> {
    state.with_db(|c| comments::delete_thread(c, &thread_id))
}
