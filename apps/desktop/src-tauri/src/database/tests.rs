use super::*;
use crate::db::{self, migrations::MIGRATIONS};
use crate::{content, search};
use tempfile::{tempdir, TempDir};

fn setup() -> (TempDir, Connection, String) {
    let d = tempdir().unwrap();
    let c = db::open(d.path()).unwrap();
    let ws = tree::ensure_default_workspace(&c, "P").unwrap();
    (d, c, ws)
}
fn mkdb(c: &Connection, ws: &str, title: &str) -> DatabaseOut {
    create_database(c, ws, None, title, "Nom", "Tableau").unwrap()
}
fn prop(c: &Connection, db: &str, name: &str, kind: &str, cfg: Value) -> PropertyOut {
    create_property(c, db, name, kind, &cfg, None, None).unwrap()
}
fn opts(names: &[&str]) -> Value {
    json!({ "options": names.iter().map(|n| json!({ "name": n })).collect::<Vec<_>>() })
}
fn set(c: &Connection, row: &str, p: &str, v: Value) -> AppResult<Vec<RowOut>> {
    set_cells(
        c,
        &[CellChange {
            row_id: row.into(),
            property_id: p.into(),
            value: v,
        }],
    )
}
fn newrow(c: &Connection, db: &str, t: &str) -> RowOut {
    create_row(c, db, t, &Map::new()).unwrap()
}

// ── Migration 0003 ────────────────────────────────────────────────────────────
/// Données écrites en SQL brut dans un schéma v2 (les fonctions applicatives supposent le schéma courant).
fn seed_v2(c: &Connection) -> (String, String, String) {
    let ts = "2026-01-01T00:00:00.000Z";
    c.execute(
        "INSERT INTO workspace (id, name, created_at, updated_at) VALUES ('w1', 'P', ?1, ?1)",
        [ts],
    )
    .unwrap();
    for (id, parent, title, pos, fav) in [
        ("a", None, "Alpha", "V0000000", 0),
        ("b", Some("a"), "Beta", "V0000001", 1),
        ("old", None, "Ancienne clé", "V", 0),
    ] {
        c.execute(
            "INSERT INTO node (id, workspace_id, parent_id, kind, title, position, is_favorite, created_at, updated_at)
             VALUES (?1, 'w1', ?2, 'page', ?3, ?4, ?5, ?6, ?6)",
            params![id, parent, title, pos, fav, ts],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO page_content (node_id, doc_state, content_json, text_plain, updated_at)
         VALUES ('a', x'6574', '{\"type\":\"doc\"}', 'texte précieux', ?1)",
        [ts],
    )
    .unwrap();
    c.execute(
        "INSERT INTO link (source_id, target_id) VALUES ('a', 'b')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO recent (node_id, opened_at) VALUES ('a', ?1)",
        [ts],
    )
    .unwrap();
    c.execute(
        "INSERT INTO search_index (node_id, title, body) VALUES ('a', 'Alpha', 'texte précieux')",
        [],
    )
    .unwrap();
    c.execute("UPDATE node SET deleted_at = ?1 WHERE id = 'old'", [ts])
        .unwrap();
    ("a".into(), "b".into(), "w1".into())
}

#[test]
fn migration_v3_conserve_toutes_les_donnees_existantes() {
    let d = tempdir().unwrap();
    {
        let c = db::open_with(d.path(), &MIGRATIONS[..2]).unwrap();
        seed_v2(&c);
    }
    let c = db::open(d.path()).unwrap();
    let (a, b, ws) = ("a".to_string(), "b".to_string(), "w1".to_string());
    assert_eq!(
        db::schema_version(&c).unwrap(),
        db::migrations::latest_version(MIGRATIONS)
    );
    assert!(db::integrity_ok(&c).unwrap());
    // Les ON DELETE CASCADE n'ont pas été déclenchés par la reconstruction de `node`.
    assert_eq!(
        content::get(&c, &a).unwrap().unwrap().doc_state,
        vec![0x65u8, 0x74]
    );
    assert_eq!(content::backlinks(&c, &b).unwrap().len(), 1);
    assert_eq!(tree::list_recent(&c, &ws, 5).unwrap().len(), 1);
    assert!(tree::get(&c, &b).unwrap().is_favorite);
    assert_eq!(
        tree::get(&c, &b).unwrap().parent_id.as_deref(),
        Some(a.as_str())
    );
    assert_eq!(
        tree::get(&c, "old").unwrap().deleted_at.as_deref(),
        Some("2026-01-01T00:00:00.000Z"),
        "la corbeille est conservée"
    );
    assert_eq!(
        tree::get(&c, "old").unwrap().position,
        "V",
        "anciennes positions inchangées"
    );
    assert_eq!(search::search(&c, &ws, "precieux", 5).unwrap().len(), 1);
    let fk: i64 = c
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1, "clés étrangères réactivées après la migration");
    let nbad: i64 = c
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(nbad, 0);
    // Les index de `node` ont été recréés.
    let idx: i64 = c.query_row("SELECT count(*) FROM sqlite_master WHERE type='index' AND name IN ('node_tree','node_favorite','node_trashed','node_children')", [], |r| r.get(0)).unwrap();
    assert_eq!(idx, 4);
    // Le nouveau type est accepté, les inconnus toujours refusés, et l'ancien contenu reste utilisable.
    assert!(tree::create_node(&c, &ws, None, "database", "Base", None).is_ok());
    assert!(tree::create_node(&c, &ws, None, "inconnu", "x", None).is_err());
    assert!(tree::create_node(&c, &ws, Some(&a), "page", "Gamma", None).is_ok());
    content::save(&c, &a, b"nouveau", "{\"type\":\"doc\"}", "texte", &[]).unwrap();
}

#[test]
fn migration_v3_echec_laisse_la_base_en_v2_intacte_et_reactive_les_cles_etrangeres() {
    let d = tempdir().unwrap();
    {
        let c = db::open_with(d.path(), &MIGRATIONS[..2]).unwrap();
        seed_v2(&c);
    }
    let mut broken: Vec<db::migrations::Migration> = vec![
        db::migrations::Migration {
            version: 1,
            name: "init",
            sql: MIGRATIONS[0].sql,
        },
        db::migrations::Migration {
            version: 2,
            name: "pages",
            sql: MIGRATIONS[1].sql,
        },
    ];
    broken.push(db::migrations::Migration {
        version: 3,
        name: "cassée",
        sql: "-- slate:foreign_keys=off\nDELETE FROM page_content; INSERT INTO table_inexistante VALUES (1);",
    });
    assert!(db::open_with(d.path(), &broken).is_err());
    let c = db::open_with(d.path(), &MIGRATIONS[..2]).unwrap();
    assert_eq!(db::schema_version(&c).unwrap(), 2);
    let n: i64 = c
        .query_row("SELECT count(*) FROM page_content", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "rien n'a été supprimé malgré l'échec");
    let fk: i64 = c
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
}

#[test]
fn migration_v3_detecte_une_violation_de_cle_etrangere() {
    let d = tempdir().unwrap();
    {
        let c = db::open_with(d.path(), &MIGRATIONS[..2]).unwrap();
        seed_v2(&c);
    }
    let mut bad: Vec<db::migrations::Migration> = vec![
        db::migrations::Migration {
            version: 1,
            name: "init",
            sql: MIGRATIONS[0].sql,
        },
        db::migrations::Migration {
            version: 2,
            name: "pages",
            sql: MIGRATIONS[1].sql,
        },
    ];
    bad.push(db::migrations::Migration {
        version: 3,
        name: "orphelin",
        sql: "-- slate:foreign_keys=off\nINSERT INTO link (source_id, target_id) VALUES ('fantome', 'a');",
    });
    let r = db::open_with(d.path(), &bad);
    assert!(
        matches!(r, Err(AppError::Migration { version: 3, .. })),
        "{r:?}"
    );
    let c = db::open_with(d.path(), &MIGRATIONS[..2]).unwrap();
    assert_eq!(db::schema_version(&c).unwrap(), 2);
}

#[test]
fn migration_v3_pre_sauvegarde_creee_et_contient_l_etat_v2() {
    let d = tempdir().unwrap();
    {
        let c = db::open_with(d.path(), &MIGRATIONS[..2]).unwrap();
        seed_v2(&c);
    }
    drop(db::open(d.path()).unwrap());
    let backups: Vec<_> = std::fs::read_dir(d.path().join("backups"))
        .unwrap()
        .collect();
    assert_eq!(backups.len(), 1);
    let b = Connection::open(backups[0].as_ref().unwrap().path()).unwrap();
    assert_eq!(db::schema_version(&b).unwrap(), 2);
    let n: i64 = b
        .query_row("SELECT count(*) FROM node", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 3);
}

// ── Transactions imbriquées ──────────────────────────────────────────────────
#[test]
fn transaction_imbriquee_annule_tout_en_cas_d_echec_interne() {
    let (_d, c, ws) = setup();
    let outer = begin(&c).unwrap();
    tree::create_node(&outer, &ws, None, "page", "garde-moi", None).unwrap();
    {
        let inner = begin(&outer).unwrap();
        tree::create_node(&inner, &ws, None, "page", "annule-moi", None).unwrap();
        drop(inner); // pas de commit
    }
    outer.commit().unwrap();
    let titles: Vec<String> = tree::list_tree(&c, &ws)
        .unwrap()
        .into_iter()
        .map(|n| n.title)
        .collect();
    assert_eq!(titles, vec!["garde-moi"]);
}

// ── Base, propriétés, vues ────────────────────────────────────────────────────
#[test]
fn creation_d_une_base_avec_titre_et_vue_par_defaut() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "Contacts");
    assert_eq!(d.node.kind, "database");
    assert_eq!(d.properties.len(), 1);
    assert_eq!(d.properties[0].kind, "title");
    assert_eq!(d.views.len(), 1);
    assert_eq!(d.views[0].layout, "table");
}

#[test]
fn echec_a_mi_creation_ne_laisse_rien() {
    let (_d, c, ws) = setup();
    let r = create_database(&c, &ws, None, "x", "   ", "Tableau"); // nom de colonne vide => échec après création du nœud
    assert!(r.is_err());
    assert!(
        tree::list_tree(&c, &ws).unwrap().is_empty(),
        "le nœud créé doit être annulé"
    );
}

#[test]
fn proprietes_noms_uniques_types_et_limites() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    prop(&c, &d.node.id, "Prix", "number", json!({}));
    assert!(
        create_property(&c, &d.node.id, "prix", "text", &json!({}), None, None).is_err(),
        "nom unique insensible à la casse"
    );
    assert!(create_property(&c, &d.node.id, "X", "inconnu", &json!({}), None, None).is_err());
    assert!(create_property(&c, &d.node.id, "T2", "title", &json!({}), None, None).is_err());
    assert!(create_property(&c, &d.node.id, "  ", "text", &json!({}), None, None).is_err());
    assert!(create_property(&c, "absent", "X", "text", &json!({}), None, None).is_err());
}

#[test]
fn ordre_des_colonnes_et_deplacement() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let a = prop(&c, &d.node.id, "A", "text", json!({}));
    let b = prop(&c, &d.node.id, "B", "text", json!({}));
    let names = |c: &Connection| {
        properties(c, &d.node.id)
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&c), vec!["Nom", "A", "B"]);
    move_property(&c, &b.id, Some(&a.id)).unwrap();
    assert_eq!(names(&c), vec!["Nom", "B", "A"]);
    move_property(&c, &b.id, None).unwrap();
    assert_eq!(names(&c), vec!["Nom", "A", "B"]);
}

#[test]
fn options_normalisees_et_validees() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let p = prop(&c, &d.node.id, "Tags", "multiselect", opts(&["a", "b"]));
    let o = p.config["options"].as_array().unwrap();
    assert_eq!(o.len(), 2);
    assert!(o[0]["id"].as_str().unwrap().len() >= 8);
    assert_eq!(o[0]["color"], "gray");
    assert!(
        create_property(
            &c,
            &d.node.id,
            "T2",
            "select",
            &opts(&["x", "X"]),
            None,
            None
        )
        .is_err(),
        "doublon insensible à la casse"
    );
    assert!(create_property(
        &c,
        &d.node.id,
        "T3",
        "select",
        &json!({"options":[{"name":"a","color":"fuchsia"}]}),
        None,
        None
    )
    .is_err());
    assert!(create_property(
        &c,
        &d.node.id,
        "T4",
        "select",
        &json!({"options":[{"id":"a b","name":"a"}]}),
        None,
        None
    )
    .is_err());
}

#[test]
fn statut_a_des_options_par_defaut_groupees() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let p = prop(&c, &d.node.id, "Statut", "status", json!({}));
    let groups: Vec<&str> = p.config["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["group"].as_str().unwrap())
        .collect();
    assert_eq!(groups, vec!["todo", "doing", "done"]);
}

// ── Valeurs : validation par type ────────────────────────────────────────────
#[test]
fn validation_des_valeurs_par_type() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let id = &d.node.id;
    let r = newrow(&c, id, "L1");
    let ok = |p: &PropertyOut, v: Value| set(&c, &r.id, &p.id, v).unwrap();
    let ko = |p: &PropertyOut, v: Value| {
        assert!(
            set(&c, &r.id, &p.id, v.clone()).is_err(),
            "{} devrait refuser {v}",
            p.kind
        )
    };

    let t = prop(&c, id, "t", "text", json!({}));
    ok(&t, json!("bonjour"));
    ko(&t, json!(12));
    ko(&t, json!("x".repeat(10_001)));
    ko(&t, json!("a\u{0}b"));

    let n = prop(&c, id, "n", "number", json!({}));
    ok(&n, json!(12.5));
    ko(&n, json!("12"));
    ko(&n, json!(1e16));

    let ck = prop(&c, id, "ck", "checkbox", json!({}));
    ok(&ck, json!(true));
    ko(&ck, json!("oui"));

    let dt = prop(&c, id, "dt", "date", json!({}));
    ok(&dt, json!("2024-02-29"));
    ko(&dt, json!("2023-02-29"));
    ko(&dt, json!("2024-13-01"));
    ko(&dt, json!("24-1-1"));
    ko(&dt, json!("2024-01-01T10:00:00Z"));

    let dtt = prop(&c, id, "dtt", "datetime", json!({}));
    let out = ok(&dtt, json!("2024-05-06T07:08Z"));
    assert_eq!(out[0].props[&dtt.id], "2024-05-06T07:08:00Z");
    ko(&dtt, json!("2024-05-06T25:00:00Z"));
    ko(&dtt, json!("2024-05-06T07:08:00+02:00"));
    ko(&dtt, json!("2024-05-06"));

    let u = prop(&c, id, "u", "url", json!({}));
    ok(&u, json!("https://exemple.org/a?b=1"));
    ko(&u, json!("javascript:alert(1)"));
    ko(&u, json!("ftp://x.org/f"));
    ko(&u, json!("https://a b.org"));

    let e = prop(&c, id, "e", "email", json!({}));
    ok(&e, json!("a@b.fr"));
    ko(&e, json!("a@@b.fr"));
    ko(&e, json!("a b@c.fr"));
    ko(&e, json!("a@b"));

    let ph = prop(&c, id, "ph", "phone", json!({}));
    ok(&ph, json!("+33 6 12-34-56-78"));
    ko(&ph, json!("appelez-moi"));

    let s = prop(&c, id, "s", "select", opts(&["x", "y"]));
    let sid = s.config["options"][0]["id"].as_str().unwrap().to_string();
    ok(&s, json!(sid));
    ko(&s, json!("n-existe-pas"));
    ko(&s, json!(["a"]));

    let m = prop(&c, id, "m", "multiselect", opts(&["x", "y"]));
    let (m0, m1) = (
        m.config["options"][0]["id"].as_str().unwrap().to_string(),
        m.config["options"][1]["id"].as_str().unwrap().to_string(),
    );
    let out = ok(&m, json!([m0, m1, m0]));
    assert_eq!(
        out[0].props[&m.id].as_array().unwrap().len(),
        2,
        "doublons retirés"
    );
    ko(&m, json!(["inconnu"]));
    ko(&m, json!("x"));
}

#[test]
fn effacer_une_valeur_la_retire() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let t = prop(&c, &d.node.id, "t", "text", json!({}));
    let r = newrow(&c, &d.node.id, "L");
    set(&c, &r.id, &t.id, json!("x")).unwrap();
    let out = set(&c, &r.id, &t.id, Value::Null).unwrap();
    assert!(out[0].props.get(&t.id).is_none());
    let out = set(&c, &r.id, &t.id, json!("")).unwrap();
    assert!(out[0].props.get(&t.id).is_none(), "texte vide = effacé");
}

#[test]
fn proprietes_calculees_non_editables() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let r = newrow(&c, &d.node.id, "L");
    for k in ["formula", "created_time", "last_edited_time", "id"] {
        let p = prop(&c, &d.node.id, k, k, json!({}));
        assert!(set(&c, &r.id, &p.id, json!(1)).is_err(), "{k}");
    }
    let title = properties(&c, &d.node.id)
        .unwrap()
        .into_iter()
        .find(|p| p.kind == "title")
        .unwrap();
    assert!(
        set(&c, &r.id, &title.id, json!("x")).is_err(),
        "le titre se modifie via le renommage"
    );
}

#[test]
fn propriete_d_une_autre_base_ou_inconnue_refusee() {
    let (_d, c, ws) = setup();
    let a = mkdb(&c, &ws, "A");
    let b = mkdb(&c, &ws, "B");
    let pb = prop(&c, &b.node.id, "t", "text", json!({}));
    let ra = newrow(&c, &a.node.id, "L");
    assert!(set(&c, &ra.id, &pb.id, json!("x")).is_err());
    assert!(set(&c, &ra.id, "inconnue", json!("x")).is_err());
    assert!(set(&c, "ligne-inconnue", &pb.id, json!("x")).is_err());
    assert!(set_cells(&c, &[]).is_err());
}

#[test]
fn lot_de_modifications_atomique() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let n = prop(&c, &d.node.id, "n", "number", json!({}));
    let r1 = newrow(&c, &d.node.id, "1");
    let r2 = newrow(&c, &d.node.id, "2");
    let changes = [
        CellChange {
            row_id: r1.id.clone(),
            property_id: n.id.clone(),
            value: json!(1),
        },
        CellChange {
            row_id: r2.id.clone(),
            property_id: n.id.clone(),
            value: json!("pas un nombre"),
        },
    ];
    assert!(set_cells(&c, &changes).is_err());
    assert!(
        row(&c, &r1.id).unwrap().props.get(&n.id).is_none(),
        "la première modification est annulée avec la seconde"
    );
}

// ── Lignes ───────────────────────────────────────────────────────────────────
#[test]
fn lignes_ordre_titre_et_absence_dans_l_arbre() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    newrow(&c, &d.node.id, "Premier");
    newrow(&c, &d.node.id, "Deuxième");
    let titles: Vec<String> = rows(&c, &d.node.id)
        .unwrap()
        .into_iter()
        .map(|r| r.title)
        .collect();
    assert_eq!(titles, vec!["Premier", "Deuxième"]);
    let tree_titles: Vec<String> = tree::list_tree(&c, &ws)
        .unwrap()
        .into_iter()
        .map(|n| n.title)
        .collect();
    assert_eq!(
        tree_titles,
        vec!["B"],
        "les lignes n'encombrent pas la barre latérale"
    );
}

#[test]
fn creation_de_ligne_avec_valeurs_initiales_invalides_n_en_cree_pas() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let n = prop(&c, &d.node.id, "n", "number", json!({}));
    let mut init = Map::new();
    init.insert(n.id.clone(), json!("abc"));
    assert!(create_row(&c, &d.node.id, "L", &init).is_err());
    assert!(rows(&c, &d.node.id).unwrap().is_empty());
    let mut init = Map::new();
    init.insert(n.id, json!(5));
    assert_eq!(
        create_row(&c, &d.node.id, "L", &init)
            .unwrap()
            .props
            .as_object()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn identifiants_automatiques_croissants_et_retroactifs() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let r1 = newrow(&c, &d.node.id, "1");
    let r2 = newrow(&c, &d.node.id, "2");
    let idp = prop(&c, &d.node.id, "N°", "id", json!({ "prefix": "T-" }));
    let r3 = newrow(&c, &d.node.id, "3");
    let get = |r: &RowOut| row(&c, &r.id).unwrap().props[&idp.id].as_i64().unwrap();
    assert_eq!(
        (get(&r1), get(&r2), get(&r3)),
        (1, 2, 3),
        "lignes existantes numérotées dans l'ordre"
    );
    delete_rows(&c, std::slice::from_ref(&r3.id)).unwrap();
    let r4 = newrow(&c, &d.node.id, "4");
    assert_eq!(get(&r4), 4, "un numéro n'est jamais réutilisé");
}

#[test]
fn suppression_et_restauration_de_lignes() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let r = newrow(&c, &d.node.id, "L");
    let t = prop(&c, &d.node.id, "t", "text", json!({}));
    set(&c, &r.id, &t.id, json!("valeur")).unwrap();
    assert_eq!(delete_rows(&c, std::slice::from_ref(&r.id)).unwrap(), 1);
    assert!(rows(&c, &d.node.id).unwrap().is_empty());
    assert!(delete_rows(&c, &["pas-une-ligne".into()]).is_err());
    assert!(
        delete_rows(&c, std::slice::from_ref(&d.node.id)).is_err(),
        "une base n'est pas une ligne"
    );
    tree::restore(&c, &r.id).unwrap();
    assert_eq!(rows(&c, &d.node.id).unwrap()[0].props[&t.id], "valeur");
}

#[test]
fn supprimer_une_base_met_ses_lignes_a_la_corbeille_et_la_restauration_les_rend() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    newrow(&c, &d.node.id, "L1");
    let r2 = newrow(&c, &d.node.id, "L2");
    assert_eq!(tree::soft_delete(&c, &d.node.id).unwrap(), 3);
    assert!(rows(&c, &d.node.id).is_err());
    assert!(
        tree::restore(&c, &r2.id).is_err(),
        "une ligne ne se restaure pas sans sa base"
    );
    tree::restore(&c, &d.node.id).unwrap();
    assert_eq!(rows(&c, &d.node.id).unwrap().len(), 2);
    assert_eq!(tree::list_trash(&c, &ws).unwrap().len(), 0);
}

#[test]
fn purge_d_une_base_supprime_tout_son_contenu() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    prop(&c, &d.node.id, "t", "text", json!({}));
    newrow(&c, &d.node.id, "L1");
    tree::soft_delete(&c, &d.node.id).unwrap();
    tree::purge(&c, &d.node.id).unwrap();
    for t in ["db_row", "db_property", "db_view", "db_meta", "node"] {
        let n: i64 = c
            .query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{t}");
    }
}

#[test]
fn sous_pages_interdites_sous_une_base_ou_une_ligne() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let r = newrow(&c, &d.node.id, "L");
    assert!(tree::create_node(&c, &ws, Some(&d.node.id), "page", "x", None).is_err());
    assert!(tree::create_node(&c, &ws, Some(&r.id), "page", "x", None).is_err());
    let p = tree::create_node(&c, &ws, None, "page", "libre", None).unwrap();
    assert!(tree::move_node(&c, &p.id, Some(&d.node.id), None).is_err());
    assert!(tree::move_node(&c, &p.id, Some(&r.id), None).is_err());
    // Une base peut en revanche vivre dans un dossier, avec ses lignes.
    let f = tree::create_node(&c, &ws, None, "folder", "F", None).unwrap();
    assert!(tree::move_node(&c, &d.node.id, Some(&f.id), None).is_ok());
}

// ── Relations ────────────────────────────────────────────────────────────────
#[test]
fn relation_a_double_sens_maintient_les_deux_cotes() {
    let (_d, c, ws) = setup();
    let projets = mkdb(&c, &ws, "Projets");
    let taches = mkdb(&c, &ws, "Tâches");
    let rel = create_property(
        &c,
        &taches.node.id,
        "Projet",
        "relation",
        &json!({ "targetDatabaseId": projets.node.id }),
        None,
        Some("Tâches liées"),
    )
    .unwrap();
    let rev_id = rel.config["reversePropertyId"]
        .as_str()
        .unwrap()
        .to_string();
    let rev = property(&c, &rev_id).unwrap();
    assert_eq!(rev.database_id, projets.node.id);
    assert_eq!(rev.config["reversePropertyId"], json!(rel.id));

    let p1 = newrow(&c, &projets.node.id, "P1");
    let p2 = newrow(&c, &projets.node.id, "P2");
    let t1 = newrow(&c, &taches.node.id, "T1");

    let out = set(&c, &t1.id, &rel.id, json!([p1.id])).unwrap();
    assert_eq!(out.len(), 2, "la ligne modifiée et la ligne liée");
    assert_eq!(row(&c, &p1.id).unwrap().props[&rev_id], json!([t1.id]));

    set(&c, &t1.id, &rel.id, json!([p2.id])).unwrap();
    assert!(
        row(&c, &p1.id).unwrap().props.get(&rev_id).is_none(),
        "ancien lien retiré"
    );
    assert_eq!(row(&c, &p2.id).unwrap().props[&rev_id], json!([t1.id]));

    // Éditer depuis l'autre côté met à jour le premier.
    set(&c, &p1.id, &rev_id, json!([t1.id])).unwrap();
    assert!(row(&c, &t1.id).unwrap().props[&rel.id]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == &json!(p1.id)));

    set(&c, &t1.id, &rel.id, Value::Null).unwrap();
    assert!(row(&c, &p2.id).unwrap().props.get(&rev_id).is_none());
}

#[test]
fn relation_refuse_une_ligne_d_une_autre_base_ou_supprimee() {
    let (_d, c, ws) = setup();
    let a = mkdb(&c, &ws, "A");
    let b = mkdb(&c, &ws, "B");
    let autre = mkdb(&c, &ws, "Autre");
    let rel = prop(
        &c,
        &a.node.id,
        "vers B",
        "relation",
        json!({ "targetDatabaseId": b.node.id }),
    );
    let ra = newrow(&c, &a.node.id, "ra");
    let rb = newrow(&c, &b.node.id, "rb");
    let rautre = newrow(&c, &autre.node.id, "ro");
    assert!(
        set(&c, &ra.id, &rel.id, json!([rautre.id])).is_err(),
        "mauvaise base"
    );
    assert!(set(&c, &ra.id, &rel.id, json!(["id-forgé"])).is_err());
    assert!(set(&c, &ra.id, &rel.id, json!([rb.id])).is_ok());
    delete_rows(&c, std::slice::from_ref(&rb.id)).unwrap();
    assert!(
        set(&c, &ra.id, &rel.id, json!([rb.id])).is_err(),
        "ligne dans la corbeille"
    );
}

#[test]
fn relation_cible_inconnue_ou_non_modifiable() {
    let (_d, c, ws) = setup();
    let a = mkdb(&c, &ws, "A");
    let b = mkdb(&c, &ws, "B");
    let page = tree::create_node(&c, &ws, None, "page", "p", None).unwrap();
    assert!(create_property(&c, &a.node.id, "r", "relation", &json!({}), None, None).is_err());
    assert!(create_property(
        &c,
        &a.node.id,
        "r",
        "relation",
        &json!({ "targetDatabaseId": page.id }),
        None,
        None
    )
    .is_err());
    let r = prop(
        &c,
        &a.node.id,
        "r",
        "relation",
        json!({ "targetDatabaseId": b.node.id }),
    );
    assert!(update_property(
        &c,
        &r.id,
        None,
        Some(&json!({ "targetDatabaseId": a.node.id })),
        None
    )
    .is_err());
}

#[test]
fn supprimer_une_relation_detache_le_cote_inverse() {
    let (_d, c, ws) = setup();
    let a = mkdb(&c, &ws, "A");
    let b = mkdb(&c, &ws, "B");
    let rel = create_property(
        &c,
        &a.node.id,
        "vers B",
        "relation",
        &json!({ "targetDatabaseId": b.node.id }),
        None,
        Some("vers A"),
    )
    .unwrap();
    let rev_id = rel.config["reversePropertyId"]
        .as_str()
        .unwrap()
        .to_string();
    delete_property(&c, &rel.id).unwrap();
    assert!(property(&c, &rev_id)
        .unwrap()
        .config
        .get("reversePropertyId")
        .is_none());
}

#[test]
fn auto_relation_double_sens_dans_la_meme_base() {
    let (_d, c, ws) = setup();
    let a = mkdb(&c, &ws, "A");
    let rel = create_property(
        &c,
        &a.node.id,
        "Parent",
        "relation",
        &json!({ "targetDatabaseId": a.node.id }),
        None,
        Some("Enfants"),
    )
    .unwrap();
    let rev_id = rel.config["reversePropertyId"]
        .as_str()
        .unwrap()
        .to_string();
    let p = newrow(&c, &a.node.id, "p");
    let e = newrow(&c, &a.node.id, "e");
    set(&c, &e.id, &rel.id, json!([p.id])).unwrap();
    assert_eq!(row(&c, &p.id).unwrap().props[&rev_id], json!([e.id]));
}

// ── Évolution du schéma ──────────────────────────────────────────────────────
#[test]
fn suppression_d_une_propriete_reversible_cote_donnees() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let t = prop(&c, &d.node.id, "t", "text", json!({}));
    let r = newrow(&c, &d.node.id, "L");
    set(&c, &r.id, &t.id, json!("garde")).unwrap();
    delete_property(&c, &t.id).unwrap();
    assert!(properties(&c, &d.node.id)
        .unwrap()
        .iter()
        .all(|p| p.id != t.id));
    assert_eq!(
        row(&c, &r.id).unwrap().props[&t.id],
        "garde",
        "la valeur reste en base, seule la colonne disparaît"
    );
    assert!(set(&c, &r.id, &t.id, json!("x")).is_err());
    prop(&c, &d.node.id, "t", "text", json!({})); // le nom redevient disponible
    let title = properties(&c, &d.node.id)
        .unwrap()
        .into_iter()
        .find(|p| p.kind == "title")
        .unwrap();
    assert!(delete_property(&c, &title.id).is_err());
}

#[test]
fn conversions_de_type_sans_perte_uniquement() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let id = &d.node.id;
    let r = newrow(&c, id, "L");

    let n = prop(&c, id, "n", "number", json!({}));
    set(&c, &r.id, &n.id, json!(42)).unwrap();
    assert!(
        update_property(&c, &n.id, None, None, Some("text")).is_err(),
        "nombre -> texte : refusé"
    );
    assert!(update_property(&c, &n.id, None, None, Some("percent")).is_ok());
    assert_eq!(row(&c, &r.id).unwrap().props[&n.id], json!(42.0));

    let dt = prop(&c, id, "d", "date", json!({}));
    set(&c, &r.id, &dt.id, json!("2024-01-02")).unwrap();
    update_property(&c, &dt.id, None, None, Some("datetime")).unwrap();
    assert_eq!(
        row(&c, &r.id).unwrap().props[&dt.id],
        "2024-01-02T00:00:00Z"
    );
    assert!(
        update_property(&c, &dt.id, None, None, Some("date")).is_err(),
        "datetime -> date : perte de l'heure, refusé"
    );

    let s = prop(&c, id, "s", "select", opts(&["a", "b"]));
    let a = s.config["options"][0]["id"].as_str().unwrap().to_string();
    set(&c, &r.id, &s.id, json!(a)).unwrap();
    update_property(&c, &s.id, None, None, Some("multiselect")).unwrap();
    assert_eq!(row(&c, &r.id).unwrap().props[&s.id], json!([a]));
    assert!(
        update_property(&c, &s.id, None, None, Some("select")).is_err(),
        "multi -> simple : refusé"
    );

    let t = prop(&c, id, "t", "text", json!({}));
    set(&c, &r.id, &t.id, json!("https://x.org")).unwrap();
    assert!(update_property(&c, &t.id, None, None, Some("url")).is_ok());
    assert!(update_property(&c, &t.id, None, None, Some("number")).is_err());
}

#[test]
fn retirer_une_option_nettoie_les_valeurs_existantes() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let m = prop(&c, &d.node.id, "m", "multiselect", opts(&["x", "y"]));
    let (x, y) = (
        m.config["options"][0].clone(),
        m.config["options"][1].clone(),
    );
    let (xid, yid) = (
        x["id"].as_str().unwrap().to_string(),
        y["id"].as_str().unwrap().to_string(),
    );
    let r = newrow(&c, &d.node.id, "L");
    set(&c, &r.id, &m.id, json!([xid, yid])).unwrap();
    update_property(&c, &m.id, None, Some(&json!({ "options": [y] })), None).unwrap();
    assert_eq!(row(&c, &r.id).unwrap().props[&m.id], json!([yid]));
    update_property(&c, &m.id, None, Some(&json!({ "options": [] })), None).unwrap();
    assert!(row(&c, &r.id).unwrap().props.get(&m.id).is_none());
}

#[test]
fn renommer_une_propriete_garde_l_unicite() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let a = prop(&c, &d.node.id, "A", "text", json!({}));
    prop(&c, &d.node.id, "B", "text", json!({}));
    assert!(update_property(&c, &a.id, Some("b"), None, None).is_err());
    assert_eq!(
        update_property(&c, &a.id, Some("A2"), None, None)
            .unwrap()
            .name,
        "A2"
    );
    assert!(update_property(&c, &a.id, Some("A"), None, None).is_ok());
}

// ── Vues ─────────────────────────────────────────────────────────────────────
#[test]
fn vues_creation_modification_suppression() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let v = create_view(
        &c,
        &d.node.id,
        "Kanban",
        "kanban",
        &json!({ "groupBy": "x" }),
    )
    .unwrap();
    assert_eq!(views(&c, &d.node.id).unwrap().len(), 2);
    let v2 = update_view(&c, &v.id, Some("Board"), Some(&json!({ "filters": [] }))).unwrap();
    assert_eq!((v2.name.as_str(), v2.layout.as_str()), ("Board", "kanban"));
    assert!(create_view(&c, &d.node.id, "x", "agenda", &json!({})).is_err());
    assert!(create_view(&c, &d.node.id, "x", "table", &json!([1])).is_err());
    assert!(create_view(
        &c,
        &d.node.id,
        "x",
        "table",
        &json!({ "big": "x".repeat(70_000) })
    )
    .is_err());
    delete_view(&c, &v.id).unwrap();
    assert!(delete_view(&c, &d.node.id).is_err());
    let last = views(&c, &d.node.id).unwrap().remove(0);
    assert!(
        delete_view(&c, &last.id).is_err(),
        "la dernière vue est conservée"
    );
    assert!(create_view(
        &c,
        &d.node.id,
        "Cal",
        "calendar",
        &json!({ "dateProperty": "p" })
    )
    .is_ok());
}

// ── Recherche ────────────────────────────────────────────────────────────────
#[test]
fn les_valeurs_textuelles_des_lignes_sont_recherchables_et_suivent_les_modifications() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let t = prop(&c, &d.node.id, "Note", "text", json!({}));
    let n = prop(&c, &d.node.id, "Qte", "number", json!({}));
    let r = newrow(&c, &d.node.id, "Dupont");
    set(&c, &r.id, &t.id, json!("rappeler mardi")).unwrap();
    set(&c, &r.id, &n.id, json!(777)).unwrap();
    assert_eq!(search::search(&c, &ws, "mardi", 5).unwrap().len(), 1);
    assert_eq!(
        search::search(&c, &ws, "dupont", 5).unwrap()[0].node_id,
        r.id
    );
    assert!(
        search::search(&c, &ws, "777", 5).unwrap().is_empty(),
        "les nombres ne sont pas indexés comme texte"
    );
    set(&c, &r.id, &t.id, json!("jeudi")).unwrap();
    assert!(search::search(&c, &ws, "mardi", 5).unwrap().is_empty());
    assert_eq!(search::search(&c, &ws, "jeudi", 5).unwrap().len(), 1);
    delete_property(&c, &t.id).unwrap();
    assert!(
        search::search(&c, &ws, "jeudi", 5).unwrap().is_empty(),
        "colonne supprimée => valeur non indexée"
    );
    delete_rows(&c, std::slice::from_ref(&r.id)).unwrap();
    assert!(search::search(&c, &ws, "dupont", 5).unwrap().is_empty());
}

#[test]
fn une_ligne_est_une_vraie_page_avec_contenu_et_rétroliens() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "B");
    let r = newrow(&c, &d.node.id, "Fiche");
    content::save(
        &c,
        &r.id,
        b"yjs",
        "{\"type\":\"doc\"}",
        "contenu de la fiche",
        &[],
    )
    .unwrap();
    assert_eq!(search::search(&c, &ws, "fiche", 5).unwrap().len(), 1);
    assert_eq!(
        database_of(&c, &r.id).unwrap().as_deref(),
        Some(d.node.id.as_str())
    );
    assert_eq!(database_of(&c, &d.node.id).unwrap(), None);
    let page = tree::create_node(&c, &ws, None, "page", "Autre", None).unwrap();
    content::save(
        &c,
        &page.id,
        b"yjs",
        "{\"type\":\"doc\"}",
        "",
        std::slice::from_ref(&r.id),
    )
    .unwrap();
    assert_eq!(content::backlinks(&c, &r.id).unwrap().len(), 1);
}

// ── Dates ────────────────────────────────────────────────────────────────────
#[test]
fn utilitaires_de_date() {
    assert!(valid_date("2000-02-29") && !valid_date("1900-02-29") && valid_date("2024-12-31"));
    assert!(
        !valid_date("2024-00-10")
            && !valid_date("2024-04-31")
            && !valid_date("2024-1-10")
            && !valid_date("")
    );
    assert_eq!(
        normalize_datetime("2024-01-02T03:04Z").unwrap(),
        "2024-01-02T03:04:00Z"
    );
    assert_eq!(
        normalize_datetime("2024-01-02T23:59:59Z").unwrap(),
        "2024-01-02T23:59:59Z"
    );
    assert!(normalize_datetime("2024-01-02T24:00Z").is_none());
    assert!(normalize_datetime("2024-01-02T03:04").is_none());
}

// ── Volume ───────────────────────────────────────────────────────────────────
#[test]
fn chargement_de_1500_lignes_reste_rapide_et_coherent() {
    let (_d, c, ws) = setup();
    let d = mkdb(&c, &ws, "Gros");
    let n = prop(&c, &d.node.id, "n", "number", json!({}));
    let tx = begin(&c).unwrap();
    for i in 0..1500 {
        let mut init = Map::new();
        init.insert(n.id.clone(), json!(i));
        create_row(&tx, &d.node.id, &format!("L{i}"), &init).unwrap();
    }
    tx.commit().unwrap();
    let t0 = std::time::Instant::now();
    let all = rows(&c, &d.node.id).unwrap();
    let dt = t0.elapsed();
    assert_eq!(all.len(), 1500);
    assert_eq!(all[1499].title, "L1499");
    assert!(dt.as_millis() < 1500, "chargement de 1500 lignes : {dt:?}");
}

#[test]
fn migration_v4_conserve_les_vues_existantes_et_accepte_le_calendrier() {
    let d = tempdir().unwrap();
    let (db_id, view_id);
    {
        let c = db::open_with(d.path(), &MIGRATIONS[..3]).unwrap();
        let ws = tree::ensure_default_workspace(&c, "P").unwrap();
        let created = create_database(&c, &ws, None, "Base", "Nom", "Tableau").unwrap();
        create_view(
            &c,
            &created.node.id,
            "Kanban",
            "kanban",
            &json!({ "groupBy": "x" }),
        )
        .unwrap();
        newrow(&c, &created.node.id, "L1");
        db_id = created.node.id;
        view_id = created.views[0].id.clone();
    }
    let c = db::open(d.path()).unwrap();
    assert_eq!(
        db::schema_version(&c).unwrap(),
        db::migrations::latest_version(MIGRATIONS)
    );
    let vs = views(&c, &db_id).unwrap();
    assert_eq!(vs.len(), 2, "vues conservées");
    assert!(vs.iter().any(|v| v.id == view_id && v.layout == "table"));
    assert_eq!(vs[1].config["groupBy"], "x");
    assert_eq!(rows(&c, &db_id).unwrap().len(), 1, "lignes intactes");
    assert!(create_view(&c, &db_id, "Cal", "calendar", &json!({})).is_ok());
    let idx: i64 = c
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='db_view_order'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(idx, 1);
    let nbad: i64 = c
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(nbad, 0);
}

// ── Récurrence des tâches ─────────────────────────────────────────────────────
#[test]
fn intervalles_de_recurrence() {
    assert_eq!(add_interval("2026-01-31", "daily").unwrap(), "2026-02-01");
    assert_eq!(add_interval("2026-12-31", "daily").unwrap(), "2027-01-01");
    assert_eq!(add_interval("2026-02-25", "weekly").unwrap(), "2026-03-04");
    assert_eq!(add_interval("2024-02-25", "weekly").unwrap(), "2024-03-03"); // bissextile
    assert_eq!(add_interval("2026-01-31", "monthly").unwrap(), "2026-02-28");
    assert_eq!(add_interval("2024-01-31", "monthly").unwrap(), "2024-02-29");
    assert_eq!(add_interval("2026-12-15", "monthly").unwrap(), "2027-01-15");
    assert_eq!(add_interval("2024-02-29", "yearly").unwrap(), "2025-02-28");
    assert_eq!(
        add_interval("2026-03-28T23:30:00Z", "daily").unwrap(),
        "2026-03-29T23:30:00Z"
    );
    assert!(add_interval("2026-02-30", "daily").is_none());
    assert!(add_interval("n'importe quoi", "daily").is_none());
    assert!(add_interval("2026-01-01", "hourly").is_none());
}

fn task_db(
    c: &Connection,
    ws: &str,
) -> (String, PropertyOut, PropertyOut, PropertyOut, PropertyOut) {
    let d = mkdb(c, ws, "Tâches").node.id;
    let status = prop(
        c,
        &d,
        "Statut",
        "status",
        json!({ "options": [
            { "id": "todo", "name": "À faire", "group": "todo" },
            { "id": "done", "name": "Fait", "group": "done" } ] }),
    );
    let due = prop(c, &d, "Échéance", "date", json!({ "role": "due" }));
    let start = prop(c, &d, "Début", "date", json!({ "role": "start" }));
    let rec = prop(
        c,
        &d,
        "Répéter",
        "select",
        json!({ "role": "recurrence", "options": [
            { "id": "daily", "name": "Quotidien" }, { "id": "weekly", "name": "Hebdo" },
            { "id": "monthly", "name": "Mensuel" } ] }),
    );
    (d, status, due, start, rec)
}

#[test]
fn le_role_est_conserve_et_valide() {
    let (_d, c, ws) = setup();
    let (db, _s, due, _st, rec) = task_db(&c, &ws);
    assert_eq!(due.config["role"], "due");
    assert_eq!(rec.config["role"], "recurrence");
    assert!(create_property(&c, &db, "X", "text", &json!({ "role": "due" }), None, None).is_err());
    assert!(create_property(
        &c,
        &db,
        "Y",
        "date",
        &json!({ "role": "pirate" }),
        None,
        None
    )
    .is_err());
    assert!(create_property(
        &c,
        &db,
        "Z",
        "date",
        &json!({ "role": "recurrence" }),
        None,
        None
    )
    .is_err());
}

#[test]
fn terminer_une_tache_recurrente_cree_la_suivante_atomiquement() {
    let (_d, c, ws) = setup();
    let (db, status, due, start, rec) = task_db(&c, &ws);
    let note = prop(&c, &db, "Note", "text", json!({}));
    let mut init = Map::new();
    init.insert(status.id.clone(), json!("todo"));
    init.insert(due.id.clone(), json!("2026-01-31"));
    init.insert(start.id.clone(), json!("2026-01-30"));
    init.insert(rec.id.clone(), json!("monthly"));
    init.insert(note.id.clone(), json!("garder"));
    let t = create_row(&c, &db, "Loyer", &init).unwrap();
    let before = rows(&c, &db).unwrap().len();

    let out = set(&c, &t.id, &status.id, json!("done")).unwrap();
    assert_eq!(out.len(), 2, "la tâche et sa suivante sont renvoyées");
    let all = rows(&c, &db).unwrap();
    assert_eq!(all.len(), before + 1);
    let next = all.iter().find(|r| r.id != t.id).unwrap();
    assert_eq!(next.props[&due.id], "2026-02-28");
    assert_eq!(next.props[&start.id], "2026-02-28"); // 30 janv. + 1 mois, ramené à fin février
    assert_eq!(next.props[&status.id], "todo");
    assert_eq!(next.props[&note.id], "garder");
    assert_eq!(next.props[&rec.id], "monthly");
    assert_eq!(tree::get(&c, &next.id).unwrap().title, "Loyer");
    // l'ancienne reste terminée, avec son échéance
    let old = all.iter().find(|r| r.id == t.id).unwrap();
    assert_eq!(old.props[&status.id], "done");
    assert_eq!(old.props[&due.id], "2026-01-31");

    // re-poser « terminé » sur une tâche déjà terminée ne duplique rien
    set(&c, &t.id, &status.id, json!("done")).unwrap();
    assert_eq!(rows(&c, &db).unwrap().len(), before + 1);
}

#[test]
fn pas_de_suite_sans_regle_sans_echeance_ou_sans_roles() {
    let (_d, c, ws) = setup();
    let (db, status, due, _st, rec) = task_db(&c, &ws);
    let n = |c: &Connection| rows(c, &db).unwrap().len();
    // sans règle
    let mut i = Map::new();
    i.insert(due.id.clone(), json!("2026-01-01"));
    let a = create_row(&c, &db, "A", &i).unwrap();
    set(&c, &a.id, &status.id, json!("done")).unwrap();
    assert_eq!(n(&c), 1);
    // sans échéance
    let mut i = Map::new();
    i.insert(rec.id.clone(), json!("daily"));
    let b = create_row(&c, &db, "B", &i).unwrap();
    set(&c, &b.id, &status.id, json!("done")).unwrap();
    assert_eq!(n(&c), 2);
    // base sans rôles
    let plain = mkdb(&c, &ws, "Simple").node.id;
    let s2 = prop(&c, &plain, "S", "status", json!({}));
    let d2 = prop(&c, &plain, "D", "date", json!({}));
    let mut i = Map::new();
    i.insert(d2.id.clone(), json!("2026-01-01"));
    let r = create_row(&c, &plain, "R", &i).unwrap();
    let done = s2.config["options"][2]["id"].as_str().unwrap().to_string();
    set(&c, &r.id, &s2.id, json!(done)).unwrap();
    assert_eq!(rows(&c, &plain).unwrap().len(), 1);
}
