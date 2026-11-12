//! Synchronisation (première tranche, voir docs/SYNC.md) : file d'opérations locale (`oplog`, alimentée par des
//! déclencheurs SQLite), accusés du serveur, et application des données distantes.
//!
//! Ce module ne fait AUCUN accès réseau : l'interface (TypeScript) parle au serveur et appelle ces fonctions.
//! La fusion du contenu (Yjs) est faite côté interface ; ici on ne fait que lire/écrire l'état fusionné, avec une
//! garde de fraîcheur (`expected_updated_at`) pour ne jamais écraser une modification locale plus récente.

use crate::error::{AppError, AppResult};
use crate::{search, tree};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_ATTEMPTS: i64 = 20;

/// État de synchronisation d'UN espace.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSync {
    pub workspace_id: String,
    pub name: String,
    /// `personal` (le vôtre) ou `shared` (rejoint par invitation).
    pub kind: String,
    /// Rôle sur le serveur : `viewer` (lecture seule), `editor`, `admin`.
    pub role: String,
    pub node_cursor: i64,
    pub doc_cursor: i64,
    pub struct_cursor: i64,
    pub last_push_at: Option<String>,
    pub last_pull_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// Au moins un espace est synchronisé.
    pub enabled: bool,
    pub device_id: String,
    pub pending: i64,
    pub rejected: i64,
    pub workspaces: Vec<WorkspaceSync>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingOp {
    pub op_id: String,
    /// Espace auquel appartient l'opération (le serveur reçoit un lot PAR espace).
    pub workspace_id: String,
    pub entity: String,
    pub entity_id: String,
    /// Champs modifiés (opérations « node »).
    pub fields: Value,
    /// Mise à jour Yjs complète en base64 (opérations « doc »).
    pub update: Option<String>,
    pub clock_ms: i64,
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AckResult {
    pub op_id: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub position: String,
    pub deleted_at: Option<String>,
    /// Renseigné quand le nœud a été supprimé définitivement ailleurs : la copie locale doit disparaître aussi.
    #[serde(default)]
    pub purged_at: Option<String>,
    pub created_at: String,
}

/// Élément du flux « structure » du serveur (noms de champs tels que renvoyés par `sync_pull_struct`).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RemoteStruct {
    Prop {
        id: String,
        database_id: String,
        name: String,
        #[serde(rename = "type")]
        prop_type: String,
        config: Value,
        position: String,
        deleted_at: Option<String>,
    },
    View {
        id: String,
        database_id: String,
        name: String,
        layout: String,
        config: Value,
        position: String,
        deleted_at: Option<String>,
    },
    Row {
        id: String,
        database_id: String,
        props: serde_json::Map<String, Value>,
    },
    Thread {
        id: String,
        node_id: String,
        quote: String,
        #[serde(default)]
        author_label: Option<String>,
        created_at: String,
        #[serde(default)]
        resolved_at: Option<String>,
        #[serde(default)]
        resolved_label: Option<String>,
        #[serde(default)]
        deleted_at: Option<String>,
    },
    Comment {
        id: String,
        thread_id: String,
        body: String,
        #[serde(default)]
        author_label: Option<String>,
        created_at: String,
        #[serde(default)]
        edited_at: Option<String>,
        #[serde(default)]
        deleted_at: Option<String>,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub applied: usize,
    /// Éléments ignorés parce qu'impossibles à appliquer (ex. second champ « titre » d'une base) ; signalés, jamais silencieux.
    #[serde(default)]
    pub skipped: usize,
    /// Nœuds dont le parent n'est pas (encore) connu : le curseur n'avance pas tant qu'il en reste.
    pub unresolved: usize,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocForMerge {
    pub doc_state: String,
    pub updated_at: String,
}

/// (au moins un espace synchronisé, identifiant de l'appareil)
fn settings(conn: &Connection) -> AppResult<(bool, String)> {
    Ok(conn.query_row(
        "SELECT enabled, device_id FROM sync_settings WHERE id = 1",
        [],
        |r| Ok((r.get::<_, i64>(0)? == 1, r.get(1)?)),
    )?)
}

fn require_enabled(conn: &Connection, ws: &str) -> AppResult<()> {
    let (on, _) = settings(conn)?;
    let ok: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sync_state WHERE workspace_id = ?1 AND enabled = 1)",
        [ws],
        |r| r.get(0),
    )?;
    if on && ok {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "la synchronisation n'est pas activée pour cet espace".into(),
        ))
    }
}

pub fn status(conn: &Connection) -> AppResult<SyncStatus> {
    let (enabled, device_id) = settings(conn)?;
    let count = |s: &str| -> AppResult<i64> {
        Ok(
            conn.query_row("SELECT count(*) FROM oplog WHERE status = ?1", [s], |r| {
                r.get(0)
            })?,
        )
    };
    let workspaces: Vec<WorkspaceSync> = conn
        .prepare(
            "SELECT s.workspace_id, w.name, w.kind, s.role, s.node_cursor, s.doc_cursor, s.struct_cursor,
                    s.last_push_at, s.last_pull_at, s.last_error
             FROM sync_state s JOIN workspace w ON w.id = s.workspace_id
             WHERE s.enabled = 1 ORDER BY w.kind, w.created_at, w.id",
        )?
        .query_map([], |r| {
            Ok(WorkspaceSync {
                workspace_id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                role: r.get(3)?,
                node_cursor: r.get(4)?,
                doc_cursor: r.get(5)?,
                struct_cursor: r.get(6)?,
                last_push_at: r.get(7)?,
                last_pull_at: r.get(8)?,
                last_error: r.get(9)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(SyncStatus {
        enabled: enabled && !workspaces.is_empty(),
        device_id,
        pending: count("pending")?,
        rejected: count("rejected")?,
        workspaces,
    })
}

/// Active la synchronisation d'un espace (le vôtre) : inscrit TOUT l'existant (parents avant enfants) dans la file, puis
/// les déclencheurs prennent le relais. Rappeler la fonction est sans effet. C'est aussi la migration invité -> compte
/// pour les données concernées. Les données locales ne sont jamais modifiées ni supprimées.
pub fn enable(conn: &Connection, workspace_id: &str) -> AppResult<SyncStatus> {
    let tx = crate::db::begin(conn)?;
    let ws: String = tx
        .query_row(
            "SELECT id FROM workspace WHERE id = ?1",
            [workspace_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("espace {workspace_id}")))?;
    let already: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM sync_state WHERE workspace_id = ?1 AND enabled = 1)",
        [&ws],
        |r| r.get(0),
    )?;
    if already {
        tx.execute("UPDATE sync_settings SET enabled = 1 WHERE id = 1", [])?;
        tx.commit()?;
        return status(conn);
    }
    tx.execute("UPDATE sync_settings SET enabled = 1 WHERE id = 1", [])?;
    tx.execute(
        "INSERT INTO sync_state (workspace_id, enabled, role) VALUES (?1, 1, 'admin')
         ON CONFLICT(workspace_id) DO UPDATE SET enabled = 1, role = 'admin'",
        [&ws],
    )?;
    // Parents d'abord (profondeur croissante), puis ordre de création : l'ordre de la file suffit au serveur.
    tx.execute(
        "WITH RECURSIVE t(id, depth) AS (
           SELECT id, 0 FROM node WHERE workspace_id = ?1 AND parent_id IS NULL
           UNION ALL SELECT n.id, t.depth + 1 FROM node n JOIN t ON n.parent_id = t.id)
         INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
         SELECT 'node', n.id,
                json_object('kind', n.kind, 'title', n.title, 'parent_id', n.parent_id, 'position', n.position, 'deleted_at', n.deleted_at),
                CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
         FROM t JOIN node n ON n.id = t.id
         ORDER BY t.depth, n.created_at, n.id",
        [&ws],
    )?;
    tx.execute(
        "INSERT INTO oplog (entity, entity_id, clock_ms)
         SELECT 'doc', c.node_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
         FROM page_content c JOIN node n ON n.id = c.node_id WHERE n.workspace_id = ?1 AND n.kind = 'page'
         ORDER BY n.created_at, n.id",
        [&ws],
    )?;
    enqueue_structure(&tx, &ws, false)?;
    tx.execute(
        "UPDATE sync_state SET struct_backfilled = 1 WHERE workspace_id = ?1",
        [&ws],
    )?;
    tx.commit()?;
    status(conn)
}

/// Rejoint un espace partagé (après acceptation d'une invitation) : crée l'espace localement s'il n'existe pas et
/// l'active avec le rôle donné. Aucun envoi : il n'y a rien de local à y mettre ; tout vient du serveur au prochain passage.
pub fn join_workspace(
    conn: &Connection,
    id: &str,
    name: &str,
    role: &str,
) -> AppResult<SyncStatus> {
    if !matches!(role, "viewer" | "editor" | "admin") {
        return Err(AppError::Invalid("rôle inconnu".into()));
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 || !is_uuid(id) {
        return Err(AppError::Invalid("espace invalide".into()));
    }
    let tx = crate::db::begin(conn)?;
    let ts = tree::now(&tx)?;
    tx.execute(
        "INSERT OR IGNORE INTO workspace (id, name, kind, created_at, updated_at) VALUES (?1, ?2, 'shared', ?3, ?3)",
        params![id, name, ts],
    )?;
    tx.execute("UPDATE sync_settings SET enabled = 1 WHERE id = 1", [])?;
    tx.execute(
        "INSERT INTO sync_state (workspace_id, enabled, role, struct_backfilled) VALUES (?1, 1, ?2, 1)
         ON CONFLICT(workspace_id) DO UPDATE SET enabled = 1, role = excluded.role,
           -- Un nouvel accès dans un espace déjà connu (un autre dossier partagé) : tout relire depuis le début, sinon
           -- les éléments plus anciens que les curseurs ne viendraient jamais. Réappliquer est sans effet.
           node_cursor = 0, doc_cursor = 0, struct_cursor = 0",
        params![id, role],
    )?;
    tx.commit()?;
    status(conn)
}

fn is_uuid(v: &str) -> bool {
    v.len() == 36
        && v.bytes().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Met à jour le rôle d'un espace (promotion, rétrogradation). `None` : l'accès a été retiré — la synchronisation de cet
/// espace s'arrête et ses opérations en attente sont abandonnées ; **les données locales sont conservées** (lecture seule en pratique).
pub fn set_workspace_role(
    conn: &Connection,
    ws: &str,
    role: Option<&str>,
) -> AppResult<SyncStatus> {
    match role {
        Some(r) if matches!(r, "viewer" | "editor" | "admin") => {
            conn.execute(
                "UPDATE sync_state SET role = ?2 WHERE workspace_id = ?1 AND enabled = 1",
                params![ws, r],
            )?;
        }
        Some(_) => return Err(AppError::Invalid("rôle inconnu".into())),
        None => {
            let tx = crate::db::begin(conn)?;
            drop_pending_for(&tx, ws)?;
            tx.execute(
                "UPDATE sync_state SET enabled = 0, last_error = 'access_removed' WHERE workspace_id = ?1",
                [ws],
            )?;
            tx.commit()?;
        }
    }
    status(conn)
}

const WS_OF_OP: &str = "CASE o.entity
    WHEN 'node' THEN COALESCE((SELECT workspace_id FROM node WHERE id = o.entity_id), json_extract(o.fields_json, '$.workspace_id'))
    WHEN 'doc' THEN (SELECT workspace_id FROM node WHERE id = o.entity_id)
    WHEN 'prop' THEN (SELECT n.workspace_id FROM db_property p JOIN node n ON n.id = p.database_id WHERE p.id = o.entity_id)
    WHEN 'view' THEN (SELECT n.workspace_id FROM db_view v JOIN node n ON n.id = v.database_id WHERE v.id = o.entity_id)
    WHEN 'row' THEN (SELECT n.workspace_id FROM db_row r JOIN node n ON n.id = r.database_id WHERE r.node_id = o.entity_id)
    WHEN 'thread' THEN COALESCE((SELECT n.workspace_id FROM comment_thread t JOIN node n ON n.id = t.node_id WHERE t.id = o.entity_id), json_extract(o.fields_json, '$.workspace_id'))
    WHEN 'comment' THEN COALESCE((SELECT n.workspace_id FROM comment c JOIN comment_thread t ON t.id = c.thread_id JOIN node n ON n.id = t.node_id WHERE c.id = o.entity_id), json_extract(o.fields_json, '$.workspace_id'))
  END";

fn drop_pending_for(conn: &Connection, ws: &str) -> AppResult<()> {
    conn.execute(
        &format!(
            "DELETE FROM oplog WHERE seq IN (SELECT o.seq FROM oplog o WHERE {WS_OF_OP} = ?1)"
        ),
        [ws],
    )?;
    Ok(())
}

/// Inscrit dans la file les propriétés, vues et lignes des bases de l'espace (et, si `with_nodes`, les nœuds des bases et de
/// leurs lignes). Les nœuds d'une activation neuve sont déjà inscrits par `enable` ; pour une synchronisation activée avant
/// l'existence des bases synchronisées, ce rattrapage les inscrit (le serveur ignore ce qu'il connaît : opérations idempotentes).
fn enqueue_structure(conn: &Connection, ws: &str, with_nodes: bool) -> AppResult<()> {
    let ms = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
    if with_nodes {
        conn.execute(
            &format!(
                "WITH RECURSIVE t(id, depth) AS (
                   SELECT id, 0 FROM node WHERE workspace_id = ?1 AND kind = 'database'
                   UNION ALL SELECT n.id, t.depth + 1 FROM node n JOIN t ON n.parent_id = t.id)
                 INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
                 SELECT 'node', n.id,
                        json_object('kind', n.kind, 'title', n.title, 'parent_id', n.parent_id, 'position', n.position, 'deleted_at', n.deleted_at),
                        {ms}
                 FROM t JOIN node n ON n.id = t.id ORDER BY t.depth, n.created_at, n.id"
            ),
            [ws],
        )?;
    }
    conn.execute(
        &format!(
            "INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
             SELECT 'prop', p.id, json_object('database_id', p.database_id, 'name', p.name, 'type', p.type,
                    'config', json(p.config_json), 'position', p.position, 'deleted_at', p.deleted_at), {ms}
             FROM db_property p JOIN node d ON d.id = p.database_id WHERE d.workspace_id = ?1 ORDER BY p.created_at, p.id"
        ),
        [ws],
    )?;
    conn.execute(
        &format!(
            "INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
             SELECT 'view', v.id, json_object('database_id', v.database_id, 'name', v.name, 'layout', v.layout,
                    'config', json(v.config_json), 'position', v.position, 'deleted_at', v.deleted_at), {ms}
             FROM db_view v JOIN node d ON d.id = v.database_id WHERE d.workspace_id = ?1 ORDER BY v.created_at, v.id"
        ),
        [ws],
    )?;
    conn.execute(
        &format!(
            "INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
             SELECT 'row', r.node_id, json_object('database_id', r.database_id, 'cells', json(r.props_json)), {ms}
             FROM db_row r JOIN node d ON d.id = r.database_id WHERE d.workspace_id = ?1 ORDER BY r.node_id"
        ),
        [ws],
    )?;
    // Commentaires : fils avant messages (le serveur refuse un message sans fil).
    conn.execute(
        &format!(
            "INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
             SELECT 'thread', t.id, json_object('node_id', t.node_id, 'quote', t.quote, 'created_at', t.created_at, 'resolved_at', t.resolved_at), {ms}
             FROM comment_thread t JOIN node n ON n.id = t.node_id WHERE n.workspace_id = ?1 AND n.deleted_at IS NULL ORDER BY t.created_at, t.id"
        ),
        [ws],
    )?;
    conn.execute(
        &format!(
            "INSERT INTO oplog (entity, entity_id, fields_json, clock_ms)
             SELECT 'comment', c.id, json_object('thread_id', c.thread_id, 'body', c.body, 'created_at', c.created_at), {ms}
             FROM comment c JOIN comment_thread t ON t.id = c.thread_id JOIN node n ON n.id = t.node_id
             WHERE n.workspace_id = ?1 AND n.deleted_at IS NULL ORDER BY c.created_at, c.id"
        ),
        [ws],
    )?;
    Ok(())
}

/// Rattrapage unique après la mise à jour qui a introduit la synchronisation des bases (par espace activé).
fn ensure_struct_backfill(conn: &Connection) -> AppResult<()> {
    let todo: Vec<String> = conn
        .prepare("SELECT workspace_id FROM sync_state WHERE enabled = 1 AND struct_backfilled = 0")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for ws in todo {
        let tx = crate::db::begin(conn)?;
        enqueue_structure(&tx, &ws, true)?;
        tx.execute(
            "UPDATE sync_state SET struct_backfilled = 1 WHERE workspace_id = ?1",
            [&ws],
        )?;
        tx.commit()?;
    }
    Ok(())
}

/// Désactive la synchronisation de TOUS les espaces : la file en attente est vidée, les données locales restent intactes.
pub fn disable(conn: &Connection) -> AppResult<SyncStatus> {
    let tx = crate::db::begin(conn)?;
    tx.execute("UPDATE sync_settings SET enabled = 0 WHERE id = 1", [])?;
    tx.execute("UPDATE sync_state SET enabled = 0", [])?;
    tx.execute("DELETE FROM oplog", [])?;
    tx.commit()?;
    status(conn)
}

/// Prochaines opérations à envoyer (ordre de création), toutes celles des espaces activés où l'on peut écrire. Les
/// opérations de contenu embarquent l'état Yjs courant. Une opération sans objet (page purgée) ou d'un espace non synchronisé
/// est abandonnée ; celles d'un espace en LECTURE SEULE restent en file mais ne sont pas envoyées (le serveur les refuserait).
pub fn pending_ops(conn: &Connection, limit: usize) -> AppResult<Vec<PendingOp>> {
    let limit = limit.clamp(1, 200);
    let (enabled, device) = settings(conn)?;
    if !enabled {
        return Ok(vec![]);
    }
    ensure_struct_backfill(conn)?;
    let roles: std::collections::HashMap<String, String> = conn
        .prepare("SELECT workspace_id, role FROM sync_state WHERE enabled = 1")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    type Row = (i64, String, String, String, String, i64, Option<String>);
    let rows: Vec<Row> = conn
        .prepare(&format!(
            "SELECT o.seq, o.op_id, o.entity, o.entity_id, o.fields_json, o.clock_ms, {WS_OF_OP}
             FROM oplog o WHERE o.status = 'pending' ORDER BY o.seq"
        ))?
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for (seq, op_id, entity, entity_id, fields, clock_ms, ws) in rows {
        if out.len() >= limit {
            break;
        }
        let Some(ws) = ws.filter(|w| roles.contains_key(w)) else {
            conn.execute("DELETE FROM oplog WHERE seq = ?1", [seq])?;
            continue;
        };
        if roles.get(&ws).map(String::as_str) == Some("viewer") {
            continue;
        }
        let update = if entity == "doc" {
            let state: Option<Vec<u8>> = conn
                .query_row(
                    "SELECT doc_state FROM page_content WHERE node_id = ?1",
                    [&entity_id],
                    |r| r.get(0),
                )
                .optional()?;
            match state {
                Some(s) => Some(B64.encode(s)),
                None => {
                    conn.execute("DELETE FROM oplog WHERE op_id = ?1", [&op_id])?;
                    continue;
                }
            }
        } else {
            None
        };
        out.push(PendingOp {
            op_id,
            workspace_id: ws,
            entity,
            entity_id,
            fields: serde_json::from_str(&fields).unwrap_or_else(|_| json!({})),
            update,
            clock_ms,
            device_id: device.clone(),
        });
    }
    Ok(out)
}

/// Accusés du serveur. `applied | merged | duplicate` : l'opération est terminée (supprimée de la file).
/// `rejected` : les causes temporaires (parent ou nœud pas encore arrivé) sont réessayées jusqu'à `MAX_ATTEMPTS` ;
/// les autres sont définitives (conservées, visibles avec leur cause).
pub fn ack(conn: &Connection, results: &[AckResult]) -> AppResult<()> {
    let tx = crate::db::begin(conn)?;
    for r in results {
        match r.status.as_str() {
            "applied" | "merged" | "duplicate" => {
                tx.execute("DELETE FROM oplog WHERE op_id = ?1", [&r.op_id])?;
            }
            "rejected" => {
                let reason = r.reason.clone().unwrap_or_default();
                let temporary =
                    reason.contains("parent_missing") || reason.contains("node_missing");
                let attempts: Option<i64> = tx
                    .query_row(
                        "SELECT attempts FROM oplog WHERE op_id = ?1",
                        [&r.op_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(attempts) = attempts else { continue };
                let give_up = !temporary || attempts + 1 >= MAX_ATTEMPTS;
                tx.execute(
                    "UPDATE oplog SET attempts = attempts + 1, last_error = ?2, status = ?3 WHERE op_id = ?1",
                    params![r.op_id, reason, if give_up { "rejected" } else { "pending" }],
                )?;
            }
            _ => return Err(AppError::Invalid("statut d'accusé inconnu".into())),
        }
    }
    tx.execute(
        "UPDATE sync_state SET last_push_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error = NULL
         WHERE enabled = 1",
        [],
    )?;
    tx.commit()
}

pub fn record_error(conn: &Connection, workspace_id: &str, message: &str) -> AppResult<()> {
    let msg: String = message.chars().take(500).collect();
    conn.execute(
        "UPDATE sync_state SET last_error = ?2 WHERE workspace_id = ?1",
        params![workspace_id, msg],
    )?;
    Ok(())
}

fn has_pending_field(conn: &Connection, id: &str, field: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM oplog WHERE entity = 'node' AND entity_id = ?1 AND status = 'pending'
                        AND json_type(fields_json, '$.' || ?2) IS NOT NULL)",
        params![id, field],
        |r| r.get(0),
    )?)
}

fn would_cycle(conn: &Connection, id: &str, new_parent: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "WITH RECURSIVE up(id) AS (SELECT ?2 UNION ALL SELECT n.parent_id FROM node n JOIN up ON n.id = up.id WHERE n.parent_id IS NOT NULL)
         SELECT EXISTS (SELECT 1 FROM up WHERE id = ?1)",
        params![id, new_parent],
        |r| r.get(0),
    )?)
}

fn norm_ts(conn: &Connection, v: Option<&str>) -> AppResult<Option<String>> {
    match v {
        None => Ok(None),
        Some(s) => {
            let t: Option<String> =
                conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)", [s], |r| {
                    r.get(0)
                })?;
            t.map(Some)
                .ok_or_else(|| AppError::Invalid(format!("date distante illisible : {s}")))
        }
    }
}

/// Supprime définitivement la copie locale d'un nœud purgé ailleurs (jamais d'orphelin : les enfants remontent à la racine).
/// Les opérations locales en attente sur ce nœud sont abandonnées.
fn purge_local(conn: &Connection, ws: &str, id: &str) -> AppResult<bool> {
    let Some(lws) = conn
        .query_row("SELECT workspace_id FROM node WHERE id = ?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .optional()?
    else {
        return Ok(false); // jamais reçu ici : rien à supprimer
    };
    if lws != ws {
        return Err(AppError::Invalid("nœud d'un autre espace".into()));
    }
    conn.execute(
        "UPDATE node SET parent_id = NULL WHERE parent_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM search_index WHERE node_id = ?1", [id])?;
    conn.execute("DELETE FROM page_version WHERE node_id = ?1", [id])?;
    conn.execute("DELETE FROM comment_thread WHERE node_id = ?1", [id])?;
    conn.execute(
        "DELETE FROM oplog WHERE status = 'pending' AND entity_id = ?1 AND entity IN ('node', 'doc', 'row')",
        [id],
    )?;
    conn.execute("DELETE FROM node WHERE id = ?1", [id])?;
    Ok(true)
}

fn apply_one(conn: &Connection, ws: &str, n: &RemoteNode) -> AppResult<bool> {
    if n.purged_at.is_some() {
        return purge_local(conn, ws, &n.id);
    }
    if !matches!(n.kind.as_str(), "folder" | "page" | "database") {
        return Err(AppError::Invalid("type de nœud distant inconnu".into()));
    }
    if n.title.chars().count() > 500 || n.position.is_empty() || n.position.len() > 255 {
        return Err(AppError::Invalid("nœud distant invalide".into()));
    }
    let deleted = norm_ts(conn, n.deleted_at.as_deref())?;
    // (parent, titre, position, corbeille, espace)
    type LocalNode = (Option<String>, String, String, Option<String>, String);
    let local: Option<LocalNode> = conn
        .query_row(
            "SELECT parent_id, title, position, deleted_at, workspace_id FROM node WHERE id = ?1",
            [&n.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    match local {
        None => {
            let created = norm_ts(conn, Some(&n.created_at))?.unwrap_or_default();
            conn.execute(
                "INSERT INTO node (id, workspace_id, parent_id, kind, title, position, is_favorite, created_at, updated_at, deleted_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?8, 1)",
                params![n.id, ws, n.parent_id, n.kind, n.title, n.position, created, deleted],
            )?;
            search::reindex(conn, &n.id)?;
            Ok(true)
        }
        Some((lp, lt, lpos, ld, lws)) => {
            if lws != ws {
                return Err(AppError::Invalid("nœud d'un autre espace".into()));
            }
            let mut changed = false;
            let mut set = |col: &str, val: Option<&str>| -> AppResult<()> {
                conn.execute(
                    &format!("UPDATE node SET {col} = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ?1"),
                    params![n.id, val],
                )?;
                changed = true;
                Ok(())
            };
            if lt != n.title && !has_pending_field(conn, &n.id, "title")? {
                set("title", Some(&n.title))?;
            }
            if lpos != n.position && !has_pending_field(conn, &n.id, "position")? {
                set("position", Some(&n.position))?;
            }
            if lp != n.parent_id && !has_pending_field(conn, &n.id, "parent_id")? {
                let cyc = match &n.parent_id {
                    Some(p) => would_cycle(conn, &n.id, p)?,
                    None => false,
                };
                if !cyc {
                    set("parent_id", n.parent_id.as_deref())?;
                }
            }
            if ld != deleted && !has_pending_field(conn, &n.id, "deleted_at")? {
                set("deleted_at", deleted.as_deref())?;
            }
            if changed {
                search::reindex(conn, &n.id)?;
            }
            Ok(changed)
        }
    }
}

/// Applique un lot de nœuds distants (parents d'abord) puis avance le curseur — dans UNE transaction.
/// Un champ modifié localement et pas encore acquitté n'est jamais écrasé.
pub fn apply_remote_nodes(
    conn: &Connection,
    workspace_id: &str,
    nodes: &[RemoteNode],
    cursor: Option<i64>,
) -> AppResult<ApplyReport> {
    let tx = crate::db::begin(conn)?;
    require_enabled(&tx, workspace_id)?;
    tx.execute("UPDATE sync_settings SET applying = 1 WHERE id = 1", [])?;
    let mut remaining: Vec<&RemoteNode> = nodes.iter().collect();
    let mut applied = 0;
    loop {
        let before = remaining.len();
        let mut next = Vec::new();
        for n in remaining {
            let parent_known = match &n.parent_id {
                _ if n.purged_at.is_some() => true, // une pierre tombale n'a besoin d'aucun parent
                None => true,
                Some(p) => tx
                    .query_row("SELECT 1 FROM node WHERE id = ?1", [p], |_| Ok(()))
                    .optional()?
                    .is_some(),
            };
            if parent_known {
                if apply_one(&tx, workspace_id, n)? {
                    applied += 1;
                }
            } else {
                next.push(n);
            }
        }
        remaining = next;
        if remaining.is_empty() || remaining.len() == before {
            break;
        }
    }
    let unresolved = remaining.len();
    if unresolved == 0 {
        if let Some(c) = cursor {
            tx.execute(
                "UPDATE sync_state SET node_cursor = max(node_cursor, ?2), last_pull_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE workspace_id = ?1",
                params![workspace_id, c],
            )?;
        }
    }
    tx.execute("UPDATE sync_settings SET applying = 0 WHERE id = 1", [])?;
    tx.commit()?;
    Ok(ApplyReport {
        applied,
        skipped: 0,
        unresolved,
    })
}

fn has_pending_key(conn: &Connection, entity: &str, id: &str, path: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM oplog WHERE entity = ?1 AND entity_id = ?2 AND status = 'pending'
                        AND json_type(fields_json, ?3) IS NOT NULL)",
        params![entity, id, path],
        |r| r.get(0),
    )?)
}

fn is_unique_violation(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
}

/// Écrit un nom de propriété/vue distant ; en cas de doublon local (même nom, insensible à la casse), suffixe « (2) », « (3) »…
/// pour que les deux appareils gardent les deux objets (jamais de perte).
fn set_unique_name(conn: &Connection, table: &str, id: &str, base: &str) -> AppResult<()> {
    for n in 1..50 {
        let candidate = if n == 1 {
            base.to_string()
        } else {
            format!("{base} ({n})")
        };
        match conn.execute(
            &format!("UPDATE {table} SET name = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ?1"),
            params![id, candidate],
        ) {
            Ok(_) => return Ok(()),
            Err(e) if is_unique_violation(&e) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::Invalid("trop de noms identiques".into()))
}

fn db_node_exists(conn: &Connection, ws: &str, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM node WHERE id = ?1 AND workspace_id = ?2 AND kind = 'database'",
            params![id, ws],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Propriété ou vue distante. `table` ∈ {db_property, db_view} ; `kind_col` ∈ {type, layout}.
#[allow(clippy::too_many_arguments)]
fn apply_def(
    conn: &Connection,
    entity: &str,
    table: &str,
    kind_col: &str,
    id: &str,
    database_id: &str,
    name: &str,
    kind_val: &str,
    config: &Value,
    position: &str,
    deleted_at: Option<&str>,
) -> AppResult<bool> {
    let deleted = norm_ts(conn, deleted_at)?;
    let cfg = serde_json::to_string(config).map_err(|e| AppError::Invalid(e.to_string()))?;
    let exists: Option<(String, String, String, String, Option<String>, String)> = conn
        .query_row(
            &format!("SELECT name, {kind_col}, config_json, position, deleted_at, database_id FROM {table} WHERE id = ?1"),
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()?;
    match exists {
        None => {
            // Le nom est inséré provisoirement sous un nom neutre puis fixé de façon unique.
            conn.execute(
                &format!(
                    "INSERT INTO {table} (id, database_id, name, {kind_col}, config_json, position, created_at, updated_at, deleted_at, version)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?7, 1)"
                ),
                params![id, database_id, format!("sync-{id}"), kind_val, cfg, position, deleted],
            )?;
            set_unique_name(conn, table, id, name)?;
            Ok(true)
        }
        Some((lname, lkind, lcfg, lpos, ldel, ldb)) => {
            if ldb != database_id {
                return Err(AppError::Invalid("objet d'une autre base".into()));
            }
            let mut changed = false;
            if lname != name && !has_pending_key(conn, entity, id, "$.name")? {
                set_unique_name(conn, table, id, name)?;
                changed = true;
            }
            let mut set = |col: &str, val: Option<&str>| -> AppResult<()> {
                conn.execute(
                    &format!("UPDATE {table} SET {col} = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ?1"),
                    params![id, val],
                )?;
                changed = true;
                Ok(())
            };
            if lkind != kind_val && !has_pending_key(conn, entity, id, &format!("$.{kind_col}"))? {
                set(kind_col, Some(kind_val))?;
            }
            let same_cfg = serde_json::from_str::<Value>(&lcfg).ok().as_ref() == Some(config);
            if !same_cfg && !has_pending_key(conn, entity, id, "$.config")? {
                set("config_json", Some(&cfg))?;
            }
            if lpos != position && !has_pending_key(conn, entity, id, "$.position")? {
                set("position", Some(position))?;
            }
            if ldel != deleted && !has_pending_key(conn, entity, id, "$.deleted_at")? {
                set("deleted_at", deleted.as_deref())?;
            }
            Ok(changed)
        }
    }
}

fn apply_row(
    conn: &Connection,
    id: &str,
    database_id: &str,
    props: &serde_json::Map<String, Value>,
) -> AppResult<Option<bool>> {
    // La ligne est d'abord un nœud (appliqué par le flux des nœuds) : sinon on attend.
    let node_ok: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM node WHERE id = ?1 AND parent_id = ?2)",
        params![id, database_id],
        |r| r.get(0),
    )?;
    if !node_ok {
        return Ok(None);
    }
    let local: Option<String> = conn
        .query_row(
            "SELECT props_json FROM db_row WHERE node_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let mut current: serde_json::Map<String, Value> = match &local {
        Some(t) => serde_json::from_str(t).unwrap_or_default(),
        None => serde_json::Map::new(),
    };
    let mut changed = local.is_none();
    // Cellules distantes : appliquées sauf si une modification locale de CETTE cellule attend d'être envoyée.
    for (k, v) in props {
        if has_pending_key(conn, "row", id, &format!("$.cells.\"{k}\""))? {
            continue;
        }
        if current.get(k) != Some(v) {
            current.insert(k.clone(), v.clone());
            changed = true;
        }
    }
    // Cellules supprimées à distance (absentes du serveur) et sans modification locale en attente.
    let gone: Vec<String> = current
        .keys()
        .filter(|k| !props.contains_key(*k))
        .cloned()
        .collect();
    for k in gone {
        if !has_pending_key(conn, "row", id, &format!("$.cells.\"{k}\""))? {
            current.remove(&k);
            changed = true;
        }
    }
    if changed {
        let text = serde_json::to_string(&current).map_err(|e| AppError::Invalid(e.to_string()))?;
        conn.execute(
            "INSERT INTO db_row (node_id, database_id, props_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(node_id) DO UPDATE SET props_json = excluded.props_json",
            params![id, database_id, text],
        )?;
        conn.execute(
            "UPDATE node SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), version = version + 1 WHERE id = ?1",
            [id],
        )?;
        search::reindex(conn, id)?;
    }
    Ok(Some(changed))
}

/// Applique un lot du flux « structure » (propriétés, vues, lignes) puis avance le curseur — dans UNE transaction.
/// Chaque élément est appliqué dans son propre point de sauvegarde : un élément impossible est compté (`skipped`) sans
/// empêcher les autres. Un élément qui attend un nœud pas encore reçu est « non résolu » : le curseur n'avance pas.
pub fn apply_remote_struct(
    conn: &Connection,
    workspace_id: &str,
    items: &[RemoteStruct],
    cursor: Option<i64>,
) -> AppResult<ApplyReport> {
    let tx = crate::db::begin(conn)?;
    require_enabled(&tx, workspace_id)?;
    tx.execute("UPDATE sync_settings SET applying = 1 WHERE id = 1", [])?;
    let (mut applied, mut skipped, mut unresolved) = (0, 0, 0);
    for item in items {
        let sp = crate::db::begin(&tx)?;
        let r: AppResult<Option<bool>> = match item {
            RemoteStruct::Prop {
                id,
                database_id,
                name,
                prop_type,
                config,
                position,
                deleted_at,
            } => {
                if !db_node_exists(&sp, workspace_id, database_id)? {
                    Ok(None)
                } else {
                    apply_def(
                        &sp,
                        "prop",
                        "db_property",
                        "type",
                        id,
                        database_id,
                        name,
                        prop_type,
                        config,
                        position,
                        deleted_at.as_deref(),
                    )
                    .map(Some)
                }
            }
            RemoteStruct::View {
                id,
                database_id,
                name,
                layout,
                config,
                position,
                deleted_at,
            } => {
                if !db_node_exists(&sp, workspace_id, database_id)? {
                    Ok(None)
                } else {
                    apply_def(
                        &sp,
                        "view",
                        "db_view",
                        "layout",
                        id,
                        database_id,
                        name,
                        layout,
                        config,
                        position,
                        deleted_at.as_deref(),
                    )
                    .map(Some)
                }
            }
            RemoteStruct::Row {
                id,
                database_id,
                props,
            } => {
                if !db_node_exists(&sp, workspace_id, database_id)? {
                    Ok(None)
                } else {
                    apply_row(&sp, id, database_id, props)
                }
            }
            RemoteStruct::Thread {
                id,
                node_id,
                quote,
                author_label,
                created_at,
                resolved_at,
                resolved_label,
                deleted_at,
            } => apply_thread(
                &sp,
                workspace_id,
                id,
                node_id,
                quote,
                author_label.as_deref(),
                created_at,
                resolved_at.as_deref(),
                resolved_label.as_deref(),
                deleted_at.as_deref(),
            ),
            RemoteStruct::Comment {
                id,
                thread_id,
                body,
                author_label,
                created_at,
                edited_at,
                deleted_at,
            } => apply_comment(
                &sp,
                id,
                thread_id,
                body,
                author_label.as_deref(),
                created_at,
                edited_at.as_deref(),
                deleted_at.as_deref(),
            ),
        };
        match r {
            Ok(Some(changed)) => {
                sp.commit()?;
                if changed {
                    applied += 1;
                }
            }
            Ok(None) => unresolved += 1, // le point de sauvegarde est abandonné (rien d'écrit)
            Err(_) => skipped += 1,
        }
    }
    if unresolved == 0 {
        if let Some(c) = cursor {
            tx.execute(
                "UPDATE sync_state SET struct_cursor = max(struct_cursor, ?2), last_pull_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE workspace_id = ?1",
                params![workspace_id, c],
            )?;
        }
    }
    tx.execute("UPDATE sync_settings SET applying = 0 WHERE id = 1", [])?;
    tx.commit()?;
    Ok(ApplyReport {
        applied,
        skipped,
        unresolved,
    })
}

/// Applique un fil distant : suppression, création, ou résolution (sauf résolution locale en attente).
/// `Ok(None)` : la page n'est pas (encore) là, on réessaiera sans avancer le curseur.
#[allow(clippy::too_many_arguments)]
fn apply_thread(
    conn: &Connection,
    ws: &str,
    id: &str,
    node_id: &str,
    quote: &str,
    author: Option<&str>,
    created_at: &str,
    resolved_at: Option<&str>,
    resolved_label: Option<&str>,
    deleted_at: Option<&str>,
) -> AppResult<Option<bool>> {
    if quote.chars().count() > 400
        || author.is_some_and(|a| a.chars().count() > 320)
        || resolved_label.is_some_and(|a| a.chars().count() > 320)
    {
        return Err(AppError::Invalid("fil distant invalide".into()));
    }
    let local: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT node_id, resolved_at FROM comment_thread WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if deleted_at.is_some() {
        // Supprimé ailleurs : on le supprime ici aussi (ses messages suivent), sans écho ni opération en attente.
        conn.execute(
            "DELETE FROM oplog WHERE status = 'pending' AND entity IN ('thread', 'comment') AND entity_id IN
               (SELECT id FROM comment_thread WHERE id = ?1 UNION SELECT id FROM comment WHERE thread_id = ?1)",
            [id],
        )?;
        let n = conn.execute("DELETE FROM comment_thread WHERE id = ?1", [id])?;
        return Ok(Some(n > 0));
    }
    let node_ok: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM node WHERE id = ?1 AND workspace_id = ?2 AND kind = 'page')",
        params![node_id, ws],
        |r| r.get(0),
    )?;
    if !node_ok {
        return Ok(None);
    }
    let resolved = norm_ts(conn, resolved_at)?;
    match local {
        None => {
            let created = norm_ts(conn, Some(created_at))?.unwrap_or_default();
            conn.execute(
                "INSERT INTO comment_thread (id, node_id, quote, created_at, created_by, resolved_at, resolved_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, node_id, quote, created, author, resolved, resolved.as_ref().and(resolved_label)],
            )?;
            Ok(Some(true))
        }
        Some((lnode, lres)) => {
            if lnode != node_id {
                return Err(AppError::Invalid("fil d'une autre page".into()));
            }
            if lres != resolved && !has_pending_key(conn, "thread", id, "$.resolved_at")? {
                conn.execute(
                    "UPDATE comment_thread SET resolved_at = ?2, resolved_by = ?3 WHERE id = ?1",
                    params![id, resolved, resolved.as_ref().and(resolved_label)],
                )?;
                return Ok(Some(true));
            }
            Ok(Some(false))
        }
    }
}

/// Applique un message distant : suppression, création ou modification (sauf modification locale en attente).
#[allow(clippy::too_many_arguments)]
fn apply_comment(
    conn: &Connection,
    id: &str,
    thread_id: &str,
    body: &str,
    author: Option<&str>,
    created_at: &str,
    edited_at: Option<&str>,
    deleted_at: Option<&str>,
) -> AppResult<Option<bool>> {
    if body.is_empty()
        || body.chars().count() > 5_000
        || author.is_some_and(|a| a.chars().count() > 320)
    {
        return Err(AppError::Invalid("message distant invalide".into()));
    }
    if deleted_at.is_some() {
        conn.execute(
            "DELETE FROM oplog WHERE status = 'pending' AND entity = 'comment' AND entity_id = ?1",
            [id],
        )?;
        let n = conn.execute("DELETE FROM comment WHERE id = ?1", [id])?;
        return Ok(Some(n > 0));
    }
    let thread_ok: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM comment_thread WHERE id = ?1)",
        [thread_id],
        |r| r.get(0),
    )?;
    if !thread_ok {
        return Ok(None);
    }
    let local: Option<(String, String)> = conn
        .query_row(
            "SELECT thread_id, body FROM comment WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let edited = norm_ts(conn, edited_at)?;
    match local {
        None => {
            let created = norm_ts(conn, Some(created_at))?.unwrap_or_default();
            conn.execute(
                "INSERT INTO comment (id, thread_id, body, author, created_at, edited_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, thread_id, body, author, created, edited],
            )?;
            Ok(Some(true))
        }
        Some((lthread, lbody)) => {
            if lthread != thread_id {
                return Err(AppError::Invalid("message d'un autre fil".into()));
            }
            if lbody != body && !has_pending_key(conn, "comment", id, "$.body")? {
                conn.execute(
                    "UPDATE comment SET body = ?2, edited_at = ?3 WHERE id = ?1",
                    params![id, body, edited],
                )?;
                return Ok(Some(true));
            }
            Ok(Some(false))
        }
    }
}

/// État Yjs local d'une page (pour la fusion côté interface), avec sa date de dernière écriture.
pub fn doc_for_merge(conn: &Connection, node_id: &str) -> AppResult<Option<DocForMerge>> {
    Ok(conn
        .query_row(
            "SELECT c.doc_state, c.updated_at FROM page_content c JOIN node n ON n.id = c.node_id
             WHERE c.node_id = ?1 AND n.kind = 'page'",
            [node_id],
            |r| {
                Ok(DocForMerge {
                    doc_state: B64.encode(r.get::<_, Vec<u8>>(0)?),
                    updated_at: r.get(1)?,
                })
            },
        )
        .optional()?)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DocOutcome {
    Applied,
    /// La page locale a changé depuis la lecture : ne rien écrire, recommencer la fusion.
    Stale,
    /// La page n'existe pas (encore) localement.
    Missing,
}

/// Écrit l'état fusionné d'une page SANS créer d'opération (pas d'écho vers le serveur).
pub fn apply_remote_doc(
    conn: &Connection,
    node_id: &str,
    doc_state: &[u8],
    content_json: &str,
    text_plain: &str,
    expected_updated_at: Option<&str>,
) -> AppResult<DocOutcome> {
    if doc_state.is_empty()
        || doc_state.len() > crate::content::MAX_STATE_BYTES
        || text_plain.len() > crate::content::MAX_TEXT_BYTES
    {
        return Err(AppError::Invalid("contenu distant invalide".into()));
    }
    serde_json::from_str::<Value>(content_json)
        .map_err(|_| AppError::Invalid("instantané JSON invalide".into()))?;
    let tx = crate::db::begin(conn)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM node WHERE id = ?1 AND kind = 'page')",
        [node_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(DocOutcome::Missing);
    }
    let current: Option<String> = tx
        .query_row(
            "SELECT updated_at FROM page_content WHERE node_id = ?1",
            [node_id],
            |r| r.get(0),
        )
        .optional()?;
    if current.as_deref() != expected_updated_at {
        return Ok(DocOutcome::Stale);
    }
    tx.execute("UPDATE sync_settings SET applying = 1 WHERE id = 1", [])?;
    let ts = tree::now(&tx)?;
    tx.execute(
        "INSERT INTO page_content (node_id, doc_state, content_json, text_plain, schema_version, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(node_id) DO UPDATE SET doc_state = excluded.doc_state, content_json = excluded.content_json,
           text_plain = excluded.text_plain, schema_version = excluded.schema_version, updated_at = excluded.updated_at",
        params![node_id, doc_state, content_json, text_plain, crate::content::SCHEMA_VERSION, ts],
    )?;
    tx.execute(
        "UPDATE node SET updated_at = ?2, version = version + 1 WHERE id = ?1",
        params![node_id, ts],
    )?;
    search::reindex(&tx, node_id)?;
    tx.execute("UPDATE sync_settings SET applying = 0 WHERE id = 1", [])?;
    tx.commit()?;
    Ok(DocOutcome::Applied)
}

pub fn set_doc_cursor(conn: &Connection, workspace_id: &str, cursor: i64) -> AppResult<()> {
    require_enabled(conn, workspace_id)?;
    conn.execute(
        "UPDATE sync_state SET doc_cursor = max(doc_cursor, ?2), last_pull_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE workspace_id = ?1",
        params![workspace_id, cursor],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
