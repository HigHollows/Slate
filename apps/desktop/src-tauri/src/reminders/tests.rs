use super::*;
use crate::database::{create_database, create_property, create_row, set_cells, CellChange};
use crate::{db, tree};
use serde_json::{json, Map};
use tempfile::tempdir;

fn setup() -> (
    tempfile::TempDir,
    Connection,
    String,
    String,
    String,
    String,
) {
    let d = tempdir().unwrap();
    let c = db::open(d.path()).unwrap();
    let ws = tree::ensure_default_workspace(&c, "P").unwrap();
    let dbo = create_database(&c, &ws, None, "T", "Nom", "V")
        .unwrap()
        .node
        .id;
    let st = create_property(
        &c,
        &dbo,
        "S",
        "status",
        &json!({ "options": [
            { "id": "todo", "name": "a", "group": "todo" },
            { "id": "done", "name": "b", "group": "done" } ] }),
        None,
        None,
    )
    .unwrap();
    let rem = create_property(
        &c,
        &dbo,
        "R",
        "datetime",
        &json!({ "role": "reminder" }),
        None,
        None,
    )
    .unwrap();
    (d, c, dbo, st.id, rem.id, ws)
}
fn task(c: &Connection, db: &str, title: &str, st: &str, rem: &str, at: &str) -> String {
    let mut m = Map::new();
    m.insert(st.into(), json!("todo"));
    m.insert(rem.into(), json!(at));
    create_row(c, db, title, &m).unwrap().id
}

#[test]
fn echeances_acquittement_et_changement_d_heure() {
    let (_d, c, db, st, rem, _) = setup();
    let a = task(&c, &db, "Passé", &st, &rem, "2026-06-01T08:00:00Z");
    let _b = task(&c, &db, "Futur", &st, &rem, "2026-06-01T10:00:00Z");
    let now = "2026-06-01T09:00:00.000Z";
    let due = due_at(&c, now).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].title, "Passé");
    // acquitté : ne revient pas, y compris après « redémarrage » (c'est en base)
    ack(&c, &a, &rem, "2026-06-01T08:00:00Z").unwrap();
    ack(&c, &a, &rem, "2026-06-01T08:00:00Z").unwrap(); // idempotent
    assert!(due_at(&c, now).unwrap().is_empty());
    // le futur devient dû plus tard
    assert_eq!(due_at(&c, "2026-06-01T10:00:01.000Z").unwrap().len(), 1);
    // changer l'heure d'un rappel acquitté le refait sonner
    set_cells(
        &c,
        &[CellChange {
            row_id: a.clone(),
            property_id: rem.clone(),
            value: json!("2026-06-01T08:30:00Z"),
        }],
    )
    .unwrap();
    assert_eq!(due_at(&c, now).unwrap().len(), 1);
}

#[test]
fn ni_terminee_ni_corbeille_ni_horloge_invalide() {
    let (_d, c, db, st, rem, _) = setup();
    let a = task(&c, &db, "A", &st, &rem, "2026-06-01T08:00:00Z");
    let b = task(&c, &db, "B", &st, &rem, "2026-06-01T08:00:00Z");
    let now = "2026-06-01T09:00:00.000Z";
    assert_eq!(due_at(&c, now).unwrap().len(), 2);
    set_cells(
        &c,
        &[CellChange {
            row_id: a,
            property_id: st.clone(),
            value: json!("done"),
        }],
    )
    .unwrap();
    assert_eq!(due_at(&c, now).unwrap().len(), 1);
    tree::soft_delete(&c, &b).unwrap();
    assert!(due_at(&c, now).unwrap().is_empty());
    assert!(due_at(&c, "x").is_err());
}

#[test]
fn acquitter_un_instant_obsolete_ne_masque_pas_le_nouveau() {
    let (_d, c, db, st, rem, _) = setup();
    let a = task(&c, &db, "A", &st, &rem, "2026-06-01T08:00:00Z");
    set_cells(
        &c,
        &[CellChange {
            row_id: a.clone(),
            property_id: rem.clone(),
            value: json!("2026-06-01T08:45:00Z"),
        }],
    )
    .unwrap();
    ack(&c, &a, &rem, "2026-06-01T08:00:00Z").unwrap(); // ancien instant : ignoré
    assert_eq!(due_at(&c, "2026-06-01T09:00:00.000Z").unwrap().len(), 1);
}
