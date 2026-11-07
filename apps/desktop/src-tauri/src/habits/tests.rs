use super::*;
use crate::database::{create_database, create_property, create_row};
use crate::{db, tree};
use serde_json::{json, Map};
use tempfile::tempdir;

fn setup() -> (tempfile::TempDir, Connection, String, String, String) {
    let d = tempdir().unwrap();
    let c = db::open(d.path()).unwrap();
    let ws = tree::ensure_default_workspace(&c, "P").unwrap();
    let dbo = create_database(&c, &ws, None, "H", "Nom", "V")
        .unwrap()
        .node
        .id;
    create_property(
        &c,
        &dbo,
        "Objectif",
        "number",
        &json!({ "role": "habit_goal" }),
        None,
        None,
    )
    .unwrap();
    let r = create_row(&c, &dbo, "Lire", &Map::new()).unwrap().id;
    (d, c, ws, dbo, r)
}

#[test]
fn pointer_est_idempotent_et_reversible() {
    let (_d, c, _ws, db, r) = setup();
    set(&c, &r, "2026-06-01", true, "2026-06-02").unwrap();
    set(&c, &r, "2026-06-01", true, "2026-06-02").unwrap();
    let l = list(&c, &db, "2026-05-01", "2026-06-30").unwrap();
    assert_eq!(
        l,
        vec![HabitDay {
            row_id: r.clone(),
            day: "2026-06-01".into()
        }]
    );
    set(&c, &r, "2026-06-01", false, "2026-06-02").unwrap();
    set(&c, &r, "2026-06-01", false, "2026-06-02").unwrap();
    assert!(list(&c, &db, "2026-05-01", "2026-06-30")
        .unwrap()
        .is_empty());
}

#[test]
fn refus_dates_invalides_futur_et_lignes_non_habitudes() {
    let (_d, c, ws, db, r) = setup();
    assert!(set(&c, &r, "2026-02-30", true, "2026-06-02").is_err());
    assert!(set(&c, &r, "pas une date", true, "2026-06-02").is_err());
    assert!(set(&c, &r, "2026-06-02", true, "x").is_err());
    assert!(
        set(&c, &r, "2026-06-10", true, "2026-06-02").is_err(),
        "futur lointain"
    );
    assert!(
        set(&c, &r, "2026-06-03", true, "2026-06-02").is_ok(),
        "demain toléré (fuseaux)"
    );
    let plain = create_database(&c, &ws, None, "Autre", "Nom", "V")
        .unwrap()
        .node
        .id;
    let other = create_row(&c, &plain, "X", &Map::new()).unwrap().id;
    assert!(set(&c, &other, "2026-06-01", true, "2026-06-02").is_err());
    assert!(list(&c, &db, "2026-06-30", "2026-06-01").is_err());
}

#[test]
fn les_lignes_supprimees_n_apparaissent_pas() {
    let (_d, c, _ws, db, r) = setup();
    set(&c, &r, "2026-06-01", true, "2026-06-02").unwrap();
    tree::soft_delete(&c, &r).unwrap();
    assert!(list(&c, &db, "2026-06-01", "2026-06-30")
        .unwrap()
        .is_empty());
}
