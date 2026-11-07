//! Commandes IPC des habitudes.

use crate::commands::AppState;
use crate::error::AppResult;
use crate::habits::{self, HabitDay};
use tauri::State;

#[tauri::command]
pub fn habit_log_list(
    state: State<'_, AppState>,
    database_id: String,
    from: String,
    to: String,
) -> AppResult<Vec<HabitDay>> {
    state.with_db(|c| habits::list(c, &database_id, &from, &to))
}

#[tauri::command]
pub fn habit_log_set(
    state: State<'_, AppState>,
    row_id: String,
    day: String,
    done: bool,
    today: String,
) -> AppResult<()> {
    state.with_db(|c| habits::set(c, &row_id, &day, done, &today))
}
