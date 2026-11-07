//! Coffre de session : le **jeton de rafraîchissement** Supabase est conservé dans le trousseau du système
//! (Keychain macOS, Gestionnaire d'identifiants Windows), jamais dans la base SQLite ni dans le WebView persistant.
//!
//! * Seul le jeton de rafraîchissement (court) est stocké : la limite de taille d'un identifiant Windows (~2,5 Ko)
//!   interdit d'y mettre toute la session, et le jeton d'accès (durée de vie courte) reste en mémoire.
//! * Aucun mot de passe n'est jamais stocké.
//! * Le contenu n'est jamais journalisé.

use crate::error::{AppError, AppResult};
use keyring::Entry;

const SERVICE: &str = "app.slate.desktop";
const ACCOUNT: &str = "supabase-refresh-token";
const MAX_LEN: usize = 1_000;

#[cfg(not(test))]
fn entry() -> AppResult<Entry> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Io(format!("trousseau indisponible : {e}")))
}

/// Tests : le trousseau factice ne partage pas son état entre deux `Entry` ; on réutilise donc une seule instance.
#[cfg(test)]
fn entry() -> AppResult<&'static Entry> {
    static E: std::sync::OnceLock<Entry> = std::sync::OnceLock::new();
    Ok(E.get_or_init(|| Entry::new(SERVICE, ACCOUNT).expect("entrée factice")))
}

pub fn save(token: &str) -> AppResult<()> {
    if token.is_empty() || token.len() > MAX_LEN || token.chars().any(|c| c.is_control()) {
        return Err(AppError::Invalid("jeton de session invalide".into()));
    }
    entry()?
        .set_password(token)
        .map_err(|e| AppError::Io(format!("écriture dans le trousseau impossible : {e}")))
}

/// `None` si rien n'est stocké.
pub fn load() -> AppResult<Option<String>> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Io(format!(
            "lecture du trousseau impossible : {e}"
        ))),
    }
}

/// Idempotent : effacer l'absence de jeton n'est pas une erreur.
pub fn clear() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Io(format!(
            "effacement du trousseau impossible : {e}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    static INIT: Once = Once::new();
    /// Trousseau factice en mémoire (le vrai trousseau du développeur n'est jamais touché par les tests).
    fn mock() {
        INIT.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder())
        });
    }

    #[test]
    fn aller_retour_et_effacement_idempotent() {
        mock();
        clear().unwrap();
        clear().unwrap();
        save("refresh-token-abc").unwrap();
        assert_eq!(load().unwrap().as_deref(), Some("refresh-token-abc"));
        save("autre-jeton").unwrap();
        assert_eq!(
            load().unwrap().as_deref(),
            Some("autre-jeton"),
            "remplacement"
        );
        clear().unwrap();
        assert_eq!(load().unwrap(), None);
    }

    #[test]
    fn refuse_les_valeurs_vides_trop_longues_ou_avec_caracteres_de_controle() {
        mock();
        assert!(save("").is_err());
        assert!(save(&"x".repeat(MAX_LEN + 1)).is_err());
        assert!(save("a\nb").is_err());
        assert!(save(&"x".repeat(MAX_LEN)).is_ok());
    }
}
