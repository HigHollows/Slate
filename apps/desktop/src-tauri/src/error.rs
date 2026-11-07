//! Erreur applicative unique, sérialisable vers le WebView.
//! Le front affiche `messageKey` (i18n) ; `detail` est un complément technique non sensible.

use serde::Serialize;

#[derive(Debug, Clone, thiserror::Error)]
pub enum AppError {
    #[error("la base a été créée par une version plus récente (schéma {found} > {supported})")]
    DbNewerThanApp { found: i64, supported: i64 },
    #[error("checksum de la migration {version} modifié")]
    MigrationChecksum { version: i64 },
    #[error("échec de la migration {version} : {reason}")]
    Migration { version: i64, reason: String },
    #[error("impossible d'ouvrir la base : {0}")]
    DbOpen(String),
    #[error("erreur base de données : {0}")]
    Db(String),
    #[error("erreur d'entrée/sortie : {0}")]
    Io(String),
    #[error("requête invalide : {0}")]
    Invalid(String),
    #[error("introuvable : {0}")]
    NotFound(String),
    #[error("application verrouillée")]
    Locked,
    #[error("PIN bloqué pendant {retry_after_ms} ms")]
    PinLocked { retry_after_ms: u64 },
    #[error("PIN incorrect ({failed} échec(s))")]
    PinInvalid { failed: i64 },
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DbNewerThanApp { .. } => "db.newer_than_app",
            Self::MigrationChecksum { .. } => "db.migration_checksum",
            Self::Migration { .. } => "db.migration_failed",
            Self::DbOpen(_) => "db.open",
            Self::Db(_) => "db.query",
            Self::Io(_) => "io",
            Self::Invalid(_) => "ipc.invalid",
            Self::NotFound(_) => "not_found",
            Self::Locked => "locked",
            Self::PinLocked { .. } => "pin.locked",
            Self::PinInvalid { .. } => "pin.invalid",
        }
    }
    pub fn message_key(&self) -> &'static str {
        match self {
            Self::DbNewerThanApp { .. } => "errors.db.newer",
            Self::MigrationChecksum { .. } => "errors.db.checksum",
            Self::Migration { .. } => "errors.db.migration",
            Self::DbOpen(_) => "errors.db.open",
            Self::Db(_) => "errors.unknown",
            Self::Io(_) => "errors.io",
            Self::Invalid(_) => "errors.ipc.invalid",
            Self::NotFound(_) => "errors.notFound",
            Self::Locked => "errors.locked",
            Self::PinLocked { .. } => "errors.pin.locked",
            Self::PinInvalid { .. } => "errors.pin.invalid",
        }
    }
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Io(_) | Self::Db(_))
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e.to_string())
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload<'a> {
    code: &'a str,
    message_key: &'a str,
    retryable: bool,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed_count: Option<i64>,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Payload {
            code: self.code(),
            message_key: self.message_key(),
            retryable: self.retryable(),
            detail: self.to_string(),
            retry_after_ms: match self {
                Self::PinLocked { retry_after_ms } => Some(*retry_after_ms),
                _ => None,
            },
            failed_count: match self {
                Self::PinInvalid { failed } => Some(*failed),
                _ => None,
            },
        }
        .serialize(s)
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialise_au_format_attendu_par_le_front() {
        let v = serde_json::to_value(AppError::Io("disque plein".into())).unwrap();
        assert_eq!(v["code"], "io");
        assert_eq!(v["messageKey"], "errors.io");
        assert_eq!(v["retryable"], true);
        assert!(v["detail"].as_str().unwrap().contains("disque plein"));
    }

    #[test]
    fn les_erreurs_de_schema_ne_sont_pas_reessayables() {
        assert!(!AppError::DbNewerThanApp {
            found: 9,
            supported: 1
        }
        .retryable());
        assert!(!AppError::MigrationChecksum { version: 1 }.retryable());
    }
}
