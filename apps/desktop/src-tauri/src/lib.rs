mod commands;
mod comments;
mod comments_api;
mod content;
mod database;
mod database_api;
mod db;
mod error;
mod external;
mod habits;
mod habits_api;
mod logging;
mod media;
mod media_api;
mod pages_api;
mod pin;
mod pin_api;
mod position;
mod reminders;
mod reminders_api;
mod search;
mod settings;
mod sync;
mod sync_api;
mod tree;
mod vault;
mod vault_api;
mod versions;
mod versions_api;

use commands::AppState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Mises à jour : vérifiées par signature (clé publique dans tauri.conf.json) avant toute installation.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| data_dir.join("logs"));
            // Le guard doit vivre autant que l'application pour vider les logs à la fermeture.
            if let Some(guard) = logging::init(&log_dir) {
                app.manage(guard);
            }
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "démarrage de Slate");

            let db_path = data_dir.join(db::DB_FILE);
            let db = db::open(&data_dir).map(Mutex::new);
            if let Err(e) = &db {
                tracing::error!(error = %e, "ouverture de la base impossible");
            }
            let state = AppState::new(db, db_path);
            // Verrou natif dès le démarrage : aucune donnée n'est servie avant la saisie du PIN.
            if let Ok(m) = &state.db {
                let must_lock = m
                    .lock()
                    .ok()
                    .and_then(|c| pin::should_lock_on_start(&c).ok())
                    .unwrap_or(false);
                state.set_locked(must_lock);
                if must_lock {
                    tracing::info!("application verrouillée au démarrage");
                }
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::system_info,
            commands::settings_get_all,
            commands::settings_set,
            commands::settings_delete,
            pin_api::pin_status,
            pin_api::pin_set,
            pin_api::pin_disable,
            pin_api::pin_verify,
            pin_api::pin_lock,
            pin_api::pin_options,
            vault_api::vault_load,
            vault_api::vault_save,
            vault_api::vault_clear,
            pages_api::workspace_default,
            pages_api::workspace_list,
            pages_api::tree_list,
            pages_api::node_create,
            pages_api::node_rename,
            pages_api::node_move,
            pages_api::node_set_favorite,
            pages_api::node_delete,
            pages_api::node_restore,
            pages_api::trash_list,
            pages_api::node_purge,
            pages_api::trash_empty,
            pages_api::recent_touch,
            pages_api::recent_list,
            pages_api::page_get,
            pages_api::page_save,
            pages_api::backlinks_list,
            pages_api::search_pages,
            reminders_api::open_external,
            sync_api::sync_status,
            sync_api::sync_enable,
            sync_api::sync_join_workspace,
            sync_api::sync_set_role,
            sync_api::sync_disable,
            sync_api::sync_pending,
            sync_api::sync_ack,
            sync_api::sync_apply_nodes,
            sync_api::sync_apply_struct,
            sync_api::sync_doc_get,
            sync_api::sync_apply_doc,
            sync_api::sync_set_doc_cursor,
            sync_api::sync_record_error,
            comments_api::thread_create,
            comments_api::thread_list,
            comments_api::comment_add,
            comments_api::comment_edit,
            comments_api::comment_delete,
            comments_api::thread_resolve,
            comments_api::thread_delete,
            versions_api::version_create,
            versions_api::version_list,
            versions_api::version_get,
            versions_api::version_rename,
            versions_api::version_delete,
            media_api::media_put,
            media_api::media_get,
            habits_api::habit_log_list,
            habits_api::habit_log_set,
            reminders_api::reminders_due,
            reminders_api::reminder_ack,
            reminders_api::reminder_notify,
            database_api::node_get,
            database_api::db_create,
            database_api::db_get,
            database_api::db_rows,
            database_api::row_get,
            database_api::prop_create,
            database_api::prop_update,
            database_api::prop_delete,
            database_api::prop_move,
            database_api::view_create,
            database_api::view_update,
            database_api::view_delete,
            database_api::cells_set,
            database_api::row_create,
            database_api::rows_delete
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Slate");
}
