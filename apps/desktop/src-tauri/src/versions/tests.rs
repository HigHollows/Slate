use super::*;
use crate::{content, db, tree};
use tempfile::tempdir;

fn setup() -> (tempfile::TempDir, Connection, String) {
    let d = tempdir().unwrap();
    let c = db::open(d.path()).unwrap();
    let ws = tree::ensure_default_workspace(&c, "P").unwrap();
    let page = tree::create_node(&c, &ws, None, "page", "P", None)
        .unwrap()
        .id;
    (d, c, page)
}
fn save(c: &Connection, id: &str, text: &str) {
    let json = format!(r#"{{"type":"doc","t":"{text}"}}"#);
    content::save(c, id, b"yjs", &json, text, &[]).unwrap();
}
fn age(c: &Connection, id: &str, secs: i64) {
    c.execute(
        "UPDATE page_version SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?2) WHERE id = ?1",
        params![id, format!("-{secs} seconds")],
    )
    .unwrap();
}

#[test]
fn premiere_version_auto_puis_au_plus_une_toutes_les_dix_minutes() {
    let (_d, c, p) = setup();
    save(&c, &p, "un");
    assert_eq!(list(&c, &p).unwrap().len(), 1);
    save(&c, &p, "deux"); // trop tôt
    save(&c, &p, "trois");
    assert_eq!(list(&c, &p).unwrap().len(), 1);
    let v = list(&c, &p).unwrap().remove(0);
    age(&c, &v.id, 601);
    save(&c, &p, "quatre");
    assert_eq!(list(&c, &p).unwrap().len(), 2);
    // contenu inchangé : pas de nouvelle version même après 10 minutes
    let newest = list(&c, &p).unwrap().remove(0);
    age(&c, &newest.id, 601);
    save(&c, &p, "quatre");
    assert_eq!(list(&c, &p).unwrap().len(), 2);
}

#[test]
fn page_vide_sans_version() {
    let (_d, c, p) = setup();
    save(&c, &p, "");
    assert!(list(&c, &p).unwrap().is_empty());
}

#[test]
fn manuelle_nommee_sans_doublon_et_lisible() {
    let (_d, c, p) = setup();
    save(&c, &p, "alpha beta gamma");
    let auto = list(&c, &p).unwrap().remove(0);
    let m = snapshot(
        &c,
        &p,
        "manual",
        Some("  Avant relecture  "),
        Some("ada@example.com"),
    )
    .unwrap();
    assert_eq!(
        m.id, auto.id,
        "contenu identique : la version existante est nommée"
    );
    assert_eq!(m.label.as_deref(), Some("Avant relecture"));
    assert_eq!(m.reason, "manual");
    assert_eq!(list(&c, &p).unwrap().len(), 1);
    save(&c, &p, "alpha beta gamma delta");
    let m2 = snapshot(&c, &p, "manual", None, None).unwrap();
    assert_ne!(m2.id, m.id);
    assert_eq!(m2.words, 4);
    let data = get(&c, &m.id).unwrap();
    assert!(data.content_json.contains("alpha"));
    assert_eq!(data.text_plain, "alpha beta gamma");
}

#[test]
fn entrees_invalides() {
    let (_d, c, p) = setup();
    save(&c, &p, "x");
    assert!(snapshot(&c, &p, "pirate", None, None).is_err());
    assert!(snapshot(&c, &p, "manual", Some(&"a".repeat(201)), None).is_err());
    assert!(snapshot(&c, "inconnu", "manual", None, None).is_err());
    assert!(get(&c, "nope").is_err());
    assert!(delete(&c, "nope").is_err());
    assert!(rename(&c, "nope", Some("x")).is_err());
}

#[test]
fn conservation_24h_puis_un_par_jour_puis_suppression() {
    let (_d, c, p) = setup();
    save(&c, &p, "base");
    let base = list(&c, &p).unwrap().remove(0).id;
    c.execute("DELETE FROM page_version WHERE id = ?1", [&base])
        .unwrap();
    let now = "2026-06-30T12:00:00.000Z";
    let put = |id: &str, at: &str, reason: &str| {
        c.execute(
            "INSERT INTO page_version (id, node_id, created_at, reason, doc_state, content_json, text_plain, bytes)
             VALUES (?1, ?2, ?3, ?4, x'00', ?1, 't', 1)",
            params![id, p, at, reason],
        )
        .unwrap();
    };
    put("recent1", "2026-06-30T11:00:00.000Z", "auto");
    put("recent2", "2026-06-30T03:00:00.000Z", "auto");
    put("jour1a", "2026-06-25T20:00:00.000Z", "auto");
    put("jour1b", "2026-06-25T08:00:00.000Z", "auto"); // même jour, plus ancienne : supprimée
    put("jour2", "2026-06-20T08:00:00.000Z", "auto");
    put("vieille", "2026-05-01T08:00:00.000Z", "auto"); // > 30 jours : supprimée
    put("manuelle", "2026-01-01T08:00:00.000Z", "manual"); // jamais supprimée
    put("restaur", "2026-01-02T08:00:00.000Z", "restore");
    let removed = prune_at(&c, &p, now).unwrap();
    assert_eq!(removed, 2);
    let ids: Vec<String> = list(&c, &p).unwrap().into_iter().map(|v| v.id).collect();
    for keep in [
        "recent1", "recent2", "jour1a", "jour2", "manuelle", "restaur",
    ] {
        assert!(ids.contains(&keep.to_string()), "{keep}");
    }
    for gone in ["jour1b", "vieille"] {
        assert!(!ids.contains(&gone.to_string()), "{gone}");
    }
}

#[test]
fn plafond_de_cent_automatiques() {
    let (_d, c, p) = setup();
    save(&c, &p, "x");
    let now = "2026-06-30T12:00:00.000Z";
    for i in 0..130 {
        c.execute(
            "INSERT INTO page_version (id, node_id, created_at, reason, doc_state, content_json, text_plain, bytes)
             VALUES (?1, ?2, ?3, 'auto', x'00', ?1, 't', 1)",
            params![format!("v{i:03}"), p, format!("2026-06-30T{:02}:{:02}:00.000Z", 11 - i / 60, i % 60)],
        )
        .unwrap();
    }
    prune_at(&c, &p, now).unwrap();
    let autos = list(&c, &p)
        .unwrap()
        .into_iter()
        .filter(|v| v.reason == "auto")
        .count();
    assert_eq!(autos, MAX_AUTO);
}

#[test]
fn supprimer_renommer_et_purge_de_la_page() {
    let (_d, c, p) = setup();
    save(&c, &p, "contenu");
    let v = list(&c, &p).unwrap().remove(0);
    rename(&c, &v.id, Some("Jalon")).unwrap();
    let r = get(&c, &v.id).unwrap().meta;
    assert_eq!(
        (r.label.as_deref(), r.reason.as_str()),
        (Some("Jalon"), "manual")
    );
    tree::soft_delete(&c, &p).unwrap();
    tree::purge(&c, &p).unwrap();
    assert!(
        get(&c, &v.id).is_err(),
        "les versions suivent la page purgée"
    );
    let (_d2, c2, p2) = setup();
    save(&c2, &p2, "z");
    let v2 = list(&c2, &p2).unwrap().remove(0);
    delete(&c2, &v2.id).unwrap();
    assert!(list(&c2, &p2).unwrap().is_empty());
}
