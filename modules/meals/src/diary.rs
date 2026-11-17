//! The meal log over the host's typed database port. Each entry carries a revision. A write that
//! must not race is an update guarded by the revision it expects, followed by idempotent inserts
//! of the estimate and its items at the new revision, because the port has no transactions.
use crate::estimate::Item;
use crate::input::{invalid, Checked};
use crate::moments::normalise;
use crate::nutrients::{self, Figures};
use crate::store::{asc, find, in_list, insert_ignore, select, text, update};
use crate::util::jopt;
use moss_module_sdk::{
    query::{Compare, Filter, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const ENTRIES: &str = "app.meals_log_entries";
pub const ESTIMATES: &str = "app.meals_log_estimates";
pub const ITEMS: &str = "app.meals_log_estimate_items";

pub struct Entry {
    pub entry_id: String,
    pub consumed_at: String,
    pub local_date: String,
    pub offset_minutes: i64,
    pub description: String,
    pub serving_note: Option<String>,
    pub capture_kind: String,
    pub state: String,
    pub revision: i64,
    /// Changes whenever the row does, so a retry can tell itself apart from an earlier one.
    pub stamp: String,
    /// The estimate's figures at the current revision. Only an estimated entry shows them.
    pub figures: Figures,
    pub missing: Option<String>,
    pub question: Option<String>,
    pub items: Vec<Item>,
}

impl Entry {
    pub fn estimated_figures(&self) -> Option<&Figures> {
        (self.state == "estimated").then_some(&self.figures)
    }

    pub fn view(&self) -> Value {
        let needs = self.state == "needs_details";
        json!({
            "entryId": self.entry_id,
            "consumedAt": self.consumed_at,
            "localDate": self.local_date,
            "timezoneOffset": self.offset_minutes,
            "description": self.description,
            "servingNote": self.serving_note,
            "captureKind": self.capture_kind,
            "estimateState": self.state,
            "estimateRevision": self.revision,
            "nutrients": self.estimated_figures().map_or(Value::Null, nutrients::view),
            "items": self.items.iter().map(|i| json!({
                "label": i.label,
                "portionNote": i.portion_note,
                "nutrients": nutrients::view(&i.figures),
            })).collect::<Vec<_>>(),
            "missingDetails": if needs { json!(self.missing) } else { Value::Null },
            "clarificationQuestion": if needs { json!(self.question) } else { Value::Null },
        })
    }
}

fn opt_text(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().map(str::to_owned)
}

fn item_of(row: &Value) -> Item {
    Item {
        label: text(row, "label"),
        portion_note: opt_text(row, "portion_note"),
        figures: nutrients::from_row(row),
    }
}

/// Entries from their rows, each joined to its estimate and items at its own current revision.
fn assemble<H: Host + ?Sized>(host: &H, rows: Vec<Value>) -> Result<Vec<Entry>> {
    let ids: Vec<String> = rows.iter().map(|r| text(r, "entry_id")).collect();
    let (mut estimates, mut items): (HashMap<(String, i64), Value>, HashMap<(String, i64), Vec<Item>>) =
        Default::default();
    if !ids.is_empty() {
        for row in select(host, ESTIMATES, Query::select(in_list("entry_id", &ids)))? {
            let key = (text(&row, "entry_id"), row["revision"].as_i64().unwrap_or(0));
            estimates.insert(key, row);
        }
        let mut query = Query::select(in_list("entry_id", &ids));
        query.order = vec![asc("entry_id"), asc("revision"), asc("item_index")];
        for row in select(host, ITEMS, query)? {
            let key = (text(&row, "entry_id"), row["revision"].as_i64().unwrap_or(0));
            items.entry(key).or_default().push(item_of(&row));
        }
    }
    Ok(rows
        .iter()
        .map(|row| {
            let key = (text(row, "entry_id"), row["estimate_revision"].as_i64().unwrap_or(1));
            let estimate = estimates.get(&key);
            Entry {
                entry_id: key.0.clone(),
                consumed_at: normalise(&text(row, "consumed_at")),
                local_date: text(row, "local_date"),
                offset_minutes: row["timezone_offset"].as_i64().unwrap_or(0),
                description: text(row, "description"),
                serving_note: opt_text(row, "serving_note"),
                capture_kind: text(row, "capture_kind"),
                state: text(row, "estimate_state"),
                revision: key.1,
                stamp: text(row, "updated_at"),
                figures: estimate.map_or(nutrients::UNKNOWN, nutrients::from_row),
                missing: estimate.and_then(|e| opt_text(e, "missing_details")),
                question: estimate.and_then(|e| opt_text(e, "clarification_question")),
                items: items.remove(&key).unwrap_or_default(),
            }
        })
        .collect())
}

fn one<H: Host + ?Sized>(host: &H, filter: Filter) -> Result<Option<Entry>> {
    match find(host, ENTRIES, filter)? {
        Some(row) => Ok(assemble(host, vec![row])?.into_iter().next()),
        None => Ok(None),
    }
}

pub fn get<H: Host + ?Sized>(host: &H, entry_id: &str) -> Result<Option<Entry>> {
    one(host, Filter::eq("entry_id", entry_id))
}

fn listed<H: Host + ?Sized>(host: &H, filter: Filter) -> Result<Vec<Entry>> {
    let mut query = Query::select(filter);
    query.order = vec![asc("consumed_at"), asc("entry_id")];
    assemble(host, select(host, ENTRIES, query)?)
}

pub fn list_day<H: Host + ?Sized>(host: &H, date: &str) -> Result<Vec<Entry>> {
    listed(host, Filter::eq("local_date", date))
}

pub fn list_range<H: Host + ?Sized>(host: &H, from: &str, to: &str) -> Result<Vec<Entry>> {
    let bound = |op, value: &str| Filter::Compare {
        column: "local_date".into(),
        op,
        value: json!(value),
    };
    listed(
        host,
        Filter::And {
            filters: vec![bound(Compare::Ge, from), bound(Compare::Le, to)],
        },
    )
}

pub struct NewEntry {
    pub entry_id: String,
    pub consumed_at: String,
    pub local_date: String,
    pub offset_minutes: i64,
    pub description: String,
    pub serving_note: Option<String>,
    pub capture_kind: String,
    pub idempotency_key: String,
}

/// Saves a new entry waiting for its estimate. A repeat of the same key returns the entry the
/// first call made, with `false`.
pub fn create<H: Host + ?Sized>(host: &H, new: &NewEntry) -> Result<(Entry, bool)> {
    let inserted = insert_ignore(
        host,
        ENTRIES,
        vec![
            ("entry_id", json!(new.entry_id)),
            ("consumed_at", json!(new.consumed_at)),
            ("local_date", json!(new.local_date)),
            ("timezone_offset", json!(new.offset_minutes)),
            ("description", json!(new.description)),
            ("serving_note", json!(new.serving_note)),
            ("capture_kind", json!(new.capture_kind)),
            ("estimate_state", json!("pending")),
            ("estimate_revision", json!(1)),
            ("idempotency_key", json!(new.idempotency_key)),
        ],
    )?;
    let filter = if inserted.is_empty() {
        Filter::eq("idempotency_key", new.idempotency_key.as_str())
    } else {
        Filter::eq("entry_id", new.entry_id.as_str())
    };
    let entry = one(host, filter)?.ok_or_else(|| Error::new("Entry not visible after insert"))?;
    Ok((entry, !inserted.is_empty()))
}

fn at_revision(entry_id: &str, revision: i64) -> Filter {
    Filter::And {
        filters: vec![
            Filter::eq("entry_id", entry_id),
            Filter::eq("estimate_revision", revision),
        ],
    }
}

fn write_estimate<H: Host + ?Sized>(
    host: &H,
    entry_id: &str,
    revision: i64,
    figures: &Figures,
    (missing, question): (&Option<String>, &Option<String>),
    items: &[Item],
) -> Result<()> {
    let mut fields = vec![
        ("entry_id", json!(entry_id)),
        ("revision", json!(revision)),
        ("missing_details", json!(missing)),
        ("clarification_question", json!(question)),
    ];
    fields.extend(nutrients::to_columns(figures));
    insert_ignore(host, ESTIMATES, fields)?;
    // Items reference the estimate row, so they go in after it.
    for (index, item) in items.iter().enumerate() {
        let mut fields = vec![
            ("entry_id", json!(entry_id)),
            ("revision", json!(revision)),
            ("item_index", json!(index)),
            ("label", json!(item.label)),
            ("portion_note", json!(item.portion_note)),
        ];
        fields.extend(nutrients::to_columns(&item.figures));
        insert_ignore(host, ITEMS, fields)?;
    }
    Ok(())
}

/// What a finished estimate job stores. The figures are always the sum of the items.
pub struct Recorded {
    pub state: &'static str,
    pub items: Vec<Item>,
    pub figures: Option<Figures>,
    pub missing: Option<String>,
    pub question: Option<String>,
}

pub fn failed() -> Recorded {
    Recorded {
        state: "failed",
        items: vec![],
        figures: None,
        missing: None,
        question: None,
    }
}

/// Stores an estimate if the entry is still at the revision the job read. A newer correction
/// wins, and the job's answer is dropped.
pub fn record<H: Host + ?Sized>(
    host: &H,
    entry_id: &str,
    expected: i64,
    recorded: &Recorded,
) -> Result<Option<Entry>> {
    let set = vec![
        ("estimate_state", json!(recorded.state)),
        ("estimate_revision", json!(expected + 1)),
    ];
    if !update(host, ENTRIES, at_revision(entry_id, expected), set)? {
        return Ok(None);
    }
    write_estimate(
        host,
        entry_id,
        expected + 1,
        &recorded.figures.unwrap_or(nutrients::UNKNOWN),
        (&recorded.missing, &recorded.question),
        &recorded.items,
    )?;
    get(host, entry_id)
}

/// Puts a failed entry back to waiting, so a retry can queue it. Anything else is left alone.
pub fn mark_pending<H: Host + ?Sized>(host: &H, entry_id: &str, revision: i64) -> Result<Option<Entry>> {
    let filter = Filter::And {
        filters: vec![
            Filter::eq("entry_id", entry_id),
            Filter::eq("estimate_revision", revision),
            Filter::eq("estimate_state", "failed"),
        ],
    };
    if !update(host, ENTRIES, filter, vec![("estimate_state", json!("pending"))])? {
        return Ok(None);
    }
    get(host, entry_id)
}

pub fn delete<H: Host + ?Sized>(host: &H, entry_id: &str) -> Result<bool> {
    Ok(!Client(host)
        .query(ENTRIES, &Query::delete(Filter::eq("entry_id", entry_id)))?
        .is_empty())
}

pub struct When {
    pub consumed_at: String,
    pub local_date: String,
    pub offset_minutes: i64,
}

pub struct ItemPatch {
    pub label: Option<String>,
    pub portion_note: Option<Option<String>>,
    /// A null in a correction leaves the stored figure alone, so it is absent here.
    pub figures: Figures,
}

#[derive(Default)]
pub struct Patch {
    pub description: Option<String>,
    pub serving_note: Option<Option<String>>,
    pub when: Option<When>,
    pub items: Option<Vec<ItemPatch>>,
}

/// A correction laid over the current items by position. A field left out keeps its stored
/// value. An item past the end is new and needs a label.
pub fn merge_items(current: &[Item], patch: &[ItemPatch]) -> Checked<Vec<Item>> {
    let mut merged = vec![];
    for index in 0..current.len().max(patch.len()) {
        let (base, change) = (current.get(index), patch.get(index));
        let Some(change) = change else {
            merged.extend(base.cloned());
            continue;
        };
        let label = change.label.clone().or_else(|| base.map(|b| b.label.clone()));
        let Some(label) = label.filter(|l| !l.trim().is_empty()) else {
            return invalid(format!("items[{index}] is new and needs a label"));
        };
        let mut figures = nutrients::UNKNOWN;
        for (slot, (new, old)) in figures.iter_mut().zip(change.figures.iter().zip(
            base.map_or(nutrients::UNKNOWN, |b| b.figures),
        )) {
            *slot = (*new).or(old);
        }
        merged.push(Item {
            label,
            portion_note: change
                .portion_note
                .clone()
                .unwrap_or_else(|| base.and_then(|b| b.portion_note.clone())),
            figures,
        });
    }
    Ok(merged)
}

/// Applies a correction if the entry is still at the revision the person read. `Ok(None)` means
/// it is not. A correction that cannot apply fails before the revision moves.
pub fn correct<H: Host + ?Sized>(
    host: &H,
    entry_id: &str,
    expected: i64,
    patch: &Patch,
) -> Result<Checked<Option<Entry>>> {
    let Some(current) = get(host, entry_id)?.filter(|e| e.revision == expected) else {
        return Ok(Ok(None));
    };
    let merged = match &patch.items {
        Some(items) => match merge_items(&current.items, items) {
            Ok(merged) => Some(merged),
            Err(error) => return Ok(Err(error)),
        },
        None => None,
    };
    let state = if merged.is_some() { "estimated" } else { current.state.as_str() };
    let mut set: Vec<(&str, Value)> = vec![
        ("estimate_state", json!(state)),
        ("estimate_revision", json!(expected + 1)),
    ];
    if let Some(description) = &patch.description {
        set.push(("description", json!(description)));
    }
    if let Some(note) = &patch.serving_note {
        set.push(("serving_note", json!(note)));
    }
    if let Some(when) = &patch.when {
        set.push(("consumed_at", json!(when.consumed_at)));
        set.push(("local_date", json!(when.local_date)));
        set.push(("timezone_offset", json!(when.offset_minutes)));
    }
    if !update(host, ENTRIES, at_revision(entry_id, expected), set)? {
        return Ok(Ok(None));
    }
    let next = expected + 1;
    match merged {
        Some(items) => {
            let total = nutrients::sum(items.iter().map(|i| &i.figures));
            write_estimate(host, entry_id, next, &total, (&None, &None), &items)?;
        }
        // A text or time edit still moves the revision, and an estimate is read at the current
        // revision, so the earlier estimate and items are copied forward. An entry that never
        // estimated has nothing to copy.
        None => {
            let has_estimate = find(
                host,
                ESTIMATES,
                Filter::And {
                    filters: vec![
                        Filter::eq("entry_id", entry_id),
                        Filter::eq("revision", expected),
                    ],
                },
            )?
            .is_some();
            if has_estimate {
                write_estimate(
                    host,
                    entry_id,
                    next,
                    &current.figures,
                    (&current.missing, &current.question),
                    &current.items,
                )?;
            }
        }
    }
    Ok(Ok(get(host, entry_id)?))
}

/// Day totals over the entries whose estimate is complete. A figure is unknown unless at least
/// one estimated entry knows it, so a half-estimated day never reads as a light day. Every
/// other entry flips `incomplete`, is counted, and adds nothing.
pub fn totals(date: &str, entries: &[Entry]) -> Value {
    let known: Vec<&Figures> = entries.iter().filter_map(Entry::estimated_figures).collect();
    let without = entries.len() - known.len();
    json!({
        "localDate": date,
        "nutrients": nutrients::view(&nutrients::sum(known)),
        "incomplete": without > 0,
        "entriesWithoutEstimate": without,
    })
}

/// The day's calories against a target. Within 15 percent of the target is on target.
pub fn calorie_fit(target: i64, estimated: f64) -> Value {
    let difference = (estimated - target as f64 + 0.5).floor();
    let band = if difference.abs() <= target as f64 * 0.15 {
        "on"
    } else if difference > 0.0 {
        "over"
    } else {
        "under"
    };
    json!({
        "targetKcal": target,
        "estimatedKcal": jopt(Some(estimated)),
        "band": band,
        "differenceKcal": jopt(Some(difference)),
    })
}
