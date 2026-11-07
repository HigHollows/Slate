//! Bases de données : propriétés typées, lignes (= pages), vues, relations.
//!
//! Principes :
//!  * toute écriture est validée ICI selon le type de la propriété (le front n'est jamais cru sur parole) ;
//!  * chaque mutation est atomique (une valeur et son rétro-lien de relation changent ensemble) ;
//!  * supprimer une propriété ou une ligne est réversible (suppression logique) ;
//!  * le titre d'une ligne est `node.title` ; les autres valeurs sont dans `db_row.props_json`.

use crate::db::begin;
use crate::error::{AppError, AppResult};
use crate::tree::{self, NodeRow};
use crate::{position, search};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub const PROPERTY_TYPES: &[&str] = &[
    "title",
    "text",
    "longtext",
    "number",
    "percent",
    "date",
    "datetime",
    "checkbox",
    "select",
    "multiselect",
    "status",
    "url",
    "email",
    "phone",
    "relation",
    "formula",
    "id",
    "created_time",
    "last_edited_time",
];
pub const LAYOUTS: &[&str] = &["table", "kanban", "list", "gallery", "calendar"];
const COMPUTED: &[&str] = &["title", "formula", "id", "created_time", "last_edited_time"];
const COLORS: &[&str] = &[
    "gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink",
];
const STATUS_GROUPS: &[&str] = &["todo", "doing", "done"];
const MAX_OPTIONS: usize = 200;
const MAX_RELATION: usize = 1000;
const MAX_PROPS: usize = 200;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PropertyOut {
    pub id: String,
    pub database_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub config: Value,
    pub position: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewOut {
    pub id: String,
    pub database_id: String,
    pub name: String,
    pub layout: String,
    pub config: Value,
    pub position: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowOut {
    pub id: String,
    pub database_id: String,
    pub title: String,
    pub props: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOut {
    pub node: NodeRow,
    pub properties: Vec<PropertyOut>,
    pub views: Vec<ViewOut>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellChange {
    pub row_id: String,
    pub property_id: String,
    pub value: Value,
}

fn invalid<T>(m: impl Into<String>) -> AppResult<T> {
    Err(AppError::Invalid(m.into()))
}

fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ── Dates (sans dépendance externe) ─────────────────────────────────────────────
fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

pub(crate) fn is_valid_date(s: &str) -> bool {
    parse_ymd(s).is_some()
}

fn parse_ymd(s: &str) -> Option<(i32, u32, u32)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i32 = s[0..4].parse().ok()?;
    let m: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&m)
        || d < 1
        || d > days_in_month(y, m)
        || !s[0..4].bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some((y, m, d))
}

/// `YYYY-MM-DD` valide.
pub fn valid_date(s: &str) -> bool {
    parse_ymd(s).is_some()
}

/// `YYYY-MM-DDTHH:MM[:SS]Z` (UTC) valide ; retourne la forme normalisée avec secondes.
pub fn normalize_datetime(s: &str) -> Option<String> {
    let (d, t) = s.split_once('T')?;
    parse_ymd(d)?;
    let t = t.strip_suffix('Z')?;
    let parts: Vec<&str> = t.split(':').collect();
    if parts.len() < 2
        || parts.len() > 3
        || parts
            .iter()
            .any(|p| p.len() != 2 || !p.bytes().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let (h, mi): (u32, u32) = (parts[0].parse().ok()?, parts[1].parse().ok()?);
    let sec: u32 = parts.get(2).map(|x| x.parse().ok()).unwrap_or(Some(0))?;
    if h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    Some(format!("{d}T{h:02}:{mi:02}:{sec:02}Z"))
}

// ── Chargement ──────────────────────────────────────────────────────────────────
pub(crate) fn node_db(conn: &Connection, id: &str) -> AppResult<NodeRow> {
    let n = tree::get(conn, id)?;
    if n.kind != "database" || n.deleted_at.is_some() {
        return Err(AppError::NotFound(format!("base de données {id}")));
    }
    Ok(n)
}

fn map_prop(r: &rusqlite::Row<'_>) -> rusqlite::Result<PropertyOut> {
    let cfg: String = r.get(4)?;
    Ok(PropertyOut {
        id: r.get(0)?,
        database_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        config: serde_json::from_str(&cfg).unwrap_or(Value::Object(Map::new())),
        position: r.get(5)?,
    })
}
const PROP_COLS: &str = "id, database_id, name, type, config_json, position";

pub fn properties(conn: &Connection, database_id: &str) -> AppResult<Vec<PropertyOut>> {
    let mut st = conn.prepare(&format!(
        "SELECT {PROP_COLS} FROM db_property WHERE database_id = ?1 AND deleted_at IS NULL ORDER BY position, id"
    ))?;
    let rows = st.query_map([database_id], map_prop)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn property(conn: &Connection, id: &str) -> AppResult<PropertyOut> {
    conn.query_row(
        &format!("SELECT {PROP_COLS} FROM db_property WHERE id = ?1 AND deleted_at IS NULL"),
        [id],
        map_prop,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("propriété {id}")))
}

fn map_view(r: &rusqlite::Row<'_>) -> rusqlite::Result<ViewOut> {
    let cfg: String = r.get(4)?;
    Ok(ViewOut {
        id: r.get(0)?,
        database_id: r.get(1)?,
        name: r.get(2)?,
        layout: r.get(3)?,
        config: serde_json::from_str(&cfg).unwrap_or(Value::Object(Map::new())),
        position: r.get(5)?,
    })
}
const VIEW_COLS: &str = "id, database_id, name, layout, config_json, position";

pub fn views(conn: &Connection, database_id: &str) -> AppResult<Vec<ViewOut>> {
    let mut st = conn.prepare(&format!(
        "SELECT {VIEW_COLS} FROM db_view WHERE database_id = ?1 AND deleted_at IS NULL ORDER BY position, id"
    ))?;
    let rows = st.query_map([database_id], map_view)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn view(conn: &Connection, id: &str) -> AppResult<ViewOut> {
    conn.query_row(
        &format!("SELECT {VIEW_COLS} FROM db_view WHERE id = ?1 AND deleted_at IS NULL"),
        [id],
        map_view,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("vue {id}")))
}

pub fn get_database(conn: &Connection, id: &str) -> AppResult<DatabaseOut> {
    let node = node_db(conn, id)?;
    Ok(DatabaseOut {
        node,
        properties: properties(conn, id)?,
        views: views(conn, id)?,
    })
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RowOut> {
    let props: String = r.get(3)?;
    Ok(RowOut {
        id: r.get(0)?,
        database_id: r.get(1)?,
        title: r.get(2)?,
        props: serde_json::from_str(&props).unwrap_or(Value::Object(Map::new())),
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}
const ROW_SELECT: &str =
    "SELECT n.id, r.database_id, n.title, r.props_json, n.created_at, n.updated_at
     FROM db_row r JOIN node n ON n.id = r.node_id";

pub fn rows(conn: &Connection, database_id: &str) -> AppResult<Vec<RowOut>> {
    node_db(conn, database_id)?;
    let mut st = conn.prepare(&format!(
        "{ROW_SELECT} WHERE r.database_id = ?1 AND n.deleted_at IS NULL ORDER BY n.position, n.id"
    ))?;
    let rs = st.query_map([database_id], map_row)?;
    Ok(rs.collect::<Result<_, _>>()?)
}

pub fn row(conn: &Connection, node_id: &str) -> AppResult<RowOut> {
    conn.query_row(
        &format!("{ROW_SELECT} WHERE r.node_id = ?1 AND n.deleted_at IS NULL"),
        [node_id],
        map_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("ligne {node_id}")))
}

/// Base à laquelle appartient un nœud (s'il s'agit d'une ligne).
pub fn database_of(conn: &Connection, node_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT database_id FROM db_row WHERE node_id = ?1",
            [node_id],
            |r| r.get(0),
        )
        .optional()?)
}

// ── Configuration des propriétés ────────────────────────────────────────────────
fn gen_id() -> String {
    uuid::Uuid::now_v7().simple().to_string()[12..28].to_string()
}

fn normalize_options(cfg: &Value, is_status: bool) -> AppResult<Value> {
    let raw = cfg
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if raw.len() > MAX_OPTIONS {
        return invalid("trop d'options");
    }
    let mut seen_ids = BTreeSet::new();
    let mut seen_names = BTreeSet::new();
    let mut out = Vec::new();
    for o in raw {
        let name = o
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() || name.chars().count() > 100 {
            return invalid("nom d'option invalide");
        }
        if !seen_names.insert(name.to_lowercase()) {
            return invalid(format!("option en double : {name}"));
        }
        let id = match o.get("id").and_then(Value::as_str) {
            Some(i) if is_ident(i) => i.to_string(),
            Some(_) => return invalid("identifiant d'option invalide"),
            None => gen_id(),
        };
        if !seen_ids.insert(id.clone()) {
            return invalid("identifiant d'option en double");
        }
        let color = o.get("color").and_then(Value::as_str).unwrap_or("gray");
        if !COLORS.contains(&color) {
            return invalid("couleur d'option inconnue");
        }
        let mut obj = json!({ "id": id, "name": name, "color": color });
        if is_status {
            let g = o.get("group").and_then(Value::as_str).unwrap_or("todo");
            if !STATUS_GROUPS.contains(&g) {
                return invalid("groupe de statut inconnu");
            }
            obj["group"] = json!(g);
        }
        out.push(obj);
    }
    Ok(json!({ "options": out }))
}

fn option_ids(cfg: &Value) -> BTreeSet<String> {
    cfg.get("options")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|o| o.get("id").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Valide et normalise la configuration d'une propriété (clés inconnues supprimées).
fn normalize_config(
    conn: &Connection,
    ws: &str,
    own_db: &str,
    kind: &str,
    cfg: &Value,
) -> AppResult<Value> {
    if !cfg.is_object() && !cfg.is_null() {
        return invalid("configuration invalide");
    }
    let cfg = if cfg.is_null() {
        json!({})
    } else {
        cfg.clone()
    };
    let role = cfg.get("role").and_then(Value::as_str).map(String::from);
    let mut out = match kind {
        "select" | "multiselect" => normalize_options(&cfg, false)?,
        "status" => {
            let c = if cfg.get("options").is_none() {
                json!({ "options": [
                    { "name": "À faire", "group": "todo", "color": "gray" },
                    { "name": "En cours", "group": "doing", "color": "blue" },
                    { "name": "Terminé", "group": "done", "color": "green" } ] })
            } else {
                cfg
            };
            normalize_options(&c, true)?
        }
        "number" | "percent" => {
            let dec = cfg
                .get("decimals")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(8);
            let mut o = json!({ "decimals": dec });
            for k in ["prefix", "suffix"] {
                if let Some(s) = cfg.get(k).and_then(Value::as_str) {
                    if s.chars().count() > 12 {
                        return invalid("préfixe/suffixe trop long");
                    }
                    o[k] = json!(s);
                }
            }
            o
        }
        "formula" => {
            let e = cfg.get("expression").and_then(Value::as_str).unwrap_or("");
            if e.chars().count() > 2000 {
                return invalid("formule trop longue (2000 caractères maximum)");
            }
            json!({ "expression": e })
        }
        "id" => {
            let p = cfg.get("prefix").and_then(Value::as_str).unwrap_or("");
            if p.chars().count() > 12 {
                return invalid("préfixe trop long");
            }
            json!({ "prefix": p })
        }
        "relation" => {
            let target = cfg
                .get("targetDatabaseId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Invalid("base cible manquante".into()))?;
            let t = node_db(conn, target)?;
            if t.workspace_id != ws {
                return invalid("la base cible appartient à un autre espace");
            }
            let mut o = json!({ "targetDatabaseId": target });
            if let Some(rp) = cfg.get("reversePropertyId").and_then(Value::as_str) {
                o["reversePropertyId"] = json!(rp);
            }
            let _ = own_db;
            o
        }
        _ => json!({}),
    };
    // Rôle fonctionnel (échéance, début, récurrence, rappel) : liste blanche, compatible avec le type.
    if let Some(r) = role {
        let ok = match r.as_str() {
            "due" | "start" | "reminder" => matches!(kind, "date" | "datetime"),
            "recurrence" => kind == "select",
            "habit_goal" => kind == "number",
            _ => return invalid("rôle de propriété inconnu"),
        };
        if !ok {
            return invalid("ce rôle n'est pas compatible avec le type de la propriété");
        }
        out["role"] = json!(r);
    }
    Ok(out)
}

// ── Création / modification des propriétés ──────────────────────────────────────
fn unique_name(conn: &Connection, db: &str, wanted: &str, except: Option<&str>) -> AppResult<()> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM db_property WHERE database_id = ?1 AND lower(name) = lower(?2)
         AND deleted_at IS NULL AND id IS NOT ?3",
        params![db, wanted, except],
        |r| r.get(0),
    )?;
    if n > 0 {
        return invalid(format!("une propriété nommée « {wanted} » existe déjà"));
    }
    Ok(())
}

fn clean_name(name: &str) -> AppResult<String> {
    let n = name.trim().replace(['\n', '\r'], " ");
    if n.is_empty() || n.chars().count() > 200 {
        return invalid("nom de propriété invalide");
    }
    Ok(n)
}

fn insert_property(
    conn: &Connection,
    db: &str,
    name: &str,
    kind: &str,
    cfg: &Value,
    before_id: Option<&str>,
) -> AppResult<PropertyOut> {
    let props = properties(conn, db)?;
    let (prev, next): (Option<&str>, Option<&str>) = match before_id {
        None => (props.last().map(|p| p.position.as_str()), None),
        Some(b) => {
            let i = props
                .iter()
                .position(|p| p.id == b)
                .ok_or_else(|| AppError::NotFound("repère de colonne".into()))?;
            (
                if i == 0 {
                    None
                } else {
                    Some(props[i - 1].position.as_str())
                },
                Some(props[i].position.as_str()),
            )
        }
    };
    let pos = position::between(prev, next).map_err(AppError::Invalid)?;
    let id = uuid::Uuid::now_v7().to_string();
    let ts = tree::now(conn)?;
    conn.execute(
        "INSERT INTO db_property (id, database_id, name, type, config_json, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, db, name, kind, cfg.to_string(), pos, ts],
    )?;
    property(conn, &id)
}

pub fn create_database(
    conn: &Connection,
    workspace_id: &str,
    parent_id: Option<&str>,
    title: &str,
    title_property_name: &str,
    view_name: &str,
) -> AppResult<DatabaseOut> {
    let tx = begin(conn)?;
    let node = tree::create_node(&tx, workspace_id, parent_id, "database", title, None)?;
    tx.execute("INSERT INTO db_meta (database_id) VALUES (?1)", [&node.id])?;
    insert_property(
        &tx,
        &node.id,
        &clean_name(title_property_name)?,
        "title",
        &json!({}),
        None,
    )?;
    create_view_inner(&tx, &node.id, view_name, "table", &json!({}))?;
    let out = get_database(&tx, &node.id)?;
    tx.commit()?;
    Ok(out)
}

pub fn create_property(
    conn: &Connection,
    database_id: &str,
    name: &str,
    kind: &str,
    config: &Value,
    before_id: Option<&str>,
    two_way_name: Option<&str>,
) -> AppResult<PropertyOut> {
    if !PROPERTY_TYPES.contains(&kind) || kind == "title" {
        return invalid("type de propriété non autorisé");
    }
    let tx = begin(conn)?;
    let db = node_db(&tx, database_id)?;
    if properties(&tx, database_id)?.len() >= MAX_PROPS {
        return invalid("nombre maximal de propriétés atteint");
    }
    let name = clean_name(name)?;
    unique_name(&tx, database_id, &name, None)?;
    let cfg = normalize_config(&tx, &db.workspace_id, database_id, kind, config)?;
    let prop = insert_property(&tx, database_id, &name, kind, &cfg, before_id)?;

    if kind == "id" {
        // Numérote les lignes existantes dans l'ordre d'affichage.
        for r in rows(&tx, database_id)? {
            let n = next_auto_id(&tx, database_id)?;
            set_prop_raw(&tx, &r.id, &prop.id, Some(json!(n)))?;
        }
    }
    if kind == "relation" {
        let target = cfg["targetDatabaseId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if let Some(rev_name) = two_way_name {
            let rev_name = clean_name(rev_name)?;
            let mut rev_cfg =
                json!({ "targetDatabaseId": database_id, "reversePropertyId": prop.id });
            if target == database_id {
                // Auto-relation : la propriété inverse est une seconde colonne de la même base.
                unique_name(&tx, &target, &rev_name, None)?;
            } else {
                unique_name(&tx, &target, &rev_name, None)?;
            }
            rev_cfg["targetDatabaseId"] = json!(database_id);
            let rev = insert_property(&tx, &target, &rev_name, "relation", &rev_cfg, None)?;
            let mut c = cfg.clone();
            c["reversePropertyId"] = json!(rev.id);
            tx.execute(
                "UPDATE db_property SET config_json = ?2 WHERE id = ?1",
                params![prop.id, c.to_string()],
            )?;
        }
    }
    let out = property(&tx, &prop.id)?;
    tx.commit()?;
    Ok(out)
}

/// Conversions de type SANS perte uniquement.
fn convertible(from: &str, to: &str) -> bool {
    from == to
        || matches!(
            (from, to),
            ("text", "longtext" | "url" | "email" | "phone")
                | ("longtext", "text")
                | ("url" | "email" | "phone", "text" | "longtext")
                | ("number", "percent")
                | ("percent", "number")
                | ("date", "datetime")
                | ("select", "multiselect" | "status")
                | ("status", "select")
        )
}

fn convert_value(from: &str, to: &str, v: &Value) -> Value {
    match (from, to, v) {
        ("date", "datetime", Value::String(s)) => json!(format!("{s}T00:00:00Z")),
        ("select", "multiselect", Value::String(s)) => json!([s]),
        _ => v.clone(),
    }
}

pub fn update_property(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    config: Option<&Value>,
    new_type: Option<&str>,
) -> AppResult<PropertyOut> {
    let tx = begin(conn)?;
    let cur = property(&tx, id)?;
    let db = node_db(&tx, &cur.database_id)?;
    let ts = tree::now(&tx)?;
    let target_kind = new_type.unwrap_or(&cur.kind);
    if !PROPERTY_TYPES.contains(&target_kind) {
        return invalid("type de propriété inconnu");
    }
    if cur.kind == "title" && target_kind != "title" {
        return invalid("le type de la propriété titre ne peut pas changer");
    }
    if !convertible(&cur.kind, target_kind) {
        return invalid(format!(
            "conversion de « {} » vers « {} » impossible sans perte : créez une nouvelle propriété",
            cur.kind, target_kind
        ));
    }
    if let Some(n) = name {
        let n = clean_name(n)?;
        unique_name(&tx, &cur.database_id, &n, Some(id))?;
        tx.execute(
            "UPDATE db_property SET name = ?2 WHERE id = ?1",
            params![id, n],
        )?;
    }
    let mut new_cfg = match config {
        Some(c) => normalize_config(&tx, &db.workspace_id, &cur.database_id, target_kind, c)?,
        None if target_kind != cur.kind => normalize_config(
            &tx,
            &db.workspace_id,
            &cur.database_id,
            target_kind,
            &cur.config,
        )?,
        None => cur.config.clone(),
    };
    if cur.kind == "relation" {
        if new_cfg["targetDatabaseId"] != cur.config["targetDatabaseId"] {
            return invalid("la base cible d'une relation ne peut pas changer");
        }
        if let Some(r) = cur.config.get("reversePropertyId") {
            new_cfg["reversePropertyId"] = r.clone(); // le lien inverse n'est pas modifiable ici
        }
    }
    // Options : conversion select→status etc. exige que toutes les options utilisées subsistent ; une option
    // supprimée est retirée des valeurs existantes (action explicite de l'utilisateur).
    if matches!(cur.kind.as_str(), "select" | "multiselect" | "status") {
        let old_ids = option_ids(&cur.config);
        let new_ids = option_ids(&new_cfg);
        let removed: Vec<&String> = old_ids.difference(&new_ids).collect();
        if target_kind != cur.kind && !removed.is_empty() {
            return invalid("une conversion de type ne peut pas supprimer d'options");
        }
        if !removed.is_empty() {
            for r in rows(&tx, &cur.database_id)? {
                if let Some(v) = r.props.get(id) {
                    let cleaned = match v {
                        Value::String(s) if removed.contains(&s) => None,
                        Value::Array(a) => {
                            let kept: Vec<Value> = a
                                .iter()
                                .filter(|x| {
                                    !x.as_str()
                                        .is_some_and(|s| removed.iter().any(|d| d.as_str() == s))
                                })
                                .cloned()
                                .collect();
                            if kept.len() == a.len() {
                                continue;
                            }
                            if kept.is_empty() {
                                None
                            } else {
                                Some(Value::Array(kept))
                            }
                        }
                        _ => continue,
                    };
                    set_prop_raw(&tx, &r.id, id, cleaned)?;
                }
            }
        }
    }
    if target_kind != cur.kind {
        for r in rows(&tx, &cur.database_id)? {
            if let Some(v) = r.props.get(id) {
                set_prop_raw(
                    &tx,
                    &r.id,
                    id,
                    Some(convert_value(&cur.kind, target_kind, v)),
                )?;
            }
        }
    }
    tx.execute(
        "UPDATE db_property SET type = ?2, config_json = ?3, updated_at = ?4, version = version + 1 WHERE id = ?1",
        params![id, target_kind, new_cfg.to_string(), ts],
    )?;
    for r in rows(&tx, &cur.database_id)? {
        search::reindex(&tx, &r.id)?;
    }
    let out = property(&tx, id)?;
    tx.commit()?;
    Ok(out)
}

/// Suppression logique : les valeurs restent dans les lignes (récupérables), la colonne disparaît.
pub fn delete_property(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = begin(conn)?;
    let cur = property(&tx, id)?;
    if cur.kind == "title" {
        return invalid("la propriété titre ne peut pas être supprimée");
    }
    let ts = tree::now(&tx)?;
    tx.execute(
        "UPDATE db_property SET deleted_at = ?2, version = version + 1 WHERE id = ?1",
        params![id, ts],
    )?;
    // Détache le rétro-lien d'une relation à double sens (l'autre côté devient à sens unique).
    if let Some(rp) = cur.config.get("reversePropertyId").and_then(Value::as_str) {
        if let Ok(rev) = property(&tx, rp) {
            let mut c = rev.config.clone();
            if let Some(o) = c.as_object_mut() {
                o.remove("reversePropertyId");
            }
            tx.execute(
                "UPDATE db_property SET config_json = ?2 WHERE id = ?1",
                params![rp, c.to_string()],
            )?;
        }
    }
    for r in rows(&tx, &cur.database_id)? {
        search::reindex(&tx, &r.id)?;
    }
    tx.commit()
}

pub fn move_property(
    conn: &Connection,
    id: &str,
    before_id: Option<&str>,
) -> AppResult<PropertyOut> {
    let tx = begin(conn)?;
    let cur = property(&tx, id)?;
    let others: Vec<PropertyOut> = properties(&tx, &cur.database_id)?
        .into_iter()
        .filter(|p| p.id != id)
        .collect();
    let (prev, next): (Option<&str>, Option<&str>) = match before_id {
        None => (others.last().map(|p| p.position.as_str()), None),
        Some(b) => {
            let i = others
                .iter()
                .position(|p| p.id == b)
                .ok_or_else(|| AppError::NotFound("repère de colonne".into()))?;
            (
                if i == 0 {
                    None
                } else {
                    Some(others[i - 1].position.as_str())
                },
                Some(others[i].position.as_str()),
            )
        }
    };
    let pos = position::between(prev, next).map_err(AppError::Invalid)?;
    tx.execute(
        "UPDATE db_property SET position = ?2, version = version + 1 WHERE id = ?1",
        params![id, pos],
    )?;
    let out = property(&tx, id)?;
    tx.commit()?;
    Ok(out)
}

// ── Vues ────────────────────────────────────────────────────────────────────────
fn check_view(name: &str, layout: &str, config: &Value) -> AppResult<String> {
    let n = clean_name(name)?;
    if !LAYOUTS.contains(&layout) {
        return invalid("type de vue inconnu");
    }
    if !config.is_object() || config.to_string().len() > 60_000 {
        return invalid("configuration de vue invalide ou trop volumineuse");
    }
    Ok(n)
}

fn create_view_inner(
    conn: &Connection,
    db: &str,
    name: &str,
    layout: &str,
    config: &Value,
) -> AppResult<ViewOut> {
    let name = check_view(name, layout, config)?;
    let vs = views(conn, db)?;
    let pos = position::between(vs.last().map(|v| v.position.as_str()), None)
        .map_err(AppError::Invalid)?;
    let id = uuid::Uuid::now_v7().to_string();
    let ts = tree::now(conn)?;
    conn.execute(
        "INSERT INTO db_view (id, database_id, name, layout, config_json, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, db, name, layout, config.to_string(), pos, ts],
    )?;
    view(conn, &id)
}

pub fn create_view(
    conn: &Connection,
    db: &str,
    name: &str,
    layout: &str,
    config: &Value,
) -> AppResult<ViewOut> {
    let tx = begin(conn)?;
    node_db(&tx, db)?;
    if views(&tx, db)?.len() >= 50 {
        return invalid("nombre maximal de vues atteint");
    }
    let v = create_view_inner(&tx, db, name, layout, config)?;
    tx.commit()?;
    Ok(v)
}

pub fn update_view(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    config: Option<&Value>,
) -> AppResult<ViewOut> {
    let tx = begin(conn)?;
    let cur = view(&tx, id)?;
    let n = check_view(
        name.unwrap_or(&cur.name),
        &cur.layout,
        config.unwrap_or(&cur.config),
    )?;
    let ts = tree::now(&tx)?;
    tx.execute(
        "UPDATE db_view SET name = ?2, config_json = ?3, updated_at = ?4, version = version + 1 WHERE id = ?1",
        params![id, n, config.unwrap_or(&cur.config).to_string(), ts],
    )?;
    let out = view(&tx, id)?;
    tx.commit()?;
    Ok(out)
}

pub fn delete_view(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = begin(conn)?;
    let cur = view(&tx, id)?;
    if views(&tx, &cur.database_id)?.len() <= 1 {
        return invalid("une base doit conserver au moins une vue");
    }
    let ts = tree::now(&tx)?;
    tx.execute(
        "UPDATE db_view SET deleted_at = ?2, version = version + 1 WHERE id = ?1",
        params![id, ts],
    )?;
    tx.commit()
}

// ── Valeurs ─────────────────────────────────────────────────────────────────────
fn next_auto_id(conn: &Connection, db: &str) -> AppResult<i64> {
    let n: i64 = conn.query_row(
        "SELECT next_auto_id FROM db_meta WHERE database_id = ?1",
        [db],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE db_meta SET next_auto_id = next_auto_id + 1 WHERE database_id = ?1",
        [db],
    )?;
    Ok(n)
}

/// Écrit (ou efface avec `None`) une valeur brute, sans validation (usage interne après validation).
fn set_prop_raw(conn: &Connection, row_id: &str, prop_id: &str, v: Option<Value>) -> AppResult<()> {
    let cur: String = conn.query_row(
        "SELECT props_json FROM db_row WHERE node_id = ?1",
        [row_id],
        |r| r.get(0),
    )?;
    let mut m: Map<String, Value> = serde_json::from_str(&cur).unwrap_or_default();
    match v {
        Some(v) if !v.is_null() => m.insert(prop_id.to_string(), v),
        _ => m.remove(prop_id),
    };
    conn.execute(
        "UPDATE db_row SET props_json = ?2 WHERE node_id = ?1",
        params![row_id, Value::Object(m).to_string()],
    )?;
    Ok(())
}

fn text_len(v: &Value, max: usize, what: &str) -> AppResult<String> {
    let s = v
        .as_str()
        .ok_or_else(|| AppError::Invalid(format!("{what} : texte attendu")))?;
    if s.chars().count() > max {
        return invalid(format!("{what} trop long (maximum {max} caractères)"));
    }
    if s.chars().any(|c| c == '\0') {
        return invalid(format!("{what} : caractère interdit"));
    }
    Ok(s.to_string())
}

/// Valide une valeur selon la propriété. Retourne la valeur normalisée (`Null` = effacer).
fn validate_value(conn: &Connection, ws: &str, prop: &PropertyOut, v: &Value) -> AppResult<Value> {
    if COMPUTED.contains(&prop.kind.as_str()) {
        return invalid(format!(
            "la propriété « {} » est calculée : elle ne s'édite pas",
            prop.name
        ));
    }
    if v.is_null() {
        return Ok(Value::Null);
    }
    Ok(match prop.kind.as_str() {
        "text" | "longtext" => {
            let s = text_len(
                v,
                if prop.kind == "text" { 10_000 } else { 100_000 },
                "texte",
            )?;
            if s.is_empty() {
                Value::Null
            } else {
                json!(s)
            }
        }
        "url" => {
            let s = text_len(v, 2000, "adresse")?;
            let l = s.to_lowercase();
            if s.is_empty() {
                Value::Null
            } else if !(l.starts_with("http://") || l.starts_with("https://"))
                || s.chars().any(|c| c.is_whitespace() || c.is_control())
                || s.len() < 11
            {
                return invalid("adresse invalide : http:// ou https:// requis");
            } else {
                json!(s)
            }
        }
        "email" => {
            let s = text_len(v, 320, "e-mail")?;
            if s.is_empty() {
                Value::Null
            } else {
                let ok = s.matches('@').count() == 1
                    && !s.chars().any(|c| c.is_whitespace() || c.is_control())
                    && s.split_once('@').is_some_and(|(l, d)| {
                        !l.is_empty() && d.contains('.') && !d.starts_with('.') && !d.ends_with('.')
                    });
                if !ok {
                    return invalid("adresse e-mail invalide");
                }
                json!(s)
            }
        }
        "phone" => {
            let s = text_len(v, 40, "téléphone")?;
            if s.is_empty() {
                Value::Null
            } else if !s
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | '(' | ')' | ' '))
                || !s.chars().any(|c| c.is_ascii_digit())
            {
                return invalid("numéro de téléphone invalide");
            } else {
                json!(s)
            }
        }
        "number" | "percent" => {
            let n = v
                .as_f64()
                .ok_or_else(|| AppError::Invalid("nombre attendu".into()))?;
            if !n.is_finite() || n.abs() > 1e15 {
                return invalid("nombre hors limites");
            }
            json!(n)
        }
        "checkbox" => json!(v
            .as_bool()
            .ok_or_else(|| AppError::Invalid("booléen attendu".into()))?),
        "date" => {
            let s = v.as_str().unwrap_or("");
            if !valid_date(s) {
                return invalid("date invalide (AAAA-MM-JJ)");
            }
            json!(s)
        }
        "datetime" => match v.as_str().and_then(normalize_datetime) {
            Some(s) => json!(s),
            None => return invalid("date et heure invalides (AAAA-MM-JJTHH:MM:SSZ, UTC)"),
        },
        "select" | "status" => {
            let s = v
                .as_str()
                .ok_or_else(|| AppError::Invalid("option attendue".into()))?;
            if !option_ids(&prop.config).contains(s) {
                return invalid("option inconnue");
            }
            json!(s)
        }
        "multiselect" => {
            let a = v
                .as_array()
                .ok_or_else(|| AppError::Invalid("liste d'options attendue".into()))?;
            let ids = option_ids(&prop.config);
            let mut seen = BTreeSet::new();
            let mut out = Vec::new();
            for x in a {
                let s = x
                    .as_str()
                    .ok_or_else(|| AppError::Invalid("option attendue".into()))?;
                if !ids.contains(s) {
                    return invalid("option inconnue");
                }
                if seen.insert(s.to_string()) {
                    out.push(json!(s));
                }
            }
            if out.len() > 100 {
                return invalid("trop d'options sélectionnées");
            }
            if out.is_empty() {
                Value::Null
            } else {
                Value::Array(out)
            }
        }
        "relation" => {
            let a = v
                .as_array()
                .ok_or_else(|| AppError::Invalid("liste de lignes attendue".into()))?;
            if a.len() > MAX_RELATION {
                return invalid("trop de lignes liées");
            }
            let target = prop.config["targetDatabaseId"].as_str().unwrap_or_default();
            let mut seen = BTreeSet::new();
            let mut out = Vec::new();
            for x in a {
                let id = x
                    .as_str()
                    .ok_or_else(|| AppError::Invalid("identifiant de ligne attendu".into()))?;
                if !seen.insert(id.to_string()) {
                    continue;
                }
                // Anti-contournement : la ligne doit exister, être vivante, appartenir à la base cible ET au même espace.
                let ok: i64 = conn.query_row(
                    "SELECT count(*) FROM db_row r JOIN node n ON n.id = r.node_id
                     WHERE r.node_id = ?1 AND r.database_id = ?2 AND n.deleted_at IS NULL AND n.workspace_id = ?3",
                    params![id, target, ws],
                    |r| r.get(0),
                )?;
                if ok == 0 {
                    return invalid("ligne introuvable dans la base liée");
                }
                out.push(json!(id));
            }
            if out.is_empty() {
                Value::Null
            } else {
                Value::Array(out)
            }
        }
        other => return invalid(format!("type non éditable : {other}")),
    })
}

fn id_list(v: Option<&Value>) -> BTreeSet<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Applique des modifications de cellules, atomiquement, avec maintien des relations à double sens.
/// Retourne les lignes modifiées (y compris celles touchées par un rétro-lien).
pub fn set_cells(conn: &Connection, changes: &[CellChange]) -> AppResult<Vec<RowOut>> {
    if changes.is_empty() || changes.len() > 10_000 {
        return invalid("nombre de modifications invalide");
    }
    let tx = begin(conn)?;
    let mut touched: Vec<String> = Vec::new();
    let mut completions: Vec<(String, PropertyOut)> = Vec::new();
    let mut touch = |id: &str| {
        if !touched.iter().any(|t| t == id) {
            touched.push(id.to_string());
        }
    };
    for c in changes {
        let r = row(&tx, &c.row_id)?;
        let node = tree::get(&tx, &c.row_id)?;
        let prop = property(&tx, &c.property_id)?;
        if prop.database_id != r.database_id {
            return invalid("cette propriété n'appartient pas à la base de la ligne");
        }
        let value = validate_value(&tx, &node.workspace_id, &prop, &c.value)?;
        let before = r.props.get(&prop.id).cloned();
        if prop.kind == "status"
            && status_group(&prop, &value) == Some("done")
            && status_group(&prop, before.as_ref().unwrap_or(&Value::Null)) != Some("done")
        {
            completions.push((c.row_id.clone(), prop.clone()));
        }
        set_prop_raw(&tx, &c.row_id, &prop.id, Some(value.clone()))?;
        touch(&c.row_id);

        if prop.kind == "relation" {
            if let Some(rev_id) = prop.config.get("reversePropertyId").and_then(Value::as_str) {
                let old = id_list(before.as_ref());
                let new = id_list(Some(&value));
                for gone in old.difference(&new) {
                    modify_reverse(&tx, gone, rev_id, &c.row_id, false)?;
                    touch(gone);
                }
                for added in new.difference(&old) {
                    modify_reverse(&tx, added, rev_id, &c.row_id, true)?;
                    touch(added);
                }
            }
        }
    }
    for (row_id, prop) in &completions {
        if let Some(new_id) = spawn_next_occurrence(&tx, row_id, prop)? {
            touch(&new_id);
        }
    }
    let ts = tree::now(&tx)?;
    let mut out = Vec::new();
    for id in &touched {
        tx.execute(
            "UPDATE node SET updated_at = ?2, version = version + 1 WHERE id = ?1",
            params![id, ts],
        )?;
        search::reindex(&tx, id)?;
        out.push(row(&tx, id)?);
    }
    tx.commit()?;
    Ok(out)
}

// ── Récurrence ──────────────────────────────────────────────────────────────────
fn status_group<'a>(prop: &'a PropertyOut, v: &Value) -> Option<&'a str> {
    let id = v.as_str()?;
    prop.config
        .get("options")?
        .as_array()?
        .iter()
        .find(|o| o.get("id").and_then(Value::as_str) == Some(id))?
        .get("group")?
        .as_str()
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn month_len(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// Décale une date (`AAAA-MM-JJ`) ou date-heure UTC (`AAAA-MM-JJTHH:MM:SSZ`) d'un intervalle de récurrence.
/// Mois/années : le jour est ramené à la fin du mois si besoin (31 janv. + 1 mois = 28/29 févr.).
/// L'heure UTC est conservée telle quelle (pas de recalcul des changements d'heure locaux).
pub(crate) fn add_interval(v: &str, rule: &str) -> Option<String> {
    if v.len() < 10 || !v.is_char_boundary(10) {
        return None;
    }
    let y: i64 = v.get(0..4)?.parse().ok()?;
    let m: i64 = v.get(5..7)?.parse().ok()?;
    let d: i64 = v.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > month_len(y, m) {
        return None;
    }
    let (ny, nm, nd) = match rule {
        "daily" | "weekly" => {
            civil_from_days(days_from_civil(y, m, d) + if rule == "daily" { 1 } else { 7 })
        }
        "monthly" | "yearly" => {
            let total = y * 12 + (m - 1) + if rule == "monthly" { 1 } else { 12 };
            let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) + 1);
            (ny, nm, d.min(month_len(ny, nm)))
        }
        _ => return None,
    };
    if !(1..=9999).contains(&ny) {
        return None;
    }
    Some(format!("{ny:04}-{nm:02}-{nd:02}{}", &v[10..]))
}

/// Quand une tâche récurrente passe à « terminé », crée l'occurrence suivante dans la même transaction
/// (échéance et début décalés depuis l'échéance précédente, statut remis au premier « à faire »).
/// Sans rôle `recurrence`/`due` ou sans échéance/règle valide : rien n'est créé. Retourne l'id de la nouvelle ligne.
fn spawn_next_occurrence(
    conn: &Connection,
    row_id: &str,
    status_prop: &PropertyOut,
) -> AppResult<Option<String>> {
    let r = row(conn, row_id)?;
    let props = properties(conn, &r.database_id)?;
    let by_role = |role: &str| {
        props
            .iter()
            .find(|p| p.config.get("role").and_then(Value::as_str) == Some(role))
    };
    let (Some(rec), Some(due)) = (by_role("recurrence"), by_role("due")) else {
        return Ok(None);
    };
    let Some(rule) = r.props.get(&rec.id).and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(old_due) = r.props.get(&due.id).and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(new_due) = add_interval(old_due, rule) else {
        return Ok(None);
    };
    let Some(todo) = status_prop
        .config
        .get("options")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .find(|o| o.get("group").and_then(Value::as_str) == Some("todo"))
        })
        .and_then(|o| o.get("id").and_then(Value::as_str))
    else {
        return Ok(None);
    };
    let mut initial = Map::new();
    for p in &props {
        let Some(v) = r.props.get(&p.id) else {
            continue;
        };
        match p.kind.as_str() {
            "status" | "percent" | "relation" | "formula" | "id" | "created_time"
            | "last_edited_time" | "title" => {}
            _ if p.id == due.id => {}
            _ if p.config.get("role").and_then(Value::as_str) == Some("start") => {
                if let Some(s) = v.as_str().and_then(|s| add_interval(s, rule)) {
                    initial.insert(p.id.clone(), json!(s));
                }
            }
            _ => {
                initial.insert(p.id.clone(), v.clone());
            }
        }
    }
    initial.insert(due.id.clone(), json!(new_due));
    initial.insert(status_prop.id.clone(), json!(todo));
    let title = tree::get(conn, row_id)?.title;
    let created = create_row(conn, &r.database_id, &title, &initial)?;
    Ok(Some(created.id))
}

fn modify_reverse(
    conn: &Connection,
    row_id: &str,
    rev_prop: &str,
    other: &str,
    add: bool,
) -> AppResult<()> {
    let Ok(r) = row(conn, row_id) else {
        return Ok(());
    };
    let mut set = id_list(r.props.get(rev_prop));
    let changed = if add {
        set.insert(other.to_string())
    } else {
        set.remove(other)
    };
    if changed {
        let v = if set.is_empty() {
            None
        } else {
            Some(Value::Array(set.into_iter().map(Value::String).collect()))
        };
        set_prop_raw(conn, row_id, rev_prop, v)?;
    }
    Ok(())
}

pub fn create_row(
    conn: &Connection,
    database_id: &str,
    title: &str,
    initial: &Map<String, Value>,
) -> AppResult<RowOut> {
    let tx = begin(conn)?;
    let db = node_db(&tx, database_id)?;
    let node = tree::create_row_node(&tx, &db, title)?;
    tx.execute(
        "INSERT INTO db_row (node_id, database_id, props_json) VALUES (?1, ?2, '{}')",
        params![node.id, database_id],
    )?;
    for p in properties(&tx, database_id)? {
        if p.kind == "id" {
            let n = next_auto_id(&tx, database_id)?;
            set_prop_raw(&tx, &node.id, &p.id, Some(json!(n)))?;
        }
    }
    let changes: Vec<CellChange> = initial
        .iter()
        .map(|(k, v)| CellChange {
            row_id: node.id.clone(),
            property_id: k.clone(),
            value: v.clone(),
        })
        .collect();
    if !changes.is_empty() {
        set_cells(&tx, &changes)?;
    }
    search::reindex(&tx, &node.id)?;
    let out = row(&tx, &node.id)?;
    tx.commit()?;
    Ok(out)
}

/// Mise à la corbeille de plusieurs lignes en une transaction.
pub fn delete_rows(conn: &Connection, ids: &[String]) -> AppResult<usize> {
    if ids.len() > 10_000 {
        return invalid("trop de lignes");
    }
    let tx = begin(conn)?;
    let mut n = 0;
    for id in ids {
        if !tree::is_row(&tx, id)? {
            return invalid("l'élément n'est pas une ligne de base de données");
        }
        n += tree::soft_delete(&tx, id)?;
    }
    tx.commit()?;
    Ok(n)
}

#[cfg(test)]
mod tests;
