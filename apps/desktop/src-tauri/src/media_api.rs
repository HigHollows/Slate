//! Commandes IPC des médias (images). Refusées tant que l'application est verrouillée.

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::media;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    hash: String,
    mime: String,
    size: usize,
}

#[derive(Serialize)]
pub struct MediaData {
    data: String,
    mime: String,
}

fn dir(state: &AppState) -> AppResult<PathBuf> {
    if state.is_locked() {
        return Err(AppError::Locked);
    }
    let base = state
        .db_path
        .parent()
        .ok_or_else(|| AppError::Io("dossier de données introuvable".into()))?;
    Ok(base.join("media"))
}

#[tauri::command]
pub fn media_put(state: State<'_, AppState>, data: String) -> AppResult<MediaInfo> {
    let d = dir(&state)?;
    // Borne la taille AVANT de décoder (le base64 gonfle de 4/3).
    if data.len() > media::MAX_BYTES / 3 * 4 + 8 {
        return Err(AppError::Invalid(
            "image trop volumineuse (20 Mo maximum)".into(),
        ));
    }
    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|_| AppError::Invalid("données d'image invalides".into()))?;
    let s = media::put(&d, &bytes)?;
    Ok(MediaInfo {
        hash: s.hash,
        mime: s.mime.into(),
        size: s.size,
    })
}

#[tauri::command]
pub fn media_get(state: State<'_, AppState>, hash: String) -> AppResult<MediaData> {
    let d = dir(&state)?;
    let (bytes, mime) = media::get(&d, &hash)?;
    Ok(MediaData {
        data: B64.encode(bytes),
        mime: mime.into(),
    })
}
