//! Commandes IPC des rappels.

use crate::commands::AppState;
use crate::error::AppResult;
use crate::reminders::{self, ReminderOut};
use crate::tree;
use tauri::{AppHandle, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn reminders_due(state: State<'_, AppState>) -> AppResult<Vec<ReminderOut>> {
    state.with_db(|c| {
        let now = tree::now(c)?;
        reminders::due_at(c, &now)
    })
}

#[tauri::command]
pub fn reminder_ack(
    state: State<'_, AppState>,
    row_id: String,
    property_id: String,
    fire_at: String,
) -> AppResult<()> {
    state.with_db(|c| reminders::ack(c, &row_id, &property_id, &fire_at))
}

/// Notification du système pour un rappel. Le texte vient du titre de la tâche ; échec = erreur visible (pas silencieux).
#[tauri::command]
pub fn reminder_notify(
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
    body: String,
) -> AppResult<()> {
    if state.is_locked() {
        return Err(crate::error::AppError::Locked);
    }
    let clip = |s: String, n: usize| s.chars().take(n).collect::<String>();
    app.notification()
        .builder()
        .title(clip(title, 120))
        .body(clip(body, 240))
        .show()
        .map_err(|e| crate::error::AppError::Io(e.to_string()))
}

/// Ouvre un lien http(s) ou mailto avec l'application par défaut du système (adresse revalidée ici).
#[tauri::command]
pub fn open_external(app: AppHandle, state: State<'_, AppState>, url: String) -> AppResult<()> {
    if state.is_locked() {
        return Err(crate::error::AppError::Locked);
    }
    let url = crate::external::validate(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| crate::error::AppError::Io(e.to_string()))
}
