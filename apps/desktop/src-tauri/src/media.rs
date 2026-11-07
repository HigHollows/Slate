//! Stockage local des images du document : fichiers adressés par leur empreinte SHA-256 dans `<données>/media/`.
//! Jamais de base64 dans le document : il ne référence que `hash` (64 hexadécimaux).
//!
//! Sécurité : le type est déduit des OCTETS (pas du nom ni du type annoncé) ; seuls PNG, JPEG, GIF et WebP sont
//! acceptés (SVG refusé : il peut contenir du script) ; taille bornée ; l'empreinte est exigée en hexadécimal strict
//! (aucun chemin n'est jamais construit à partir d'une entrée libre) et revérifiée à la lecture.

use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_BYTES: usize = 20 * 1024 * 1024;
const EXTS: [&str; 4] = ["png", "jpg", "gif", "webp"];

pub fn sniff(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(("png", "image/png"))
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("jpg", "image/jpeg"))
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}

pub fn is_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        _ => "image/webp",
    }
}

pub struct Stored {
    pub hash: String,
    pub mime: &'static str,
    pub size: usize,
}

pub fn put(dir: &Path, bytes: &[u8]) -> AppResult<Stored> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(AppError::Invalid(
            "image vide ou trop volumineuse (20 Mo maximum)".into(),
        ));
    }
    let (ext, mime) = sniff(bytes).ok_or_else(|| {
        AppError::Invalid("format d'image non pris en charge (PNG, JPEG, GIF, WebP)".into())
    })?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    fs::create_dir_all(dir).map_err(|e| AppError::Io(e.to_string()))?;
    let target = dir.join(format!("{hash}.{ext}"));
    if !target.exists() {
        // Écriture atomique : fichier temporaire puis renommage.
        let tmp = dir.join(format!("{hash}.tmp"));
        fs::write(&tmp, bytes).map_err(|e| AppError::Io(e.to_string()))?;
        fs::rename(&tmp, &target).map_err(|e| AppError::Io(e.to_string()))?;
    }
    Ok(Stored {
        hash,
        mime,
        size: bytes.len(),
    })
}

fn find(dir: &Path, hash: &str) -> Option<(PathBuf, &'static str)> {
    EXTS.iter().find_map(|e| {
        let p = dir.join(format!("{hash}.{e}"));
        p.is_file().then_some((p, mime_of(e)))
    })
}

pub fn get(dir: &Path, hash: &str) -> AppResult<(Vec<u8>, &'static str)> {
    if !is_hash(hash) {
        return Err(AppError::Invalid("identifiant de média invalide".into()));
    }
    let (path, mime) =
        find(dir, hash).ok_or_else(|| AppError::NotFound(format!("média {hash}")))?;
    let bytes = fs::read(&path).map_err(|e| AppError::Io(e.to_string()))?;
    if format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err(AppError::Io(
            "fichier média altéré (empreinte différente)".into(),
        ));
    }
    Ok((bytes, mime))
}

#[cfg(test)]
mod tests;
