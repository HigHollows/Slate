//! Arbre de contenus : espaces, dossiers, pages, sous-pages. Déplacement, favoris, corbeille, récents.
//! Toutes les mutations sont transactionnelles ; la suppression est logique (corbeille) par défaut.

use crate::error::{AppError, AppResult};
use crate::{position, search};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

pub const MAX_DEPTH: usize = 32;
pub const MAX_TITLE_CHARS: usize = 500;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeRow {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub position: String,
    pub is_favorite: bool,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

const COLS: &str =
    "id, workspace_id, parent_id, kind, title, position, is_favorite, updated_at, deleted_at";

fn map(r: &Row<'_>) -> rusqlite::Result<NodeRow> {
    Ok(NodeRow {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        parent_id: r.get(2)?,
        kind: r.get(3)?,
        title: r.get(4)?,
        position: r.get(5)?,
        is_favorite: r.get::<_, i64>(6)? == 1,
        updated_at: r.get(7)?,
        deleted_at: r.get(8)?,
    })
}

pub fn now(conn: &Connection) -> AppResult<String> {
    Ok(
        conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
            r.get(0)
        })?,
    )
}

pub fn get(conn: &Connection, id: &str) -> AppResult<NodeRow> {
    conn.query_row(&format!("SELECT {COLS} FROM node WHERE id = ?1"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("nœud {id}")))
}

fn get_live(conn: &Connection, id: &str) -> AppResult<NodeRow> {
    let n = get(conn, id)?;
    if n.deleted_at.is_some() {
        return Err(AppError::NotFound(format!("nœud {id} (dans la corbeille)")));
    }
    Ok(n)
}

fn clean_title(t: &str) -> AppResult<String> {
    let t = t.replace(['\n', '\r'], " ");
    if t.chars().count() > MAX_TITLE_CHARS {
        return Err(AppError::Invalid("titre trop long".into()));
    }
    Ok(t)
}

/// Seuls les dossiers et les pages (hors lignes de base de données) peuvent contenir d'autres éléments.
fn ensure_container(conn: &Connection, parent: &NodeRow) -> AppResult<()> {
    let is_row: i64 = conn.query_row(
        "SELECT count(*) FROM db_row WHERE node_id = ?1",
        [&parent.id],
        |r| r.get(0),
    )?;
    if parent.kind == "database" || is_row > 0 {
        return Err(AppError::Invalid(
            "cet élément ne peut pas contenir de sous-pages".into(),
        ));
    }
    Ok(())
}

/// Un nœud est-il une ligne de base de données ?
pub fn is_row(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT count(*) FROM db_row WHERE node_id = ?1",
        [id],
        |r| r.get::<_, i64>(0),
    )? > 0)
}

/// Crée le nœud d'une ligne (enfant direct de la base). Réservé à `database`.
pub(crate) fn create_row_node(
    conn: &Connection,
    database: &NodeRow,
    title: &str,
) -> AppResult<NodeRow> {
    let title = clean_title(title)?;
    let pos = slot(conn, &database.workspace_id, Some(&database.id), None, None)?;
    let id = uuid::Uuid::now_v7().to_string();
    let ts = now(conn)?;
    conn.execute(
        "INSERT INTO node (id, workspace_id, parent_id, kind, title, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'page', ?4, ?5, ?6, ?6)",
        params![id, database.workspace_id, database.id, title, pos, ts],
    )?;
    get(conn, &id)
}

pub fn ensure_default_workspace(conn: &Connection, name: &str) -> AppResult<String> {
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM workspace WHERE deleted_at IS NULL ORDER BY (kind = 'personal') DESC, created_at LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    let id = uuid::Uuid::now_v7().to_string();
    let ts = now(conn)?;
    conn.execute(
        "INSERT INTO workspace (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![id, name, ts],
    )?;
    Ok(id)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub kind: String,
}

/// Espaces locaux : l'espace personnel d'abord, puis les espaces partagés rejoints (par ordre d'arrivée).
pub fn list_workspaces(conn: &Connection) -> AppResult<Vec<WorkspaceRow>> {
    let mut st = conn.prepare(
        "SELECT id, name, kind FROM workspace WHERE deleted_at IS NULL
         ORDER BY (kind = 'personal') DESC, created_at, id",
    )?;
    let rows = st
        .query_map([], |r| {
            Ok(WorkspaceRow {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_tree(conn: &Connection, workspace_id: &str) -> AppResult<Vec<NodeRow>> {
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM node WHERE workspace_id = ?1 AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM db_row r WHERE r.node_id = node.id)
         ORDER BY position, id"
    ))?;
    let rows = st.query_map([workspace_id], map)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn depth_of(conn: &Connection, id: &str) -> AppResult<usize> {
    let d: i64 = conn.query_row(
        "WITH RECURSIVE up(id, parent_id, d) AS (
           SELECT id, parent_id, 1 FROM node WHERE id = ?1
           UNION ALL SELECT n.id, n.parent_id, up.d + 1 FROM node n JOIN up ON n.id = up.parent_id)
         SELECT MAX(d) FROM up",
        [id],
        |r| r.get(0),
    )?;
    Ok(d as usize)
}

fn subtree_height(conn: &Connection, id: &str) -> AppResult<usize> {
    let h: i64 = conn.query_row(
        "WITH RECURSIVE down(id, d) AS (
           SELECT id, 1 FROM node WHERE id = ?1
           UNION ALL SELECT n.id, down.d + 1 FROM node n JOIN down ON n.parent_id = down.id)
         SELECT MAX(d) FROM down",
        [id],
        |r| r.get(0),
    )?;
    Ok(h as usize)
}

/// Position pour insérer sous `parent` avant `before` (ou en fin de liste si `None`).
fn slot(
    conn: &Connection,
    ws: &str,
    parent: Option<&str>,
    before: Option<&str>,
    exclude: Option<&str>,
) -> AppResult<String> {
    let siblings: Vec<(String, String)> = {
        let mut st = conn.prepare(
            "SELECT id, position FROM node
             WHERE workspace_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL AND id IS NOT ?3
             ORDER BY position, id",
        )?;
        let rows = st.query_map(params![ws, parent, exclude], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let (prev, next): (Option<&str>, Option<&str>) = match before {
        None => (siblings.last().map(|s| s.1.as_str()), None),
        Some(b) => {
            let i = siblings
                .iter()
                .position(|s| s.0 == b)
                .ok_or_else(|| AppError::Invalid("repère de position introuvable".into()))?;
            (
                if i == 0 {
                    None
                } else {
                    Some(siblings[i - 1].1.as_str())
                },
                Some(siblings[i].1.as_str()),
            )
        }
    };
    position::between(prev, next).map_err(AppError::Invalid)
}

pub fn create_node(
    conn: &Connection,
    workspace_id: &str,
    parent_id: Option<&str>,
    kind: &str,
    title: &str,
    before_id: Option<&str>,
) -> AppResult<NodeRow> {
    if kind != "folder" && kind != "page" && kind != "database" {
        return Err(AppError::Invalid("type de nœud inconnu".into()));
    }
    let title = clean_title(title)?;
    let tx = crate::db::begin(conn)?;
    let ws_ok: i64 = tx.query_row(
        "SELECT count(*) FROM workspace WHERE id = ?1 AND deleted_at IS NULL",
        [workspace_id],
        |r| r.get(0),
    )?;
    if ws_ok == 0 {
        return Err(AppError::NotFound(format!("espace {workspace_id}")));
    }
    if let Some(p) = parent_id {
        let parent = get_live(&tx, p)?;
        ensure_container(&tx, &parent)?;
        if parent.workspace_id != workspace_id {
            return Err(AppError::Invalid(
                "le parent appartient à un autre espace".into(),
            ));
        }
        if depth_of(&tx, p)? >= MAX_DEPTH {
            return Err(AppError::Invalid("profondeur maximale atteinte".into()));
        }
    }
    let pos = slot(&tx, workspace_id, parent_id, before_id, None)?;
    let id = uuid::Uuid::now_v7().to_string();
    let ts = now(&tx)?;
    tx.execute(
        "INSERT INTO node (id, workspace_id, parent_id, kind, title, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, workspace_id, parent_id, kind, title, pos, ts],
    )?;
    search::reindex(&tx, &id)?;
    let row = get(&tx, &id)?;
    tx.commit()?;
    Ok(row)
}

pub fn rename_node(conn: &Connection, id: &str, title: &str) -> AppResult<NodeRow> {
    let title = clean_title(title)?;
    let tx = crate::db::begin(conn)?;
    get_live(&tx, id)?;
    let ts = now(&tx)?;
    tx.execute(
        "UPDATE node SET title = ?2, updated_at = ?3, version = version + 1 WHERE id = ?1",
        params![id, title, ts],
    )?;
    search::reindex(&tx, id)?;
    let row = get(&tx, id)?;
    tx.commit()?;
    Ok(row)
}

pub fn move_node(
    conn: &Connection,
    id: &str,
    new_parent: Option<&str>,
    before_id: Option<&str>,
) -> AppResult<NodeRow> {
    let tx = crate::db::begin(conn)?;
    let node = get_live(&tx, id)?;
    if let Some(p) = new_parent {
        let parent = get_live(&tx, p)?;
        ensure_container(&tx, &parent)?;
        if parent.workspace_id != node.workspace_id {
            return Err(AppError::Invalid(
                "déplacement inter-espaces non pris en charge".into(),
            ));
        }
        // Cycle : le nouveau parent ne doit être ni le nœud ni l'un de ses descendants.
        let is_desc: i64 = tx.query_row(
            "WITH RECURSIVE down(id) AS (
               SELECT id FROM node WHERE id = ?1
               UNION ALL SELECT n.id FROM node n JOIN down ON n.parent_id = down.id)
             SELECT count(*) FROM down WHERE id = ?2",
            params![id, p],
            |r| r.get(0),
        )?;
        if is_desc > 0 {
            return Err(AppError::Invalid(
                "impossible de déplacer un élément dans lui-même".into(),
            ));
        }
        if depth_of(&tx, p)? + subtree_height(&tx, id)? > MAX_DEPTH {
            return Err(AppError::Invalid("profondeur maximale dépassée".into()));
        }
    }
    if before_id == Some(id) {
        return Err(AppError::Invalid("repère de position invalide".into()));
    }
    let pos = slot(&tx, &node.workspace_id, new_parent, before_id, Some(id))?;
    let ts = now(&tx)?;
    tx.execute(
        "UPDATE node SET parent_id = ?2, position = ?3, updated_at = ?4, version = version + 1 WHERE id = ?1",
        params![id, new_parent, pos, ts],
    )?;
    let row = get(&tx, id)?;
    tx.commit()?;
    Ok(row)
}

pub fn set_favorite(conn: &Connection, id: &str, fav: bool) -> AppResult<NodeRow> {
    let tx = crate::db::begin(conn)?;
    get_live(&tx, id)?;
    let ts = now(&tx)?;
    tx.execute(
        "UPDATE node SET is_favorite = ?2, updated_at = ?3, version = version + 1 WHERE id = ?1",
        params![id, fav as i64, ts],
    )?;
    let row = get(&tx, id)?;
    tx.commit()?;
    Ok(row)
}

/// Mise à la corbeille du nœud et de tous ses descendants (même horodatage => restauration groupée).
pub fn soft_delete(conn: &Connection, id: &str) -> AppResult<usize> {
    let tx = crate::db::begin(conn)?;
    get_live(&tx, id)?;
    let ts = now(&tx)?;
    let n = tx.execute(
        "WITH RECURSIVE down(id) AS (
           SELECT id FROM node WHERE id = ?1
           UNION ALL SELECT n.id FROM node n JOIN down ON n.parent_id = down.id)
         UPDATE node SET deleted_at = ?2, updated_at = ?2, version = version + 1
         WHERE id IN (SELECT id FROM down) AND deleted_at IS NULL",
        params![id, ts],
    )?;
    tx.execute(
        "DELETE FROM search_index WHERE node_id IN (SELECT id FROM node WHERE deleted_at = ?1)",
        [&ts],
    )?;
    tx.execute(
        "DELETE FROM recent WHERE node_id IN (SELECT id FROM node WHERE deleted_at = ?1)",
        [&ts],
    )?;
    tx.commit()?;
    Ok(n)
}

/// Restaure le nœud et les descendants supprimés en même temps que lui.
/// Si son parent est lui-même dans la corbeille, le nœud revient à la racine.
pub fn restore(conn: &Connection, id: &str) -> AppResult<NodeRow> {
    let tx = crate::db::begin(conn)?;
    let node = get(&tx, id)?;
    let Some(stamp) = node.deleted_at.clone() else {
        return Err(AppError::Invalid(
            "l'élément n'est pas dans la corbeille".into(),
        ));
    };
    let parent_live = match &node.parent_id {
        Some(p) => get(&tx, p)?.deleted_at.is_none(),
        None => true,
    };
    let ts = now(&tx)?;
    if !parent_live && is_row(&tx, id)? {
        return Err(AppError::Invalid(
            "restaurez d'abord la base de données de cette ligne".into(),
        ));
    }
    if !parent_live {
        let pos = slot(&tx, &node.workspace_id, None, None, Some(id))?;
        tx.execute(
            "UPDATE node SET parent_id = NULL, position = ?2 WHERE id = ?1",
            params![id, pos],
        )?;
    }
    tx.execute(
        "WITH RECURSIVE down(id) AS (
           SELECT id FROM node WHERE id = ?1
           UNION ALL SELECT n.id FROM node n JOIN down ON n.parent_id = down.id)
         UPDATE node SET deleted_at = NULL, updated_at = ?3, version = version + 1
         WHERE id IN (SELECT id FROM down) AND deleted_at = ?2",
        params![id, stamp, ts],
    )?;
    let restored: Vec<String> = {
        let mut st =
            tx.prepare("SELECT id FROM node WHERE updated_at = ?1 AND deleted_at IS NULL")?;
        let rows = st.query_map([&ts], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for rid in restored {
        search::reindex(&tx, &rid)?;
    }
    let row = get(&tx, id)?;
    tx.commit()?;
    Ok(row)
}

/// Racines de la corbeille (les éléments supprimés avec leur parent n'apparaissent pas séparément).
pub fn list_trash(conn: &Connection, workspace_id: &str) -> AppResult<Vec<NodeRow>> {
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM node n WHERE workspace_id = ?1 AND deleted_at IS NOT NULL
         AND (parent_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM node p WHERE p.id = n.parent_id AND p.deleted_at = n.deleted_at))
         ORDER BY deleted_at DESC, id"
    ))?;
    let rows = st.query_map([workspace_id], map)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Suppression DÉFINITIVE d'un élément déjà dans la corbeille (et de ses descendants supprimés avec lui).
pub fn purge(conn: &Connection, id: &str) -> AppResult<usize> {
    let tx = crate::db::begin(conn)?;
    let node = get(&tx, id)?;
    let Some(stamp) = node.deleted_at else {
        return Err(AppError::Invalid(
            "seuls les éléments de la corbeille peuvent être supprimés définitivement".into(),
        ));
    };
    // Enfants avant parents : la contrainte RESTRICT est vérifiée ligne à ligne.
    let ids: Vec<String> = {
        let mut st = tx.prepare(
            "WITH RECURSIVE down(id, d) AS (
               SELECT id, 1 FROM node WHERE id = ?1
               UNION ALL SELECT n.id, down.d + 1 FROM node n JOIN down ON n.parent_id = down.id)
             SELECT down.id FROM down JOIN node ON node.id = down.id
             WHERE node.deleted_at = ?2 ORDER BY down.d DESC",
        )?;
        let rows = st.query_map(params![id, stamp], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    // Tout nœud (vivant ou supprimé à un autre moment) qui dépend d'un nœud purgé remonte à la racine : jamais d'orphelin.
    let ids_json = serde_json::to_string(&ids).map_err(|e| AppError::Invalid(e.to_string()))?;
    tx.execute(
        "UPDATE node SET parent_id = NULL
         WHERE parent_id IN (SELECT value FROM json_each(?1))
           AND id NOT IN (SELECT value FROM json_each(?1))",
        [&ids_json],
    )?;
    for nid in &ids {
        tx.execute("DELETE FROM search_index WHERE node_id = ?1", [nid])?;
        tx.execute("DELETE FROM page_version WHERE node_id = ?1", [nid])?;
        tx.execute("DELETE FROM comment_thread WHERE node_id = ?1", [nid])?; // les messages suivent (CASCADE)
    }
    let mut n = 0;
    for nid in &ids {
        n += tx.execute("DELETE FROM node WHERE id = ?1", [nid])?;
    }
    tx.commit()?;
    Ok(n)
}

pub fn empty_trash(conn: &Connection, workspace_id: &str) -> AppResult<usize> {
    let roots = list_trash(conn, workspace_id)?;
    let mut total = 0;
    for r in roots {
        total += purge(conn, &r.id)?;
    }
    Ok(total)
}

pub fn touch_recent(conn: &Connection, id: &str) -> AppResult<()> {
    get_live(conn, id)?;
    conn.execute(
        "INSERT INTO recent (node_id, opened_at) VALUES (?1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(node_id) DO UPDATE SET opened_at = excluded.opened_at",
        [id],
    )?;
    conn.execute(
        "DELETE FROM recent WHERE node_id NOT IN (SELECT node_id FROM recent ORDER BY opened_at DESC LIMIT 50)",
        [],
    )?;
    Ok(())
}

pub fn list_recent(conn: &Connection, workspace_id: &str, limit: usize) -> AppResult<Vec<NodeRow>> {
    let mut st = conn.prepare(&format!(
        "SELECT {} FROM recent r JOIN node n ON n.id = r.node_id
         WHERE n.workspace_id = ?1 AND n.deleted_at IS NULL AND n.kind = 'page'
         ORDER BY r.opened_at DESC LIMIT ?2",
        COLS.split(", ")
            .map(|c| format!("n.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))?;
    let rows = st.query_map(params![workspace_id, limit as i64], map)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::{tempdir, TempDir};

    pub fn setup() -> (TempDir, Connection, String) {
        let d = tempdir().unwrap();
        let c = db::open(d.path()).unwrap();
        let ws = ensure_default_workspace(&c, "Personnel").unwrap();
        (d, c, ws)
    }
    #[test]
    fn workspaces_personal_first_and_default_stays_personal() {
        let (_d, c, ws) = setup();
        c.execute(
            "INSERT INTO workspace (id, name, kind, created_at, updated_at) VALUES ('0192f0a0-0000-7000-8000-0000000000aa', 'Équipe', 'shared', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')",
            [],
        )
        .unwrap();
        let l = list_workspaces(&c).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].id, ws);
        assert_eq!(l[0].kind, "personal");
        assert_eq!(l[1].kind, "shared");
        // Même si l'espace partagé est plus ancien, le défaut reste le personnel.
        assert_eq!(ensure_default_workspace(&c, "Personnel").unwrap(), ws);
    }
    fn page(c: &Connection, ws: &str, parent: Option<&str>, t: &str) -> NodeRow {
        create_node(c, ws, parent, "page", t, None).unwrap()
    }
    fn titles(c: &Connection, ws: &str, parent: Option<&str>) -> Vec<String> {
        list_tree(c, ws)
            .unwrap()
            .into_iter()
            .filter(|n| n.parent_id.as_deref() == parent)
            .map(|n| n.title)
            .collect()
    }

    #[test]
    fn espace_par_defaut_unique_et_stable() {
        let (_d, c, ws) = setup();
        assert_eq!(ensure_default_workspace(&c, "Autre").unwrap(), ws);
    }

    #[test]
    fn creation_ordre_et_sous_pages() {
        let (_d, c, ws) = setup();
        let a = create_node(&c, &ws, None, "folder", "A", None).unwrap();
        let b = page(&c, &ws, None, "B");
        let first = create_node(&c, &ws, None, "page", "Premier", Some(&a.id)).unwrap();
        let sub = page(&c, &ws, Some(&b.id), "Sous-page");
        assert_eq!(titles(&c, &ws, None), vec!["Premier", "A", "B"]);
        assert!(first.position < a.position && a.position < b.position);
        assert_eq!(sub.parent_id.as_deref(), Some(b.id.as_str()));
    }

    #[test]
    fn validations_creation() {
        let (_d, c, ws) = setup();
        assert!(create_node(&c, &ws, None, "inconnu", "x", None).is_err());
        assert!(create_node(&c, &ws, None, "page", &"x".repeat(501), None).is_err());
        assert!(matches!(
            create_node(&c, "inconnu", None, "page", "x", None),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            create_node(&c, &ws, Some("inconnu"), "page", "x", None),
            Err(AppError::NotFound(_))
        ));
        let t = create_node(&c, &ws, None, "page", "a\nb", None).unwrap();
        assert_eq!(t.title, "a b");
    }

    #[test]
    fn deplacement_reordonne_sans_toucher_aux_voisins() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        let b = page(&c, &ws, None, "B");
        let d3 = page(&c, &ws, None, "C");
        let (pa, pb) = (a.position.clone(), b.position.clone());
        move_node(&c, &d3.id, None, Some(&b.id)).unwrap();
        assert_eq!(titles(&c, &ws, None), vec!["A", "C", "B"]);
        let tree = list_tree(&c, &ws).unwrap();
        assert_eq!(tree.iter().find(|n| n.id == a.id).unwrap().position, pa);
        assert_eq!(tree.iter().find(|n| n.id == b.id).unwrap().position, pb);
        move_node(&c, &a.id, None, None).unwrap();
        assert_eq!(titles(&c, &ws, None), vec!["C", "B", "A"]);
    }

    #[test]
    fn deplacement_sous_un_parent() {
        let (_d, c, ws) = setup();
        let f = create_node(&c, &ws, None, "folder", "F", None).unwrap();
        let p = page(&c, &ws, None, "P");
        let moved = move_node(&c, &p.id, Some(&f.id), None).unwrap();
        assert_eq!(moved.parent_id.as_deref(), Some(f.id.as_str()));
        assert_eq!(titles(&c, &ws, Some(&f.id)), vec!["P"]);
    }

    #[test]
    fn cycles_refuses() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        let b = page(&c, &ws, Some(&a.id), "B");
        let cc = page(&c, &ws, Some(&b.id), "C");
        assert!(move_node(&c, &a.id, Some(&a.id), None).is_err());
        assert!(move_node(&c, &a.id, Some(&cc.id), None).is_err());
        assert!(move_node(&c, &b.id, Some(&cc.id), None).is_err());
        assert_eq!(get(&c, &a.id).unwrap().parent_id, None, "rien n'a bougé");
    }

    #[test]
    fn profondeur_limitee() {
        let (_d, c, ws) = setup();
        let mut parent: Option<String> = None;
        for i in 0..MAX_DEPTH {
            let n =
                create_node(&c, &ws, parent.as_deref(), "folder", &format!("n{i}"), None).unwrap();
            parent = Some(n.id);
        }
        assert!(create_node(&c, &ws, parent.as_deref(), "page", "trop profond", None).is_err());
    }

    #[test]
    fn favoris() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        assert!(set_favorite(&c, &a.id, true).unwrap().is_favorite);
        assert!(!set_favorite(&c, &a.id, false).unwrap().is_favorite);
    }

    #[test]
    fn corbeille_cascade_restauration_groupee() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        let b = page(&c, &ws, Some(&a.id), "B");
        let cc = page(&c, &ws, Some(&b.id), "C");
        let other = page(&c, &ws, None, "Autre");
        assert_eq!(soft_delete(&c, &b.id).unwrap(), 2);
        assert_eq!(titles(&c, &ws, None), vec!["A", "Autre"]);
        assert_eq!(
            list_trash(&c, &ws)
                .unwrap()
                .iter()
                .map(|n| n.id.clone())
                .collect::<Vec<_>>(),
            vec![b.id.clone()]
        );
        assert!(get_live(&c, &cc.id).is_err());
        restore(&c, &b.id).unwrap();
        assert_eq!(list_tree(&c, &ws).unwrap().len(), 4);
        assert_eq!(
            get(&c, &cc.id).unwrap().parent_id.as_deref(),
            Some(b.id.as_str())
        );
        assert!(get(&c, &other.id).unwrap().deleted_at.is_none());
    }

    #[test]
    fn restauration_ne_ressuscite_pas_ce_qui_etait_deja_supprime() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        let b = page(&c, &ws, Some(&a.id), "B");
        soft_delete(&c, &b.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        soft_delete(&c, &a.id).unwrap();
        assert_eq!(list_trash(&c, &ws).unwrap().len(), 2);
        restore(&c, &a.id).unwrap();
        assert!(
            get(&c, &b.id).unwrap().deleted_at.is_some(),
            "B reste dans la corbeille"
        );
    }

    #[test]
    fn restaurer_sous_un_parent_supprime_remonte_a_la_racine() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        let b = page(&c, &ws, Some(&a.id), "B");
        soft_delete(&c, &b.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        soft_delete(&c, &a.id).unwrap();
        let r = restore(&c, &b.id).unwrap();
        assert_eq!(r.parent_id, None);
        assert!(r.deleted_at.is_none());
    }

    #[test]
    fn suppression_definitive_seulement_depuis_la_corbeille() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        let b = page(&c, &ws, Some(&a.id), "B");
        assert!(purge(&c, &a.id).is_err(), "refus hors corbeille");
        soft_delete(&c, &a.id).unwrap();
        assert_eq!(purge(&c, &a.id).unwrap(), 2);
        assert!(matches!(get(&c, &b.id), Err(AppError::NotFound(_))));
        let n: i64 = c
            .query_row("SELECT count(*) FROM search_index", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn vider_la_corbeille() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        page(&c, &ws, None, "B");
        soft_delete(&c, &a.id).unwrap();
        assert_eq!(empty_trash(&c, &ws).unwrap(), 1);
        assert!(list_trash(&c, &ws).unwrap().is_empty());
        assert_eq!(list_tree(&c, &ws).unwrap().len(), 1);
    }

    #[test]
    fn recents() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        let b = page(&c, &ws, None, "B");
        touch_recent(&c, &a.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        touch_recent(&c, &b.id).unwrap();
        assert_eq!(list_recent(&c, &ws, 10).unwrap()[0].id, b.id);
        soft_delete(&c, &b.id).unwrap();
        assert_eq!(list_recent(&c, &ws, 10).unwrap().len(), 1);
    }

    #[test]
    fn les_cles_etrangeres_empechent_un_orphelin_direct() {
        let (_d, c, ws) = setup();
        let a = page(&c, &ws, None, "A");
        page(&c, &ws, Some(&a.id), "B");
        assert!(c
            .execute("DELETE FROM node WHERE id = ?1", [&a.id])
            .is_err());
    }
}
