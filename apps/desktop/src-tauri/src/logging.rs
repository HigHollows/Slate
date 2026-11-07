//! Journalisation : fichier rotatif quotidien dans le dossier de logs de l'application.
//! Règle : ne jamais journaliser de contenu utilisateur ni de secret (identifiants, PIN, jetons).

use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

pub fn init(log_dir: &Path) -> Option<WorkerGuard> {
    if std::fs::create_dir_all(log_dir).is_err() {
        return None;
    }
    let appender = tracing_appender::rolling::daily(log_dir, "slate.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env("SLATE_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let file_layer = fmt::layer().with_writer(writer).with_ansi(false);
    let stderr_layer = fmt::layer().with_writer(std::io::stderr);
    // `try_init` : ne panique pas si un abonné existe déjà (tests).
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init();
    Some(guard)
}
