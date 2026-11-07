use super::*;
use crate::{content, database, db, tree};
use tempfile::tempdir;

fn setup() -> (tempfile::TempDir, Connection, String) {
    let d = tempdir().unwrap();
    let c = db::open(d.path()).unwrap();
    let ws = tree::ensure_default_workspace(&c, "P").unwrap();
    (d, c, ws)
}
fn page(c: &Connection, ws: &str, parent: Option<&str>, title: &str) -> String {
    tree::create_node(c, ws, parent, "page", title, None)
        .unwrap()
        .id
}
fn ops(c: &Connection) -> Vec<(String, String, Value)> {
    pending_ops(c, 200)
        .unwrap()
        .into_iter()
        .map(|o| (o.entity, o.entity_id, o.fields))
        .collect()
}
fn rn(id: &str, parent: Option<&str>, title: &str, pos: &str) -> RemoteNode {
    RemoteNode {
        id: id.into(),
        parent_id: parent.map(String::from),
        kind: "page".into(),
        title: title.into(),
        position: pos.into(),
        deleted_at: None,
        purged_at: None,
        created_at: "2026-06-01T10:00:00+00:00".into(),
    }
}
/// Curseur du (premier) espace synchronisé.
fn cursor(c: &Connection, col: &str) -> i64 {
    c.query_row(
        &format!("SELECT {col} FROM sync_state WHERE enabled = 1 LIMIT 1"),
        [],
        |r| r.get(0),
    )
    .unwrap()
}
fn save(c: &Connection, id: &str, text: &str) {
    content::save(
        c,
        id,
        text.as_bytes(),
        &format!(r#"{{"type":"doc","t":"{text}"}}"#),
        text,
        &[],
    )
    .unwrap();
}

#[test]
fn mode_invite_aucune_operation_ne_s_accumule() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "A");
    tree::rename_node(&c, &p, "B").unwrap();
    save(&c, &p, "texte");
    assert_eq!(
        c.query_row("SELECT count(*) FROM oplog", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(!status(&c).unwrap().enabled);
    assert!(pending_ops(&c, 10).unwrap().is_empty());
}

#[test]
fn activer_inscrit_tout_l_existant_parents_d_abord_bases_comprises() {
    let (_d, c, ws) = setup();
    let child = {
        let root = tree::create_node(&c, &ws, None, "folder", "Racine", None)
            .unwrap()
            .id;
        page(&c, &ws, Some(&root), "Enfant")
    };
    save(&c, &child, "contenu");
    let trashed = page(&c, &ws, None, "Corbeille");
    tree::soft_delete(&c, &trashed).unwrap();
    let dbo = database::create_database(&c, &ws, None, "Base", "Nom", "V")
        .unwrap()
        .node
        .id;
    let status_prop =
        database::create_property(&c, &dbo, "N", "number", &json!({}), None, None).unwrap();
    let row = database::create_row(&c, &dbo, "Ligne", &serde_json::Map::new())
        .unwrap()
        .id;
    database::set_cells(
        &c,
        &[database::CellChange {
            row_id: row.clone(),
            property_id: status_prop.id.clone(),
            value: json!(7),
        }],
    )
    .unwrap();
    save(&c, &row, "page de ligne");

    let st = enable(&c, &ws).unwrap();
    assert!(st.enabled);
    let o = pending_ops(&c, 200).unwrap();
    let ids = |e: &str| -> Vec<String> {
        o.iter()
            .filter(|p| p.entity == e)
            .map(|p| p.entity_id.clone())
            .collect()
    };
    let nodes = ids("node");
    assert_eq!(
        nodes.len(),
        5,
        "dossier, enfant, corbeille, base, ligne… tous les nœuds"
    );
    assert!(nodes.contains(&dbo) && nodes.contains(&row));
    let pos = |id: &str| nodes.iter().position(|x| x == id).unwrap();
    let root_id = c
        .query_row("SELECT parent_id FROM node WHERE id = ?1", [&child], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    assert!(pos(&root_id) < pos(&child), "parents avant enfants");
    assert!(pos(&dbo) < pos(&row), "la base avant sa ligne");
    let t = o.iter().find(|p| p.entity_id == trashed).unwrap();
    assert!(t.fields["deleted_at"].is_string());
    assert_eq!(ids("prop").len(), 2, "titre + propriété ajoutée");
    assert_eq!(ids("view").len(), 1);
    let r = o.iter().find(|p| p.entity == "row").unwrap();
    assert_eq!(r.entity_id, row);
    assert_eq!(r.fields["cells"][&status_prop.id].as_f64(), Some(7.0));
    assert_eq!(r.fields["database_id"], json!(dbo));
    let docs = ids("doc");
    assert!(docs.contains(&child) && docs.contains(&row));
    // l'ordre global : nœuds, puis propriétés, puis lignes (les contenus peuvent venir n'importe quand)
    let first = |e: &str| o.iter().position(|p| p.entity == e).unwrap();
    assert!(first("node") < first("prop") && first("prop") < first("row"));
    assert_eq!(tree::get(&c, &child).unwrap().title, "Enfant");
    // rappeler enable est sans effet ; le rattrapage ne se refait pas
    let before = c
        .query_row("SELECT count(*) FROM oplog", [], |r| r.get::<_, i64>(0))
        .unwrap();
    enable(&c, &ws).unwrap();
    pending_ops(&c, 200).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM oplog", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        before
    );
    assert!(enable(&c, "inconnu").is_err());
}

#[test]
fn les_declencheurs_capturent_creation_titre_deplacement_corbeille_et_contenu() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    let a = page(&c, &ws, None, "A");
    let b = page(&c, &ws, None, "B");
    let created = ops(&c);
    assert_eq!(created.len(), 2);
    assert_eq!(created[0].2["title"], "A");
    assert_eq!(created[0].2["kind"], "page");
    ack(
        &c,
        &pending_ops(&c, 10)
            .unwrap()
            .iter()
            .map(|o| AckResult {
                op_id: o.op_id.clone(),
                status: "applied".into(),
                reason: None,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(ops(&c).is_empty(), "accusé = file vide");

    tree::rename_node(&c, &a, "A2").unwrap();
    let o = ops(&c);
    assert_eq!(o.len(), 1);
    assert_eq!(
        o[0].2,
        json!({ "title": "A2" }),
        "seul le champ modifié est envoyé"
    );

    tree::move_node(&c, &a, Some(&b), None).unwrap();
    let o = ops(&c);
    assert!(
        o.iter()
            .any(|(_, _, f)| f.get("parent_id") == Some(&json!(b))),
        "déplacement capturé"
    );

    tree::soft_delete(&c, &a).unwrap();
    assert!(ops(&c)
        .iter()
        .any(|(_, _, f)| f.get("deleted_at").is_some_and(|v| v.is_string())));
    tree::restore(&c, &a).unwrap();
    assert!(
        ops(&c)
            .iter()
            .any(|(_, _, f)| f.get("deleted_at") == Some(&Value::Null)),
        "restauration = deleted_at nul"
    );

    // contenu : une seule opération en attente par page, avec l'état Yjs courant
    save(&c, &b, "v1");
    save(&c, &b, "v2");
    save(&c, &b, "v3");
    let docs: Vec<PendingOp> = pending_ops(&c, 50)
        .unwrap()
        .into_iter()
        .filter(|o| o.entity == "doc")
        .collect();
    assert_eq!(docs.len(), 1);
    assert_eq!(B64.decode(docs[0].update.as_ref().unwrap()).unwrap(), b"v3");
}

#[test]
fn l_operation_est_dans_la_meme_transaction_que_la_modification() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    let p = page(&c, &ws, None, "A");
    ack(
        &c,
        &pending_ops(&c, 10)
            .unwrap()
            .iter()
            .map(|o| AckResult {
                op_id: o.op_id.clone(),
                status: "applied".into(),
                reason: None,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    // une modification annulée n'laisse aucune opération
    {
        let tx = crate::db::begin(&c).unwrap();
        tx.execute("UPDATE node SET title = 'perdu' WHERE id = ?1", [&p])
            .unwrap();
        drop(tx); // abandon sans commit
    }
    assert!(ops(&c).is_empty());
    assert_eq!(tree::get(&c, &p).unwrap().title, "A");
}

#[test]
fn accuses_applique_temporaire_et_permanent() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    page(&c, &ws, None, "A");
    page(&c, &ws, None, "B");
    page(&c, &ws, None, "C");
    let o = pending_ops(&c, 10).unwrap();
    ack(
        &c,
        &[
            AckResult {
                op_id: o[0].op_id.clone(),
                status: "duplicate".into(),
                reason: None,
            },
            AckResult {
                op_id: o[1].op_id.clone(),
                status: "rejected".into(),
                reason: Some("parent_missing".into()),
            },
            AckResult {
                op_id: o[2].op_id.clone(),
                status: "rejected".into(),
                reason: Some("cycle".into()),
            },
        ],
    )
    .unwrap();
    let st = status(&c).unwrap();
    assert_eq!((st.pending, st.rejected), (1, 1));
    let still = pending_ops(&c, 10).unwrap();
    assert_eq!(still.len(), 1);
    assert_eq!(still[0].op_id, o[1].op_id, "cause temporaire : réessayée");
    let err: String = c
        .query_row(
            "SELECT last_error FROM oplog WHERE op_id = ?1",
            [&o[2].op_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(err, "cycle", "cause permanente conservée et visible");
    // abandon après MAX_ATTEMPTS
    for _ in 0..MAX_ATTEMPTS {
        ack(
            &c,
            &[AckResult {
                op_id: o[1].op_id.clone(),
                status: "rejected".into(),
                reason: Some("parent_missing".into()),
            }],
        )
        .unwrap();
    }
    assert_eq!(status(&c).unwrap().rejected, 2);
    assert!(ack(
        &c,
        &[AckResult {
            op_id: "x".into(),
            status: "bizarre".into(),
            reason: None
        }]
    )
    .is_err());
    // accusé d'une opération inconnue : ignoré
    ack(
        &c,
        &[AckResult {
            op_id: "inconnue".into(),
            status: "applied".into(),
            reason: None,
        }],
    )
    .unwrap();
}

#[test]
fn desactiver_vide_la_file_et_conserve_les_donnees() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    let p = page(&c, &ws, None, "A");
    assert!(status(&c).unwrap().pending > 0);
    let st = disable(&c).unwrap();
    assert!(!st.enabled);
    assert_eq!(st.pending, 0);
    tree::rename_node(&c, &p, "B").unwrap();
    assert_eq!(status(&c).unwrap().pending, 0);
    assert_eq!(tree::get(&c, &p).unwrap().title, "B");
}

#[test]
fn appliquer_des_noeuds_distants_sans_echo_vers_le_serveur() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    let remote_parent = "0192f0a0-0000-7000-8000-00000000aaa1";
    let remote_child = "0192f0a0-0000-7000-8000-00000000aaa2";
    // l'enfant arrive AVANT son parent dans le lot : l'ordre est rétabli
    let r = apply_remote_nodes(
        &c,
        &ws,
        &[
            rn(remote_child, Some(remote_parent), "Enfant", "V2"),
            rn(remote_parent, None, "Parent", "V1"),
        ],
        Some(42),
    )
    .unwrap();
    assert_eq!((r.applied, r.unresolved), (2, 0));
    assert_eq!(
        tree::get(&c, remote_child).unwrap().parent_id.as_deref(),
        Some(remote_parent)
    );
    assert!(
        ops(&c).is_empty(),
        "appliquer le distant ne crée aucune opération"
    );
    assert_eq!(cursor(&c, "node_cursor"), 42);
    // la recherche voit le nouveau titre
    assert!(!search::search(&c, &ws, "Enfant", 5).unwrap().is_empty());
    // mise à jour distante : titre, déplacement, corbeille
    let mut upd = rn(remote_child, None, "Renommé", "V9");
    upd.deleted_at = Some("2026-06-02T08:00:00+00:00".into());
    apply_remote_nodes(&c, &ws, &[upd], Some(50)).unwrap();
    let n = tree::get(&c, remote_child).unwrap();
    assert_eq!(
        (
            n.title.as_str(),
            n.parent_id.as_deref(),
            n.position.as_str()
        ),
        ("Renommé", None, "V9")
    );
    assert_eq!(n.deleted_at.as_deref(), Some("2026-06-02T08:00:00.000Z"));
    assert!(ops(&c).is_empty());
    // le curseur ne recule jamais
    apply_remote_nodes(&c, &ws, &[], Some(10)).unwrap();
    assert_eq!(cursor(&c, "node_cursor"), 50);
}

#[test]
fn un_champ_modifie_localement_et_non_acquitte_n_est_jamais_ecrase() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "Original");
    enable(&c, &ws).unwrap();
    ack(
        &c,
        &pending_ops(&c, 10)
            .unwrap()
            .iter()
            .map(|o| AckResult {
                op_id: o.op_id.clone(),
                status: "applied".into(),
                reason: None,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    tree::rename_node(&c, &p, "Local").unwrap(); // en attente d'envoi
    apply_remote_nodes(&c, &ws, &[rn(&p, None, "Distant", "Vzz")], Some(7)).unwrap();
    let n = tree::get(&c, &p).unwrap();
    assert_eq!(n.title, "Local", "titre local en attente préservé");
    assert_eq!(
        n.position, "Vzz",
        "champ sans opération en attente : le distant s'applique"
    );
    assert_eq!(ops(&c).len(), 1);
    // une fois acquitté, le distant redevient la vérité
    let o = pending_ops(&c, 10).unwrap();
    ack(
        &c,
        &[AckResult {
            op_id: o[0].op_id.clone(),
            status: "applied".into(),
            reason: None,
        }],
    )
    .unwrap();
    apply_remote_nodes(&c, &ws, &[rn(&p, None, "Distant", "Vzz")], Some(8)).unwrap();
    assert_eq!(tree::get(&c, &p).unwrap().title, "Distant");
}

#[test]
fn cycle_distant_ignore_parent_inconnu_bloque_le_curseur_et_types_valides() {
    let (_d, c, ws) = setup();
    let a = page(&c, &ws, None, "A");
    let b = page(&c, &ws, Some(&a), "B");
    enable(&c, &ws).unwrap();
    ack(
        &c,
        &pending_ops(&c, 10)
            .unwrap()
            .iter()
            .map(|o| AckResult {
                op_id: o.op_id.clone(),
                status: "applied".into(),
                reason: None,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    // le serveur propose A sous B alors que B est sous A localement : jamais de cycle
    apply_remote_nodes(&c, &ws, &[rn(&a, Some(&b), "A", "V0")], Some(3)).unwrap();
    assert_eq!(tree::get(&c, &a).unwrap().parent_id, None);
    // parent inconnu : rien d'inventé, curseur non avancé
    let orphan = "0192f0a0-0000-7000-8000-00000000bbb1";
    let before = cursor(&c, "node_cursor");
    let r = apply_remote_nodes(
        &c,
        &ws,
        &[rn(
            orphan,
            Some("0192f0a0-0000-7000-8000-00000000bbb9"),
            "Orphelin",
            "V1",
        )],
        Some(99),
    )
    .unwrap();
    assert_eq!(r.unresolved, 1);
    assert_eq!(cursor(&c, "node_cursor"), before);
    assert!(tree::get(&c, orphan).is_err());
    // une base distante est créée localement ; un type inconnu est refusé
    let mut dbn = rn("0192f0a0-0000-7000-8000-00000000ccc1", None, "Base", "V1");
    dbn.kind = "database".into();
    assert_eq!(
        apply_remote_nodes(&c, &ws, &[dbn], Some(100))
            .unwrap()
            .applied,
        1
    );
    assert_eq!(
        tree::get(&c, "0192f0a0-0000-7000-8000-00000000ccc1")
            .unwrap()
            .kind,
        "database"
    );
    let mut bad = rn("0192f0a0-0000-7000-8000-00000000ccc2", None, "X", "V1");
    bad.kind = "bizarre".into();
    assert!(apply_remote_nodes(&c, &ws, &[bad], None).is_err());
    // synchronisation non activée pour cet espace : refus
    assert!(apply_remote_nodes(&c, "autre", &[], None).is_err());
}

#[test]
fn contenu_distant_garde_de_fraicheur_et_pas_d_echo() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    save(&c, &p, "local");
    enable(&c, &ws).unwrap();
    ack(
        &c,
        &pending_ops(&c, 10)
            .unwrap()
            .iter()
            .map(|o| AckResult {
                op_id: o.op_id.clone(),
                status: "applied".into(),
                reason: None,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let before = doc_for_merge(&c, &p).unwrap().unwrap();
    assert_eq!(B64.decode(&before.doc_state).unwrap(), b"local");
    // fusion appliquée avec la bonne date : écrite, sans opération
    let out = apply_remote_doc(
        &c,
        &p,
        b"fusionne",
        r#"{"type":"doc"}"#,
        "fusionne",
        Some(&before.updated_at),
    )
    .unwrap();
    assert_eq!(out, DocOutcome::Applied);
    assert!(ops(&c).is_empty(), "pas d'écho");
    assert!(!search::search(&c, &ws, "fusionne", 5).unwrap().is_empty());
    // la page a changé entre la lecture et l'écriture : refus, rien n'est perdu
    save(&c, &p, "plus recent");
    let out = apply_remote_doc(
        &c,
        &p,
        b"ancienne fusion",
        r#"{"type":"doc"}"#,
        "x",
        Some(&before.updated_at),
    )
    .unwrap();
    assert_eq!(out, DocOutcome::Stale);
    assert_eq!(
        B64.decode(doc_for_merge(&c, &p).unwrap().unwrap().doc_state)
            .unwrap(),
        b"plus recent"
    );
    // page inconnue, JSON invalide, état vide
    assert_eq!(
        apply_remote_doc(&c, "inconnue", b"x", "{}", "", None).unwrap(),
        DocOutcome::Missing
    );
    assert!(apply_remote_doc(&c, &p, b"x", "pas du json", "", None).is_err());
    assert!(apply_remote_doc(&c, &p, b"", "{}", "", None).is_err());
    // première réception d'une page jamais écrite localement
    let q = page(&c, &ws, None, "Q");
    ack(
        &c,
        &pending_ops(&c, 10)
            .unwrap()
            .iter()
            .map(|o| AckResult {
                op_id: o.op_id.clone(),
                status: "applied".into(),
                reason: None,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert_eq!(doc_for_merge(&c, &q).unwrap(), None);
    assert_eq!(
        apply_remote_doc(&c, &q, b"neuf", "{}", "neuf", None).unwrap(),
        DocOutcome::Applied
    );
    assert!(ops(&c).is_empty());
    // curseur de contenu monotone
    set_doc_cursor(&c, &ws, 10).unwrap();
    set_doc_cursor(&c, &ws, 4).unwrap();
    assert_eq!(cursor(&c, "doc_cursor"), 10);
}

// ── Bases de données ──────────────────────────────────────────────────────────
fn struct_setup() -> (
    tempfile::TempDir,
    Connection,
    String,
    String,
    String,
    String,
) {
    let (d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    let dbo = database::create_database(&c, &ws, None, "Base", "Nom", "V")
        .unwrap()
        .node
        .id;
    let num = database::create_property(&c, &dbo, "Montant", "number", &json!({}), None, None)
        .unwrap()
        .id;
    let txt = database::create_property(&c, &dbo, "Note", "text", &json!({}), None, None)
        .unwrap()
        .id;
    drain(&c);
    (d, c, ws, dbo, num, txt)
}
fn drain(c: &Connection) {
    loop {
        let o = pending_ops(c, 200).unwrap();
        if o.is_empty() {
            break;
        }
        ack(
            c,
            &o.iter()
                .map(|p| AckResult {
                    op_id: p.op_id.clone(),
                    status: "applied".into(),
                    reason: None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
    }
}
fn cells(o: &PendingOp) -> &serde_json::Map<String, Value> {
    o.fields["cells"].as_object().unwrap()
}

#[test]
fn les_modifications_de_schema_sont_capturees_par_champ() {
    let (_d, c, _ws, dbo, num, _txt) = struct_setup();
    database::update_property(&c, &num, Some("Total"), None, None).unwrap();
    let o = pending_ops(&c, 50).unwrap();
    assert_eq!(o.len(), 1);
    assert_eq!(
        (o[0].entity.as_str(), o[0].entity_id.as_str()),
        ("prop", num.as_str())
    );
    assert_eq!(o[0].fields["name"], "Total");
    assert_eq!(o[0].fields["database_id"], json!(dbo));
    assert!(o[0].fields.get("type").is_none(), "seul le champ modifié");
    drain(&c);
    database::delete_property(&c, &num).unwrap();
    let o = pending_ops(&c, 50).unwrap();
    assert!(o
        .iter()
        .any(|p| p.entity == "prop" && p.fields["deleted_at"].is_string()));
}

#[test]
fn les_vues_sont_capturees() {
    let (_d, c, _ws, dbo, _num, _txt) = struct_setup();
    let v = database::create_view(&c, &dbo, "Kanban", "kanban", &json!({})).unwrap();
    let o = pending_ops(&c, 50).unwrap();
    let ins = o.iter().find(|p| p.entity == "view").unwrap();
    assert_eq!(ins.entity_id, v.id);
    assert_eq!(ins.fields["layout"], "kanban");
    assert!(
        ins.fields["config"].is_object(),
        "la configuration est du JSON, pas du texte"
    );
    drain(&c);
    database::update_view(
        &c,
        &v.id,
        Some("Tableau de bord"),
        Some(&json!({ "groupBy": "x" })),
    )
    .unwrap();
    let o = pending_ops(&c, 50).unwrap();
    assert!(o
        .iter()
        .any(|p| p.fields.get("name") == Some(&json!("Tableau de bord"))));
    assert!(o.iter().any(|p| p.fields["config"]["groupBy"] == "x"));
}

#[test]
fn les_cellules_modifiees_ajoutees_et_retirees_sont_capturees_une_a_une() {
    let (_d, c, _ws, dbo, num, txt) = struct_setup();
    let row = database::create_row(&c, &dbo, "L", &serde_json::Map::new())
        .unwrap()
        .id;
    drain(&c);
    let set = |p: &str, v: Value| {
        database::set_cells(
            &c,
            &[database::CellChange {
                row_id: row.clone(),
                property_id: p.into(),
                value: v,
            }],
        )
        .unwrap()
    };
    set(&num, json!(5));
    let o = pending_ops(&c, 50).unwrap();
    assert_eq!(o.len(), 1);
    assert_eq!(cells(&o[0]).len(), 1);
    assert_eq!(cells(&o[0])[&num].as_f64(), Some(5.0));
    drain(&c);
    set(&txt, json!("a \"guillemets\" é"));
    let o = pending_ops(&c, 50).unwrap();
    assert_eq!(o.len(), 1, "la cellule inchangée n'est pas renvoyée");
    assert_eq!(cells(&o[0])[&txt], json!("a \"guillemets\" é"));
    drain(&c);
    set(&num, Value::Null); // vidée
    let o = pending_ops(&c, 50).unwrap();
    assert_eq!(o.len(), 1);
    assert_eq!(cells(&o[0])[&num], Value::Null, "retrait = null");
    drain(&c);
    set(&txt, json!("a \"guillemets\" é")); // même valeur : aucune opération
    assert!(pending_ops(&c, 50).unwrap().is_empty());
    // valeurs structurées (listes, nombres décimaux, booléens)
    let multi = database::create_property(
        &c,
        &dbo,
        "Tags",
        "multiselect",
        &json!({"options":[{"name":"a"}]}),
        None,
        None,
    )
    .unwrap();
    drain(&c);
    set(&multi.id, json!([]));
    let _ = pending_ops(&c, 50).unwrap();
}

#[test]
fn creer_une_ligne_envoie_son_noeud_puis_ses_valeurs() {
    let (_d, c, _ws, dbo, num, _t) = struct_setup();
    let mut init = serde_json::Map::new();
    init.insert(num.clone(), json!(3.5));
    let row = database::create_row(&c, &dbo, "Neuve", &init).unwrap().id;
    let o = pending_ops(&c, 50).unwrap();
    let kinds: Vec<&str> = o.iter().map(|p| p.entity.as_str()).collect();
    let n = kinds.iter().position(|k| *k == "node").unwrap();
    let r = kinds.iter().position(|k| *k == "row").unwrap();
    assert!(n < r, "le nœud avant la ligne");
    assert!(o.iter().any(|p| p.entity == "row"
        && p.entity_id == row
        && p.fields["cells"].get(&num).and_then(Value::as_f64) == Some(3.5)));
}

fn rprop(id: &str, db: &str, name: &str, pos: &str) -> RemoteStruct {
    RemoteStruct::Prop {
        id: id.into(),
        database_id: db.into(),
        name: name.into(),
        prop_type: "text".into(),
        config: json!({}),
        position: pos.into(),
        deleted_at: None,
    }
}

#[test]
fn appliquer_la_structure_distante_cree_proprietes_vues_et_lignes_sans_echo() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    let dbid = "0192f0a0-0000-7000-8000-0000000d0001";
    let rowid = "0192f0a0-0000-7000-8000-0000000d0002";
    let (p1, p2, v1) = (
        "0192f0a0-0000-7000-8000-0000000d0011",
        "0192f0a0-0000-7000-8000-0000000d0012",
        "0192f0a0-0000-7000-8000-0000000d0021",
    );
    let mut dbn = rn(dbid, None, "Distante", "V1");
    dbn.kind = "database".into();
    let rown = rn(rowid, Some(dbid), "Ligne distante", "V1");
    apply_remote_nodes(&c, &ws, &[dbn, rown], Some(5)).unwrap();
    let mut props = serde_json::Map::new();
    props.insert(p1.into(), json!("valeur"));
    props.insert(p2.into(), json!([rowid]));
    let items = vec![
        rprop(p1, dbid, "Texte", "U1"),
        RemoteStruct::View {
            id: v1.into(),
            database_id: dbid.into(),
            name: "Vue".into(),
            layout: "calendar".into(),
            config: json!({"dateProperty": p1}),
            position: "W1".into(),
            deleted_at: None,
        },
        RemoteStruct::Row {
            id: rowid.into(),
            database_id: dbid.into(),
            props,
        },
    ];
    let r = apply_remote_struct(&c, &ws, &items, Some(77)).unwrap();
    assert_eq!((r.applied, r.skipped, r.unresolved), (3, 0, 0));
    assert!(
        pending_ops(&c, 50).unwrap().is_empty(),
        "aucun écho vers le serveur"
    );
    assert_eq!(cursor(&c, "struct_cursor"), 77);
    let (name, ty): (String, String) = c
        .query_row(
            "SELECT name, type FROM db_property WHERE id = ?1",
            [p1],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((name.as_str(), ty.as_str()), ("Texte", "text"));
    let cfg: String = c
        .query_row("SELECT config_json FROM db_view WHERE id = ?1", [v1], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&cfg).unwrap()["dateProperty"],
        p1
    );
    let rows = database::rows(&c, dbid).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].props[p1], json!("valeur"));
    assert_eq!(rows[0].props[p2], json!([rowid]));
    // la recherche voit les valeurs distantes
    assert!(!search::search(&c, &ws, "valeur", 5).unwrap().is_empty());
    // mise à jour distante : renommage, tombstone, cellule retirée
    let mut upd = serde_json::Map::new();
    upd.insert(p2.into(), json!(["x"]));
    let r2 = apply_remote_struct(
        &c,
        &ws,
        &[
            RemoteStruct::Prop {
                id: p1.into(),
                database_id: dbid.into(),
                name: "Renommé".into(),
                prop_type: "text".into(),
                config: json!({}),
                position: "U1".into(),
                deleted_at: Some("2026-06-01T10:00:00+00:00".into()),
            },
            RemoteStruct::Row {
                id: rowid.into(),
                database_id: dbid.into(),
                props: upd,
            },
        ],
        Some(78),
    )
    .unwrap();
    assert_eq!(r2.applied, 2);
    let (n2, d2): (String, Option<String>) = c
        .query_row(
            "SELECT name, deleted_at FROM db_property WHERE id = ?1",
            [p1],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(n2, "Renommé");
    assert!(d2.is_some());
    let rows = database::rows(&c, dbid).unwrap();
    assert!(
        rows[0].props.get(p1).is_none(),
        "cellule absente du serveur = retirée"
    );
    assert!(pending_ops(&c, 50).unwrap().is_empty());
    // même contenu rejoué : rien à faire
    assert_eq!(
        apply_remote_struct(&c, &ws, &[rprop(p2, dbid, "Texte 2", "U2")], Some(79))
            .unwrap()
            .applied,
        1
    );
    assert_eq!(
        apply_remote_struct(&c, &ws, &[rprop(p2, dbid, "Texte 2", "U2")], Some(79))
            .unwrap()
            .applied,
        0
    );
}

#[test]
fn le_local_en_attente_gagne_cellule_par_cellule_et_champ_par_champ() {
    let (_d, c, ws, dbo, num, txt) = struct_setup();
    let row = database::create_row(&c, &dbo, "L", &serde_json::Map::new())
        .unwrap()
        .id;
    database::set_cells(
        &c,
        &[
            database::CellChange {
                row_id: row.clone(),
                property_id: num.clone(),
                value: json!(1),
            },
            database::CellChange {
                row_id: row.clone(),
                property_id: txt.clone(),
                value: json!("a"),
            },
        ],
    )
    .unwrap();
    drain(&c);
    // modification locale de « num » en attente ; le serveur propose num=99 et txt="serveur"
    database::set_cells(
        &c,
        &[database::CellChange {
            row_id: row.clone(),
            property_id: num.clone(),
            value: json!(2),
        }],
    )
    .unwrap();
    let mut props = serde_json::Map::new();
    props.insert(num.clone(), json!(99));
    props.insert(txt.clone(), json!("serveur"));
    apply_remote_struct(
        &c,
        &ws,
        &[RemoteStruct::Row {
            id: row.clone(),
            database_id: dbo.clone(),
            props,
        }],
        Some(1),
    )
    .unwrap();
    let r = database::rows(&c, &dbo)
        .unwrap()
        .into_iter()
        .find(|r| r.id == row)
        .unwrap();
    assert_eq!(
        r.props[&num].as_f64(),
        Some(2.0),
        "cellule locale en attente préservée"
    );
    assert_eq!(
        r.props[&txt],
        json!("serveur"),
        "cellule sans modification en attente : le serveur gagne"
    );
    assert_eq!(pending_ops(&c, 50).unwrap().len(), 1);
    // nom de propriété modifié localement (en attente) : préservé, la position distante s'applique
    database::update_property(&c, &num, Some("Local"), None, None).unwrap();
    apply_remote_struct(
        &c,
        &ws,
        &[RemoteStruct::Prop {
            id: num.clone(),
            database_id: dbo.clone(),
            name: "Serveur".into(),
            prop_type: "number".into(),
            config: json!({}),
            position: "Uzzzzy".into(),
            deleted_at: None,
        }],
        Some(2),
    )
    .unwrap();
    let (n, p): (String, String) = c
        .query_row(
            "SELECT name, position FROM db_property WHERE id = ?1",
            [&num],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((n.as_str(), p.as_str()), ("Local", "Uzzzzy"));
}

#[test]
fn doublon_de_nom_local_les_deux_proprietes_sont_conservees() {
    let (_d, c, ws, dbo, _num, _txt) = struct_setup();
    let id = "0192f0a0-0000-7000-8000-0000000e0001";
    // une propriété distante nommée comme une propriété locale (« Note », insensible à la casse)
    let r = apply_remote_struct(&c, &ws, &[rprop(id, &dbo, "note", "U9")], Some(3)).unwrap();
    assert_eq!((r.applied, r.skipped), (1, 0));
    let names: Vec<String> = c
        .prepare("SELECT name FROM db_property WHERE database_id = ?1 ORDER BY name")
        .unwrap()
        .query_map([&dbo], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        names.contains(&"Note".to_string()) && names.contains(&"note (2)".to_string()),
        "{names:?}"
    );
    // un second champ « titre » est impossible : compté, pas silencieux
    let mut second_title = rprop(
        "0192f0a0-0000-7000-8000-0000000e0002",
        &dbo,
        "Autre titre",
        "U8",
    );
    if let RemoteStruct::Prop { prop_type, .. } = &mut second_title {
        *prop_type = "title".into();
    }
    let r = apply_remote_struct(&c, &ws, &[second_title], Some(4)).unwrap();
    assert_eq!((r.applied, r.skipped), (0, 1));
}

#[test]
fn base_ou_noeud_absent_bloque_le_curseur_sans_rien_ecrire() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    let before = cursor(&c, "struct_cursor");
    let r = apply_remote_struct(
        &c,
        &ws,
        &[rprop(
            "0192f0a0-0000-7000-8000-0000000f0001",
            "0192f0a0-0000-7000-8000-0000000f00ff",
            "X",
            "U1",
        )],
        Some(50),
    )
    .unwrap();
    assert_eq!(r.unresolved, 1);
    assert_eq!(cursor(&c, "struct_cursor"), before);
    // ligne dont le nœud n'est pas arrivé
    let dbn = {
        let mut n = rn("0192f0a0-0000-7000-8000-0000000f0002", None, "B", "V1");
        n.kind = "database".into();
        n
    };
    apply_remote_nodes(&c, &ws, &[dbn], Some(1)).unwrap();
    let r = apply_remote_struct(
        &c,
        &ws,
        &[RemoteStruct::Row {
            id: "0192f0a0-0000-7000-8000-0000000f0003".into(),
            database_id: "0192f0a0-0000-7000-8000-0000000f0002".into(),
            props: serde_json::Map::new(),
        }],
        Some(51),
    )
    .unwrap();
    assert_eq!(r.unresolved, 1);
    assert_eq!(
        c.query_row("SELECT count(*) FROM db_row", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(apply_remote_struct(&c, "autre", &[], None).is_err());
}

#[test]
fn rattrapage_des_bases_existantes_une_seule_fois() {
    // Synchronisation activée AVANT l'existence des bases synchronisées : struct_backfilled = 0.
    let (_d, c, ws) = setup();
    let dbo = database::create_database(&c, &ws, None, "Ancienne", "Nom", "V")
        .unwrap()
        .node
        .id;
    let row = database::create_row(&c, &dbo, "L", &serde_json::Map::new())
        .unwrap()
        .id;
    enable(&c, &ws).unwrap();
    drain(&c);
    c.execute("UPDATE sync_state SET struct_backfilled = 0", [])
        .unwrap(); // simule la mise à jour de l'application
    let o = pending_ops(&c, 200).unwrap();
    assert!(o.iter().any(|p| p.entity == "node" && p.entity_id == dbo));
    assert!(o.iter().any(|p| p.entity == "node" && p.entity_id == row));
    assert!(o.iter().any(|p| p.entity == "prop"));
    assert!(o.iter().any(|p| p.entity == "view"));
    assert!(o.iter().any(|p| p.entity == "row" && p.entity_id == row));
    let n = o.len();
    assert_eq!(
        pending_ops(&c, 200).unwrap().len(),
        n,
        "pas de second rattrapage"
    );
}

// ── Plusieurs espaces (invitations) ───────────────────────────────────────────
const SHARED: &str = "0192f0a0-0000-7000-8000-0000000aa001";
const SHARED2: &str = "0192f0a0-0000-7000-8000-0000000aa002";

#[test]
fn rejoindre_un_espace_partage_valide_les_entrees_et_est_idempotent() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    assert!(join_workspace(&c, "pas-un-uuid", "Équipe", "editor").is_err());
    assert!(join_workspace(&c, SHARED, "   ", "editor").is_err());
    assert!(join_workspace(&c, SHARED, "Équipe", "superman").is_err());
    assert!(join_workspace(&c, SHARED, &"é".repeat(201), "editor").is_err());
    let st = join_workspace(&c, SHARED, "Équipe", "editor").unwrap();
    assert_eq!(st.workspaces.len(), 2);
    let team = st
        .workspaces
        .iter()
        .find(|w| w.workspace_id == SHARED)
        .unwrap();
    assert_eq!(
        (team.name.as_str(), team.role.as_str()),
        ("Équipe", "editor")
    );
    let kind: String = c
        .query_row("SELECT kind FROM workspace WHERE id = ?1", [SHARED], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(kind, "shared");
    // rejouer ne duplique rien ; le rôle suit la dernière valeur
    join_workspace(&c, SHARED, "Autre nom", "viewer").unwrap();
    let st = status(&c).unwrap();
    assert_eq!(st.workspaces.len(), 2);
    assert_eq!(
        st.workspaces
            .iter()
            .find(|w| w.workspace_id == SHARED)
            .unwrap()
            .role,
        "viewer"
    );
    assert_eq!(
        c.query_row("SELECT name FROM workspace WHERE id = ?1", [SHARED], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "Équipe",
        "le nom local n'est pas écrasé"
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM oplog", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0,
        "rien à envoyer pour un espace qu'on rejoint"
    );
}

#[test]
fn les_operations_sont_regroupees_par_espace_et_les_espaces_non_synchronises_sont_ignores() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    join_workspace(&c, SHARED, "Équipe", "editor").unwrap();
    // un troisième espace local, jamais synchronisé
    let ts = tree::now(&c).unwrap();
    c.execute("INSERT INTO workspace (id, name, kind, created_at, updated_at) VALUES (?1, 'Privé', 'personal', ?2, ?2)", params![SHARED2, ts]).unwrap();
    let mine = page(&c, &ws, None, "Perso");
    let theirs = page(&c, SHARED, None, "Partagée");
    let private = page(&c, SHARED2, None, "Secrète");
    save(&c, &theirs, "contenu partagé");
    save(&c, &private, "contenu privé");
    let o = pending_ops(&c, 100).unwrap();
    let ws_of = |id: &str| {
        o.iter()
            .filter(|p| p.entity_id == id)
            .map(|p| p.workspace_id.clone())
            .collect::<Vec<_>>()
    };
    assert!(ws_of(&mine).iter().all(|w| w == &ws) && !ws_of(&mine).is_empty());
    assert!(
        ws_of(&theirs).iter().all(|w| w == SHARED) && ws_of(&theirs).len() == 2,
        "nœud + contenu"
    );
    assert!(
        ws_of(&private).is_empty(),
        "un espace non synchronisé n'envoie jamais rien"
    );
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM oplog WHERE entity_id = ?1",
            [&private],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0,
        "ni même en file"
    );
}

#[test]
fn lecture_seule_les_modifications_restent_en_file_sans_etre_envoyees() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    join_workspace(&c, SHARED, "Équipe", "viewer").unwrap();
    let p = page(&c, SHARED, None, "Locale");
    let o = pending_ops(&c, 100).unwrap();
    assert!(
        o.iter().all(|x| x.workspace_id != SHARED),
        "rien n'est envoyé pour un espace en lecture seule"
    );
    assert!(
        c.query_row(
            "SELECT count(*) FROM oplog WHERE entity_id = ?1",
            [&p],
            |r| r.get::<_, i64>(0)
        )
        .unwrap()
            > 0
    );
    // promu éditeur : les opérations en attente partent
    set_workspace_role(&c, SHARED, Some("editor")).unwrap();
    assert!(pending_ops(&c, 100)
        .unwrap()
        .iter()
        .any(|x| x.entity_id == p && x.workspace_id == SHARED));
}

#[test]
fn acces_retire_la_synchronisation_s_arrete_les_donnees_restent() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    join_workspace(&c, SHARED, "Équipe", "editor").unwrap();
    let p = page(&c, SHARED, None, "Mienne");
    let st = set_workspace_role(&c, SHARED, None).unwrap();
    assert!(
        st.workspaces.iter().all(|w| w.workspace_id != SHARED),
        "l'espace n'est plus synchronisé"
    );
    assert_eq!(
        tree::get(&c, &p).unwrap().title,
        "Mienne",
        "les données locales sont conservées"
    );
    assert!(
        pending_ops(&c, 100)
            .unwrap()
            .iter()
            .all(|x| x.entity_id != p),
        "ses opérations en attente sont abandonnées"
    );
    let err: String = c
        .query_row(
            "SELECT last_error FROM sync_state WHERE workspace_id = ?1",
            [SHARED],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(err, "access_removed");
    // plus rien n'est capturé pour cet espace
    tree::rename_node(&c, &p, "Renommée").unwrap();
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM oplog WHERE entity_id = ?1",
            [&p],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(set_workspace_role(&c, SHARED, Some("roi")).is_err());
    // ni appliquer du distant dessus
    assert!(apply_remote_nodes(&c, SHARED, &[], None).is_err());
}

#[test]
fn recevoir_les_donnees_d_un_espace_partage_sans_echo_et_sans_toucher_aux_autres() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    join_workspace(&c, SHARED, "Équipe", "editor").unwrap();
    let id = "0192f0a0-0000-7000-8000-0000000bb001";
    let r = apply_remote_nodes(
        &c,
        SHARED,
        &[rn(id, None, "Venue de l'équipe", "V1")],
        Some(10),
    )
    .unwrap();
    assert_eq!(r.applied, 1);
    assert_eq!(tree::get(&c, id).unwrap().workspace_id, SHARED);
    assert!(pending_ops(&c, 100).unwrap().is_empty(), "aucun écho");
    // curseurs indépendants par espace
    let cur = |w: &str| {
        c.query_row(
            "SELECT node_cursor FROM sync_state WHERE workspace_id = ?1",
            [w],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!((cur(SHARED), cur(&ws)), (10, 0));
    // un nœud de l'espace partagé ne peut pas être appliqué comme appartenant à l'autre
    assert!(apply_remote_nodes(&c, &ws, &[rn(id, None, "Détourné", "V1")], Some(11)).is_err());
    assert_eq!(tree::get(&c, id).unwrap().title, "Venue de l'équipe");
}

#[test]
fn desactiver_arrete_tous_les_espaces() {
    let (_d, c, ws) = setup();
    enable(&c, &ws).unwrap();
    join_workspace(&c, SHARED, "Équipe", "editor").unwrap();
    let st = disable(&c).unwrap();
    assert!(!st.enabled && st.workspaces.is_empty() && st.pending == 0);
    page(&c, SHARED, None, "x");
    assert_eq!(
        c.query_row("SELECT count(*) FROM oplog", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

// ── Suppression définitive propagée ────────────────────────────────────────────────────────────────

fn ack_all(c: &Connection) {
    let res: Vec<AckResult> = pending_ops(c, 1000)
        .unwrap()
        .iter()
        .map(|o| AckResult {
            op_id: o.op_id.clone(),
            status: "applied".into(),
            reason: None,
        })
        .collect();
    ack(c, &res).unwrap();
}

fn purge_ops(c: &Connection) -> Vec<(String, Value)> {
    pending_ops(c, 200)
        .unwrap()
        .into_iter()
        .filter(|o| o.fields.get("purged_at").is_some())
        .map(|o| (o.entity_id, o.fields))
        .collect()
}

#[test]
fn purger_emet_une_operation_par_noeud_avec_l_espace() {
    let (_d, c, ws) = setup();
    let folder = tree::create_node(&c, &ws, None, "folder", "D", None)
        .unwrap()
        .id;
    let child = page(&c, &ws, Some(&folder), "E");
    enable(&c, &ws).unwrap();
    ack_all(&c);
    tree::soft_delete(&c, &folder).unwrap();
    ack_all(&c);
    assert!(purge_ops(&c).is_empty());
    tree::purge(&c, &folder).unwrap();
    let p = purge_ops(&c);
    assert_eq!(p.len(), 2, "une opération par nœud purgé");
    // enfants avant parents, et l'espace est dans l'opération (le nœud n'existe plus)
    assert_eq!(p[0].0, child);
    assert_eq!(p[1].0, folder);
    assert!(p.iter().all(|(_, f)| f["workspace_id"] == ws.as_str()));
    // elles sont bien « envoyables » : espace retrouvé malgré la suppression
    let sent = pending_ops(&c, 200).unwrap();
    assert!(sent
        .iter()
        .any(|o| o.entity_id == folder && o.workspace_id == ws));
}

#[test]
fn purger_en_invite_ou_hors_espace_synchronise_ne_met_rien_en_file() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "A");
    tree::soft_delete(&c, &p).unwrap();
    tree::purge(&c, &p).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM oplog", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn recevoir_une_purge_supprime_la_copie_sans_echo_et_abandonne_le_local() {
    let (_d, c, ws) = setup();
    let parent = page(&c, &ws, None, "Parent");
    let kid = page(&c, &ws, Some(&parent), "Enfant");
    let victim = page(&c, &ws, None, "Victime");
    save(&c, &victim, "texte");
    enable(&c, &ws).unwrap();
    ack_all(&c);
    tree::soft_delete(&c, &parent).unwrap();
    ack_all(&c);
    // une modification locale en attente sur la victime sera abandonnée
    tree::rename_node(&c, &victim, "Renommée").unwrap();
    let mut gone_parent = rn(&parent, None, "", "a");
    gone_parent.purged_at = Some("2026-07-01T00:00:00Z".into());
    let mut gone_victim = rn(&victim, None, "", "b");
    gone_victim.purged_at = Some("2026-07-01T00:00:00Z".into());
    let mut unknown = rn("0192f0a0-0000-7000-8000-0000000fffff", None, "", "c");
    unknown.purged_at = Some("2026-07-01T00:00:00Z".into());
    let rep = apply_remote_nodes(&c, &ws, &[gone_parent, gone_victim, unknown], Some(10)).unwrap();
    assert_eq!(rep.applied, 2, "inconnu = ignoré, sans erreur");
    let count = |id: &str| -> i64 {
        c.query_row("SELECT count(*) FROM node WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap()
    };
    assert_eq!(count(&parent), 0);
    assert_eq!(count(&victim), 0);
    assert_eq!(count(&kid), 1, "l'enfant survit, remonté à la racine");
    let pid: Option<String> = c
        .query_row("SELECT parent_id FROM node WHERE id = ?1", [&kid], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(pid.is_none());
    assert_eq!(
        c.query_row(
            "SELECT count(*) FROM page_content WHERE node_id = ?1",
            [&victim],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    // aucun écho, et l'opération locale sur la victime est abandonnée
    assert!(purge_ops(&c).is_empty());
    assert!(pending_ops(&c, 200).unwrap().is_empty());
}

#[test]
fn purger_une_base_efface_aussi_ses_proprietes_vues_et_lignes() {
    let (_d, c, ws) = setup();
    let dbo = database::create_database(&c, &ws, None, "Base", "Nom", "V")
        .unwrap()
        .node
        .id;
    database::create_row(&c, &dbo, "Ligne", &serde_json::Map::new()).unwrap();
    enable(&c, &ws).unwrap();
    ack_all(&c);
    let mut n = rn(&dbo, None, "", "a");
    n.kind = "database".into();
    n.purged_at = Some("2026-07-01T00:00:00Z".into());
    apply_remote_nodes(&c, &ws, &[n], None).unwrap();
    for t in ["db_property", "db_view", "db_row"] {
        let k: i64 = c
            .query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(k, 0, "{t} doit être vide");
    }
}

// ── Commentaires partagés ──────────────────────────────────────────────────────────────────────────────────────────

use crate::comments;

const T1: &str = "0192f0a0-0000-7000-8000-0000000c0001";

fn fields_of<'a>(o: &'a [(String, String, Value)], entity: &str, id: &str) -> Vec<&'a Value> {
    o.iter()
        .filter(|(e, i, _)| e == entity && i == id)
        .map(|(_, _, f)| f)
        .collect()
}

#[test]
fn les_commentaires_sont_inscrits_fil_avant_message_avec_leur_espace() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    enable(&c, &ws).unwrap();
    ack_all(&c);
    let t = comments::create_thread(&c, T1, &p, "extrait", "Bonjour", Some("ada@x.y")).unwrap();
    let o = ops(&c);
    let ti = o
        .iter()
        .position(|(e, i, _)| e == "thread" && i == T1)
        .unwrap();
    let cid = &t.comments[0].id;
    let ci = o
        .iter()
        .position(|(e, i, _)| e == "comment" && i == cid)
        .unwrap();
    assert!(ti < ci, "le fil précède son message");
    assert_eq!(o[ti].2["node_id"], p.as_str());
    assert_eq!(o[ti].2["quote"], "extrait");
    assert_eq!(o[ci].2["thread_id"], T1);
    assert_eq!(o[ci].2["body"], "Bonjour");
    // l'auteur n'est JAMAIS envoyé : le serveur le déduit du jeton
    assert!(o[ci].2.get("author").is_none() && o[ti].2.get("created_by").is_none());
    // les opérations sont envoyables (espace retrouvé)
    assert!(pending_ops(&c, 100)
        .unwrap()
        .iter()
        .any(|x| x.entity == "thread" && x.workspace_id == ws));
}

#[test]
fn modifier_resoudre_et_supprimer_inscrivent_des_operations() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    enable(&c, &ws).unwrap();
    let t = comments::create_thread(&c, T1, &p, "q", "un", None).unwrap();
    let c1 = t.comments[0].id.clone();
    let c2 = comments::add_comment(&c, T1, "deux", None).unwrap().id;
    ack_all(&c);
    comments::edit_comment(&c, &c2, "deux bis").unwrap();
    comments::resolve(&c, T1, true, Some("ada@x.y")).unwrap();
    let o = ops(&c);
    assert_eq!(fields_of(&o, "comment", &c2)[0]["body"], "deux bis");
    assert!(fields_of(&o, "thread", T1)[0]["resolved_at"].is_string());
    ack_all(&c);
    comments::resolve(&c, T1, false, None).unwrap();
    assert!(fields_of(&ops(&c), "thread", T1)[0]["resolved_at"].is_null());
    ack_all(&c);
    // suppression d'un message : son espace est inscrit dans l'opération
    comments::delete_comment(&c, &c2).unwrap();
    let o = ops(&c);
    let d = fields_of(&o, "comment", &c2);
    assert_eq!(d.len(), 1);
    assert!(d[0]["deleted_at"].is_string());
    assert_eq!(d[0]["workspace_id"], ws.as_str());
    assert!(pending_ops(&c, 100)
        .unwrap()
        .iter()
        .any(|x| x.entity_id == c2 && x.workspace_id == ws));
    ack_all(&c);
    // dernier message supprimé → fil supprimé
    assert!(comments::delete_comment(&c, &c1).unwrap());
    let o = ops(&c);
    assert!(fields_of(&o, "thread", T1)[0]["deleted_at"].is_string());
    assert!(pending_ops(&c, 100)
        .unwrap()
        .iter()
        .any(|x| x.entity == "thread" && x.workspace_id == ws));
}

#[test]
fn purger_une_page_n_emet_pas_de_suppression_de_fil() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    enable(&c, &ws).unwrap();
    comments::create_thread(&c, T1, &p, "q", "un", None).unwrap();
    ack_all(&c);
    tree::soft_delete(&c, &p).unwrap();
    ack_all(&c);
    tree::purge(&c, &p).unwrap();
    let o = ops(&c);
    assert!(o.iter().all(|(e, _, _)| e != "thread" && e != "comment"));
    assert!(
        !purge_ops(&c).is_empty(),
        "la purge du nœud, elle, est bien envoyée"
    );
}

#[test]
fn invite_ou_espace_non_synchronise_aucune_operation_de_commentaire() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    comments::create_thread(&c, T1, &p, "q", "un", None).unwrap();
    assert_eq!(
        c.query_row("SELECT count(*) FROM oplog", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn activer_inscrit_les_commentaires_existants_fil_avant_message() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    comments::create_thread(&c, T1, &p, "q", "un", None).unwrap();
    enable(&c, &ws).unwrap();
    let o = ops(&c);
    let ti = o
        .iter()
        .position(|(e, i, _)| e == "thread" && i == T1)
        .unwrap();
    let ci = o.iter().position(|(e, _, _)| e == "comment").unwrap();
    assert!(ti < ci);
}

fn rthread(id: &str, node: &str) -> RemoteStruct {
    RemoteStruct::Thread {
        id: id.into(),
        node_id: node.into(),
        quote: "citation".into(),
        author_label: Some("bob@x.y".into()),
        created_at: "2026-06-01T10:00:00Z".into(),
        resolved_at: None,
        resolved_label: None,
        deleted_at: None,
    }
}
fn rcomment(id: &str, thread: &str, body: &str) -> RemoteStruct {
    RemoteStruct::Comment {
        id: id.into(),
        thread_id: thread.into(),
        body: body.into(),
        author_label: Some("bob@x.y".into()),
        created_at: "2026-06-01T10:01:00Z".into(),
        edited_at: None,
        deleted_at: None,
    }
}
const K1: &str = "0192f0a0-0000-7000-8000-0000000c1001";

#[test]
fn recevoir_fil_et_messages_sans_echo_avec_auteur_et_modifications() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    enable(&c, &ws).unwrap();
    ack_all(&c);
    let rep = apply_remote_struct(
        &c,
        &ws,
        &[rthread(T1, &p), rcomment(K1, T1, "Salut")],
        Some(7),
    )
    .unwrap();
    assert_eq!((rep.applied, rep.unresolved, rep.skipped), (2, 0, 0));
    let th = comments::thread(&c, T1).unwrap();
    assert_eq!(th.created_by.as_deref(), Some("bob@x.y"));
    assert_eq!(th.comments[0].body, "Salut");
    assert_eq!(th.comments[0].author.as_deref(), Some("bob@x.y"));
    assert!(pending_ops(&c, 100).unwrap().is_empty(), "aucun écho");
    assert_eq!(cursor(&c, "struct_cursor"), 7);
    // modification distante, résolution distante
    let mut edited = rcomment(K1, T1, "Salut !");
    if let RemoteStruct::Comment { edited_at, .. } = &mut edited {
        *edited_at = Some("2026-06-02T10:00:00Z".into());
    }
    let mut resolved = rthread(T1, &p);
    if let RemoteStruct::Thread {
        resolved_at,
        resolved_label,
        ..
    } = &mut resolved
    {
        *resolved_at = Some("2026-06-02T11:00:00Z".into());
        *resolved_label = Some("bob@x.y".into());
    }
    apply_remote_struct(&c, &ws, &[resolved, edited], None).unwrap();
    let th = comments::thread(&c, T1).unwrap();
    assert_eq!(th.comments[0].body, "Salut !");
    assert!(th.resolved_at.is_some());
    assert_eq!(th.resolved_by.as_deref(), Some("bob@x.y"));
    assert!(pending_ops(&c, 100).unwrap().is_empty());
}

#[test]
fn message_avant_son_fil_ou_page_absente_reste_non_resolu_sans_avancer_le_curseur() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    enable(&c, &ws).unwrap();
    ack_all(&c);
    let before = cursor(&c, "struct_cursor");
    let rep = apply_remote_struct(
        &c,
        &ws,
        &[
            rcomment(K1, T1, "x"),
            rthread(T1, "0192f0a0-0000-7000-8000-0000000fffff"),
        ],
        Some(9),
    )
    .unwrap();
    assert_eq!(rep.unresolved, 2);
    assert_eq!(cursor(&c, "struct_cursor"), before);
    // une fois le fil arrivé, la reprise aboutit
    let rep =
        apply_remote_struct(&c, &ws, &[rthread(T1, &p), rcomment(K1, T1, "x")], Some(9)).unwrap();
    assert_eq!(rep.unresolved, 0);
    assert_eq!(cursor(&c, "struct_cursor"), 9);
}

#[test]
fn modification_locale_en_attente_jamais_ecrasee_et_suppression_distante() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    enable(&c, &ws).unwrap();
    comments::create_thread(&c, T1, &p, "q", "local", Some("moi")).unwrap();
    let cid = comments::thread(&c, T1).unwrap().comments[0].id.clone();
    ack_all(&c);
    comments::edit_comment(&c, &cid, "mon brouillon").unwrap(); // en attente
    apply_remote_struct(&c, &ws, &[rcomment(&cid, T1, "version distante")], None).unwrap();
    assert_eq!(
        comments::thread(&c, T1).unwrap().comments[0].body,
        "mon brouillon"
    );
    ack_all(&c);
    // suppression distante du fil : tout disparaît localement, sans écho
    let mut gone = rthread(T1, &p);
    if let RemoteStruct::Thread { deleted_at, .. } = &mut gone {
        *deleted_at = Some("2026-07-01T00:00:00Z".into());
    }
    apply_remote_struct(&c, &ws, &[gone], None).unwrap();
    assert!(comments::thread(&c, T1).is_err());
    assert_eq!(
        c.query_row("SELECT count(*) FROM comment", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(pending_ops(&c, 100).unwrap().is_empty());
}

#[test]
fn contenu_distant_invalide_est_ignore_et_signale() {
    let (_d, c, ws) = setup();
    let p = page(&c, &ws, None, "P");
    enable(&c, &ws).unwrap();
    let mut bad = rthread(T1, &p);
    if let RemoteStruct::Thread { quote, .. } = &mut bad {
        *quote = "x".repeat(401);
    }
    let rep =
        apply_remote_struct(&c, &ws, &[bad, rcomment(K1, T1, &"y".repeat(5001))], None).unwrap();
    assert_eq!(rep.skipped, 2);
    assert!(comments::thread(&c, T1).is_err());
}
