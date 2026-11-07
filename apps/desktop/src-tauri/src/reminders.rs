//! Rappels de tâches : une propriété date-heure au rôle `reminder` déclenche un rappel quand son instant est passé,
//! tant que la tâche n'est pas terminée ni à la corbeille et que ce rappel n'a pas été acquitté.
//! Les rappels ne sonnent que pendant que l'application tourne (aucun service d'arrière-plan) : au démarrage,
//! ceux échus pendant l'absence sont signalés une fois (« rappels manqués »).

use crate::database;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderOut {
    pub row_id: String,
    pub database_id: String,
    pub property_id: String,
    pub title: String,
    /// Instant programmé (UTC, `AAAA-MM-JJTHH:MM:SSZ`).
    pub fire_at: String,
}

const MAX_BATCH: usize = 50;

fn is_done(props: &[database::PropertyOut], row: &database::RowOut) -> bool {
    props.iter().filter(|p| p.kind == "status").any(|p| {
        let Some(id) = row.props.get(&p.id).and_then(Value::as_str) else {
            return false;
        };
        p.config
            .get("options")
            .and_then(Value::as_array)
            .and_then(|a| {
                a.iter()
                    .find(|o| o.get("id").and_then(Value::as_str) == Some(id))
            })
            .and_then(|o| o.get("group").and_then(Value::as_str))
            == Some("done")
    })
}

/// Rappels échus à `now` (ISO UTC) et non acquittés, du plus ancien au plus récent (50 au plus).
pub fn due_at(conn: &Connection, now: &str) -> AppResult<Vec<ReminderOut>> {
    if now.len() < 19 || !now.is_char_boundary(19) {
        return Err(AppError::Invalid("horloge invalide".into()));
    }
    let now19 = &now[..19];
    let mut dbs = conn.prepare(
        "SELECT DISTINCT p.database_id FROM db_property p JOIN node n ON n.id = p.database_id
         WHERE p.deleted_at IS NULL AND n.deleted_at IS NULL AND json_extract(p.config_json, '$.role') = 'reminder'",
    )?;
    let ids: Vec<String> = dbs.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for db in ids {
        let props = database::properties(conn, &db)?;
        let rem: Vec<_> = props
            .iter()
            .filter(|p| p.config.get("role").and_then(Value::as_str) == Some("reminder"))
            .collect();
        for row in database::rows(conn, &db)? {
            if is_done(&props, &row) {
                continue;
            }
            for p in &rem {
                let Some(at) = row.props.get(&p.id).and_then(Value::as_str) else {
                    continue;
                };
                if at.len() < 19 || !at.is_char_boundary(19) || at[..19] > *now19 {
                    continue;
                }
                let fired: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM reminder_fired WHERE row_id = ?1 AND property_id = ?2 AND fire_at = ?3)",
                    params![row.id, p.id, at],
                    |r| r.get(0),
                )?;
                if !fired {
                    out.push(ReminderOut {
                        row_id: row.id.clone(),
                        database_id: db.clone(),
                        property_id: p.id.clone(),
                        title: row.title.clone(),
                        fire_at: at.to_string(),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.fire_at.cmp(&b.fire_at).then(a.row_id.cmp(&b.row_id)));
    out.truncate(MAX_BATCH);
    Ok(out)
}

/// Acquitte un rappel (idempotent) : il ne sonnera plus pour cet instant.
pub fn ack(conn: &Connection, row_id: &str, property_id: &str, fire_at: &str) -> AppResult<()> {
    if fire_at.len() < 19 {
        return Err(AppError::Invalid("instant de rappel invalide".into()));
    }
    let row = database::row(conn, row_id)?;
    if row.props.get(property_id).and_then(Value::as_str) != Some(fire_at) {
        // l'heure a changé entre-temps : ne pas masquer le nouveau rappel
        return Ok(());
    }
    let ts = crate::tree::now(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO reminder_fired (row_id, property_id, fire_at, acked_at) VALUES (?1, ?2, ?3, ?4)",
        params![row_id, property_id, fire_at, ts],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
