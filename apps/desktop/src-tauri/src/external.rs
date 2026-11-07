//! Ouverture d'un lien dans le navigateur ou le client de messagerie du système.
//! Le cœur revalide l'adresse (le WebView n'est pas digne de confiance) : seuls http, https et mailto sont ouverts.

use crate::error::{AppError, AppResult};

const MAX_URL: usize = 2_000;

pub fn validate(url: &str) -> AppResult<&str> {
    if url.is_empty()
        || url.len() > MAX_URL
        || url.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(AppError::Invalid("adresse invalide".into()));
    }
    let lower = url.to_ascii_lowercase();
    let ok = if let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        !host.is_empty() && !host.contains('@')
    } else if let Some(rest) = lower.strip_prefix("mailto:") {
        let addr = rest.split('?').next().unwrap_or("");
        matches!(addr.split_once('@'), Some((l, d)) if !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.'))
    } else {
        false
    };
    if ok {
        Ok(url)
    } else {
        Err(AppError::Invalid(
            "seuls les liens http, https et mailto peuvent être ouverts".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepte_http_https_et_mailto() {
        for u in [
            "https://example.com",
            "http://example.com/a?b#c",
            "HTTPS://EXAMPLE.COM",
            "mailto:ada@example.com",
            "mailto:ada@example.com?subject=x",
        ] {
            assert!(validate(u).is_ok(), "{u}");
        }
    }

    #[test]
    fn refuse_tout_le_reste() {
        for u in [
            "",
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "ftp://example.com",
            "tel:+33123456789",
            "https://",
            "https:///x",
            "https://user@example.com",
            "https://exa mple.com",
            "https://example.com/\n",
            "mailto:",
            "mailto:pas-une-adresse",
            "mailto:@example.com",
            "mailto:a@.com",
            "//example.com",
            "slate://page/x",
        ] {
            assert!(validate(u).is_err(), "{u:?}");
        }
        assert!(validate(&format!("https://example.com/{}", "a".repeat(2000))).is_err());
    }
}
