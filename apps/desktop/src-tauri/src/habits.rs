//! Pointages d'habitudes. Une habitude est une ligne d'une base contenant une propriété numérique au rôle `habit_goal`
//! (objectif de jours par semaine). Seuls les pointages sont stockés ; séries et taux sont calculés côté interface.

use crate::database;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HabitDay {
    pub row_id: String,
    pub day: String,
}

fn valid_day(d: &str) -> bool {
    database::is_valid_date(d)
}

fn ensure_habit(conn: &Connection, row_id: &str) -> AppResult<()> {
    let r = database::row(conn, row_id)?;
    let is_habit = database::properties(conn, &r.database_id)?
        .iter()
        .any(|p| p.config.get("role").and_then(Value::as_str) == Some("habit_goal"));
    if is_habit {
        Ok(())
    } else {
        Err(AppError::Invalid(
            "cette ligne n'est pas une habitude".into(),
        ))
    }
}

/// Pointe (`done = true`) ou dépointe un jour. Idempotent. Refuse les dates invalides et le futur au-delà de demain
/// (`today` = jour local de l'utilisateur, fourni par l'interface).
pub fn set(conn: &Connection, row_id: &str, day: &str, done: bool, today: &str) -> AppResult<()> {
    if !valid_day(day) || !valid_day(today) {
        return Err(AppError::Invalid("date invalide".into()));
    }
    let limit = database::add_interval(today, "daily").unwrap_or_else(|| today.to_string());
    if day > limit.as_str() {
        return Err(AppError::Invalid(
            "impossible de pointer un jour futur".into(),
        ));
    }
    ensure_habit(conn, row_id)?;
    if done {
        let ts = crate::tree::now(conn)?;
        conn.execute(
            "INSERT OR IGNORE INTO habit_log (row_id, day, created_at) VALUES (?1, ?2, ?3)",
            params![row_id, day, ts],
        )?;
    } else {
        conn.execute(
            "DELETE FROM habit_log WHERE row_id = ?1 AND day = ?2",
            params![row_id, day],
        )?;
    }
    Ok(())
}

/// Pointages des lignes vivantes d'une base entre `from` et `to` inclus (au plus 400 jours).
pub fn list(
    conn: &Connection,
    database_id: &str,
    from: &str,
    to: &str,
) -> AppResult<Vec<HabitDay>> {
    if !valid_day(from) || !valid_day(to) || from > to {
        return Err(AppError::Invalid("période invalide".into()));
    }
    database::node_db(conn, database_id)?;
    let mut st = conn.prepare(
        "SELECT h.row_id, h.day FROM habit_log h
         JOIN db_row r ON r.node_id = h.row_id JOIN node n ON n.id = h.row_id
         WHERE r.database_id = ?1 AND n.deleted_at IS NULL AND h.day BETWEEN ?2 AND ?3
         ORDER BY h.day, h.row_id",
    )?;
    let v: Vec<HabitDay> = st
        .query_map(params![database_id, from, to], |r| {
            Ok(HabitDay {
                row_id: r.get(0)?,
                day: r.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(v)
}

#[cfg(test)]
mod tests;
