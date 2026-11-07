use super::*;
use crate::{db, tree};
use tempfile::tempdir;

const T1: &str = "0192f0a0-0000-7000-8000-000000000001";
const T2: &str = "0192f0a0-0000-7000-8000-000000000002";

fn setup() -> (tempfile::TempDir, Connection, String, String) {
    let d = tempdir().unwrap();
    let c = db::open(d.path()).unwrap();
    let ws = tree::ensure_default_workspace(&c, "P").unwrap();
    let page = tree::create_node(&c, &ws, None, "page", "P", None)
        .unwrap()
        .id;
    (d, c, ws, page)
}

#[test]
fn fil_complet_creation_reponse_modification_resolution() {
    let (_d, c, _ws, p) = setup();
    let t = create_thread(
        &c,
        T1,
        &p,
        "  le passage  ",
        "  Premier avis  ",
        Some("ada@example.com"),
    )
    .unwrap();
    assert_eq!(t.quote, "le passage");
    assert_eq!(t.comments.len(), 1);
    assert_eq!(t.comments[0].body, "Premier avis");
    assert_eq!(t.created_by.as_deref(), Some("ada@example.com"));
    let r = add_comment(&c, T1, "Réponse", None).unwrap();
    assert_eq!(r.author, None);
    let e = edit_comment(&c, &r.id, "Réponse corrigée").unwrap();
    assert_eq!(e.body, "Réponse corrigée");
    assert!(e.edited_at.is_some());
    let res = resolve(&c, T1, true, Some("ada@example.com")).unwrap();
    assert!(res.resolved_at.is_some());
    assert_eq!(res.resolved_by.as_deref(), Some("ada@example.com"));
    let re = resolve(&c, T1, false, None).unwrap();
    assert!(re.resolved_at.is_none() && re.resolved_by.is_none());
    assert_eq!(list(&c, &p).unwrap().len(), 1);
    assert_eq!(list(&c, &p).unwrap()[0].comments.len(), 2);
}

#[test]
fn supprimer_le_dernier_message_supprime_le_fil() {
    let (_d, c, _ws, p) = setup();
    create_thread(&c, T1, &p, "q", "un", None).unwrap();
    let second = add_comment(&c, T1, "deux", None).unwrap();
    assert!(!delete_comment(&c, &second.id).unwrap());
    let first = list(&c, &p).unwrap().remove(0).comments.remove(0);
    assert!(delete_comment(&c, &first.id).unwrap());
    assert!(list(&c, &p).unwrap().is_empty());
    assert!(delete_comment(&c, &first.id).is_err());
}

#[test]
fn supprimer_un_fil_entier_et_entrees_invalides() {
    let (_d, c, _ws, p) = setup();
    create_thread(&c, T1, &p, "q", "x", None).unwrap();
    add_comment(&c, T1, "y", None).unwrap();
    delete_thread(&c, T1).unwrap();
    let n: i64 = c
        .query_row("SELECT count(*) FROM comment", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "les messages suivent le fil");
    assert!(delete_thread(&c, T1).is_err());

    assert!(create_thread(&c, "pas-un-uuid", &p, "q", "x", None).is_err());
    assert!(create_thread(&c, &T2.to_uppercase(), &p, "q", "x", None).is_err());
    assert!(create_thread(&c, T2, &p, "q", "   ", None).is_err());
    assert!(create_thread(&c, T2, &p, "q", &"a".repeat(5001), None).is_err());
    assert!(create_thread(&c, T2, "inconnue", "q", "x", None).is_err());
    assert!(create_thread(&c, T2, &p, "q", "x", Some(&"a".repeat(321))).is_err());
    create_thread(&c, T2, &p, &"é".repeat(1000), "x", None).unwrap();
    assert_eq!(thread(&c, T2).unwrap().quote.chars().count(), 400);
    assert!(
        create_thread(&c, T2, &p, "q", "x", None).is_err(),
        "identifiant déjà utilisé"
    );
    assert!(add_comment(&c, "00000000-0000-0000-0000-000000000000", "x", None).is_err());
    assert!(edit_comment(&c, "inconnu", "x").is_err());
    assert!(resolve(&c, "00000000-0000-0000-0000-000000000000", true, None).is_err());
}

#[test]
fn page_dans_la_corbeille_refuse_et_purge_supprime_tout() {
    let (_d, c, _ws, p) = setup();
    create_thread(&c, T1, &p, "q", "x", None).unwrap();
    tree::soft_delete(&c, &p).unwrap();
    assert!(create_thread(&c, T2, &p, "q", "x", None).is_err());
    tree::purge(&c, &p).unwrap();
    let threads: i64 = c
        .query_row("SELECT count(*) FROM comment_thread", [], |r| r.get(0))
        .unwrap();
    let msgs: i64 = c
        .query_row("SELECT count(*) FROM comment", [], |r| r.get(0))
        .unwrap();
    assert_eq!((threads, msgs), (0, 0));
}

#[test]
fn les_fils_sont_isoles_par_page_et_ordonnes() {
    let (_d, c, ws, p) = setup();
    let q = tree::create_node(&c, &ws, None, "page", "Q", None)
        .unwrap()
        .id;
    create_thread(&c, T1, &p, "a", "x", None).unwrap();
    create_thread(&c, T2, &q, "b", "y", None).unwrap();
    assert_eq!(
        list(&c, &p)
            .unwrap()
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        vec![T1]
    );
    assert_eq!(
        list(&c, &q)
            .unwrap()
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        vec![T2]
    );
}
