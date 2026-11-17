//! The undo tool. It restores the record kept before a write (kinds removed, bought and cooked)
//! and marks the record undone last. Every restore is guarded by what the write left behind, so
//! a repeat after a crash, or a later edit of the same row, is skipped and never doubled.
use crate::input::{self, invalid, Checked, Fields};
use crate::shopping::{self, ITEMS, PANTRY_ITEMS, UNDO};
use crate::store::{self, in_list, insert_ignore};
use crate::util::{context, values};
use crate::kitchen;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

const CANNOT: &str = "That action cannot be undone here";

/// Columns of a stored shopping line record, in the order the insert names them.
const LINE_COLUMNS: [&str; 14] = [
    "line_id",
    "line_key",
    "name",
    "quantity",
    "unit",
    "purchase_quantity",
    "purchase_unit",
    "store_section",
    "manual",
    "covered_by_pantry",
    "not_in_plan",
    "converted_from",
    "source_meal_ids",
    "checked_at",
];

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}

fn done(restored: usize, total: usize) -> Value {
    json!({"restored": restored, "skipped": total.saturating_sub(restored)})
}

fn restore_item<H: Host + ?Sized>(host: &H, kitchen_id: &str, item: &Value) -> Result<usize> {
    let mut fields = vec![("kitchen_id", json!(kitchen_id))];
    for key in ["item_id", "name", "name_key", "quantity", "unit", "source", "created_at"] {
        fields.push((key, item[key].clone()));
    }
    Ok(insert_ignore(host, PANTRY_ITEMS, fields)?.len())
}

fn restore_lines<H: Host + ?Sized>(host: &H, kitchen_id: &str, lines: &[Value]) -> Result<usize> {
    let list_id = shopping::ensure_list(host, kitchen_id, None)?;
    let mut restored = 0;
    for line in lines {
        let mut fields = vec![("kitchen_id", json!(kitchen_id)), ("list_id", json!(list_id))];
        for key in LINE_COLUMNS {
            fields.push((key, line[key].clone()));
        }
        fields.push(("bought_at", line["bought_at"].clone()));
        restored += insert_ignore(host, ITEMS, fields)?.len();
    }
    Ok(restored)
}

fn undo_bought<H: Host + ?Sized>(host: &H, state: &Value) -> Result<Option<Value>> {
    let (Some(at), Some(line_ids), Some(item_ids)) = (
        state["at"].as_str(),
        strings(&state["lineIds"]),
        strings(&state["itemIds"]),
    ) else {
        return Ok(None);
    };
    let gone = Client(host)
        .query(
            PANTRY_ITEMS,
            &Query::delete(Filter::And {
                filters: vec![in_list("item_id", &item_ids), Filter::eq("updated_at", at)],
            }),
        )?
        .len();
    let list = shopping::read_list(host)?;
    let (_, now) = context(host)?;
    for line in list
        .lines
        .iter()
        .filter(|l| line_ids.contains(&l.line_id) && l.bought_at.as_deref().is_some_and(|b| same_instant(b, at)))
    {
        let twin = line.line_key.is_some()
            && list.lines.iter().any(|o| o.bought_at.is_none() && o.line_key == line.line_key);
        if twin {
            continue;
        }
        Client(host).query(
            ITEMS,
            &Query::update(
                Filter::eq("line_id", line.line_id.as_str()),
                values(vec![("bought_at", Value::Null), ("updated_at", json!(now))]),
            ),
        )?;
    }
    Ok(Some(done(gone, item_ids.len())))
}

/// Two timestamp strings that name the same moment, whatever their spelling.
fn same_instant(a: &str, b: &str) -> bool {
    match (crate::util::epoch_ms(a), crate::util::epoch_ms(b)) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

fn undo_cooked<H: Host + ?Sized>(host: &H, state: &Value) -> Result<Option<(Value, bool)>> {
    let (Some(meal_id), Some(at), Some(changes)) = (
        state["mealId"].as_str(),
        state["at"].as_str(),
        state["changes"].as_array(),
    ) else {
        return Ok(None);
    };
    let (_, now) = context(host)?;
    Client(host).query(
        store::MEALS,
        &Query::update(
            Filter::And {
                filters: vec![Filter::eq("meal_id", meal_id), Filter::eq("cooked_at", at)],
            },
            values(vec![("cooked_at", Value::Null), ("updated_at", json!(now))]),
        ),
    )?;
    let mut restored = 0;
    for change in changes {
        let Some(item_id) = change["itemId"].as_str() else { continue };
        restored += Client(host)
            .query(
                PANTRY_ITEMS,
                &Query::update(
                    Filter::And {
                        filters: vec![Filter::eq("item_id", item_id), Filter::eq("updated_at", at)],
                    },
                    values(vec![("quantity", change["before"].clone()), ("updated_at", json!(now))]),
                ),
            )?
            .len();
    }
    Ok(Some((done(restored, changes.len()), restored > 0)))
}

pub fn undo<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let action_id = match (|| {
        input::no_unknown_keys(input, &["actionId"])?;
        Ok(input::uuid(input, "actionId", true)?.unwrap_or_default())
    })() {
        Ok(id) => id,
        Err(e) => return Ok(Err(e)),
    };
    let record = store::find(host, UNDO, Filter::eq("action_id", action_id.as_str()))?
        .filter(|r| r["undone_at"].is_null());
    let Some(record) = record else {
        return Ok(invalid("There is nothing to undo"));
    };
    let state = &record["before_state"];
    let kitchen_id = kitchen::ensure(host)?;
    let kind = record["kind"].as_str().unwrap_or_default();
    let outcome = match kind {
        "removed" if state["item"].is_object() => {
            let restored = restore_item(host, &kitchen_id, &state["item"])?;
            if restored > 0 {
                shopping::on_pantry_change(host)?;
            }
            Some(done(restored, 1))
        }
        "removed" => match state["lines"].as_array() {
            Some(lines) => Some(done(restore_lines(host, &kitchen_id, lines)?, lines.len())),
            None => None,
        },
        "bought" => undo_bought(host, state)?,
        "cooked" => match undo_cooked(host, state)? {
            Some((result, changed)) => {
                if changed {
                    shopping::on_pantry_change(host)?;
                }
                Some(result)
            }
            None => None,
        },
        _ => None,
    };
    let Some(outcome) = outcome else {
        return Ok(invalid(CANNOT));
    };
    let (_, now) = context(host)?;
    Client(host).query(
        UNDO,
        &Query::update(
            Filter::And {
                filters: vec![
                    Filter::eq("action_id", action_id.as_str()),
                    Filter::Null { column: "undone_at".into(), not: false },
                ],
            },
            values(vec![("undone_at", json!(now))]),
        ),
    )?;
    Ok(Ok(outcome))
}
