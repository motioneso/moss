//! Check new receipts independently of the legacy tool-response oracle.
use super::*;

type Snapshot = Vec<(String, Value)>;
const TABLES: [(&str, &str); 20] = [
    ("Kitchen", "meals_kitchens"), ("Household member", "meals_household_members"),
    ("Meal slot", "meals_meal_slot_rules"), ("Meal plan", "meals_plans"),
    ("Plan day", "meals_plan_days"), ("Planned meal", "meals_planned_meals"),
    ("Meal eater", "meals_planned_meal_eaters"), ("Shopping list", "meals_shopping_lists"),
    ("Shopping item", "meals_shopping_list_items"), ("Food log entry", "meals_log_entries"),
    ("Food estimate", "meals_log_estimates"), ("Estimate item", "meals_log_estimate_items"),
    ("Meal rating", "meals_ratings"), ("Favourite recipe", "meals_favourites"),
    ("Pantry item", "meals_pantry_items"), ("Pantry staple", "meals_staples"),
    ("Undo record", "meals_undo_actions"), ("Swap choice", "meals_swap_choices"),
    ("Recipe", "meals_recipes"), ("Recipe ingredient", "meals_recipe_ingredients"),
];

pub(super) fn snapshot(w: &World, actor: uuid::Uuid) -> Snapshot {
    let sql = TABLES.iter().map(|(label, table)| format!(
        "SELECT '{label}'::text, to_jsonb(row) FROM app.{table} row WHERE owner_user_id=$1"
    )).collect::<Vec<_>>().join(" UNION ALL ");
    w.f.rt.block_on(w.f.root.query(&sql, &[&actor])).unwrap().iter()
        .map(|row| (row.get(0), row.get(1))).collect()
}

pub(super) fn verify(before: Snapshot, after: Snapshot, reply: &Value) {
    let Some(changes) = reply["body"]["data"].get("changed") else {
        assert_eq!(before.len(), after.len(), "row count changed without a receipt");
        assert!(before.iter().all(|row| after.contains(row)), "saved rows changed without a receipt");
        return;
    };
    let changes = changes.as_array().expect("receipt is an array");
    assert!(!changes.is_empty() && changes.len() <= 32);
    let parsed: Vec<(String, Vec<Value>, Vec<Value>)> = changes.iter().map(|field| {
        assert_eq!(field.as_object().unwrap().len(), 3);
        let label = field["label"].as_str().unwrap().to_owned();
        assert!(TABLES.iter().any(|(known, _)| *known == label));
        let old: Vec<Value> = serde_json::from_str(field["before"].as_str().unwrap()).unwrap();
        let new: Vec<Value> = serde_json::from_str(field["after"].as_str().unwrap()).unwrap();
        assert_ne!(old, new, "receipt must describe a change");
        (label, old, new)
    }).collect();
    for (index, (label, old, new)) in parsed.iter().enumerate() {
        // A tool may update a row several times: intermediate images must join the chain.
        for row in old {
            assert!(before.contains(&(label.clone(), row.clone())) || parsed[..index].iter()
                .any(|(l, _, rows)| l == label && rows.contains(row)), "receipt before image was never saved: {label}");
        }
        for row in new {
            assert!(after.contains(&(label.clone(), row.clone())) || parsed[index + 1..].iter()
                .any(|(l, rows, _)| l == label && rows.contains(row)), "receipt after image was never saved: {label}");
        }
    }
}

/// Only after run() independently verifies the receipt against real saved rows.
pub(super) fn legacy_reply(mut reply: Value) -> Value {
    if let Some(data) = reply["data"].as_object_mut() { data.remove("changed"); }
    reply
}
