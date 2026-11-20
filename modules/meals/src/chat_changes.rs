//! Observe Meals' actual database writes for the chat Done receipt. Forward every effect to
//! the same host; take the before image using the mutation's own filter, never model text.
use moss_module_sdk::{
    query::{Conflict, Filter, Kind, Query},
    Host, Result,
};
use serde_json::{json, Value};
use std::cell::RefCell;

pub struct Recorded<'a, H: Host + ?Sized> {
    host: &'a H,
    changes: RefCell<Vec<Value>>,
}
impl<'a, H: Host + ?Sized> Recorded<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self {
            host,
            changes: RefCell::new(vec![]),
        }
    }
    pub fn append(&self, data: &mut Value) {
        let changes = self.changes.borrow();
        if !changes.is_empty() && data.is_object() {
            data["changed"] = json!(changes.iter().take(32).collect::<Vec<_>>());
        }
    }
}
fn label(table: &str) -> &'static str {
    match table {
        "app.meals_kitchens" => "Kitchen",
        "app.meals_household_members" => "Household member",
        "app.meals_meal_slot_rules" => "Meal slot",
        "app.meals_plans" => "Meal plan",
        "app.meals_plan_days" => "Plan day",
        "app.meals_planned_meals" => "Planned meal",
        "app.meals_planned_meal_eaters" => "Meal eater",
        "app.meals_shopping_lists" => "Shopping list",
        "app.meals_shopping_list_items" => "Shopping item",
        "app.meals_log_entries" => "Food log entry",
        "app.meals_log_estimates" => "Food estimate",
        "app.meals_log_estimate_items" => "Estimate item",
        "app.meals_ratings" => "Meal rating",
        "app.meals_favourites" => "Favourite recipe",
        "app.meals_pantry_items" => "Pantry item",
        "app.meals_staples" => "Pantry staple",
        "app.meals_undo_actions" => "Undo record",
        "app.meals_swap_choices" => "Swap choice",
        "app.meals_recipes" => "Recipe",
        _ => "Recipe ingredient",
    }
}
fn shown(value: &Value) -> String {
    let text = value.to_string();
    if text.len() <= 8192 {
        return text;
    }
    let mut end = 8100;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} … (open Meals for the full record)", &text[..end])
}
impl<H: Host + ?Sized> Host for Recorded<'_, H> {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        if port != "db" || operation != "query" {
            return self.host.call(port, operation, resource, parameters);
        }
        let q: Query = serde_json::from_value(parameters.clone())?;
        if q.kind == Kind::Select {
            return self.host.call(port, operation, resource, parameters);
        }
        let before = if q.kind == Kind::Insert {
            match &q.conflict {
                Conflict::Update { columns, .. } => {
                    let filter = Filter::And {
                        filters: columns
                            .iter()
                            .map(|k| Filter::eq(k, q.values.get(k).cloned().unwrap_or(Value::Null)))
                            .collect(),
                    };
                    self.host.call(
                        port,
                        operation,
                        resource,
                        serde_json::to_value(Query::select(filter))?,
                    )?
                }
                _ => json!([]),
            }
        } else {
            self.host.call(
                port,
                operation,
                resource,
                serde_json::to_value(Query::select(q.filter.clone()))?,
            )?
        };
        let result = self.host.call(port, operation, resource, parameters)?;
        if result.as_array().is_some_and(|rows| !rows.is_empty()) {
            let after = if q.kind == Kind::Delete {
                json!([])
            } else {
                result.clone()
            };
            if before != after {
                self.changes.borrow_mut().push(
                    json!({"label":label(resource),"before":shown(&before),"after":shown(&after)}),
                );
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Store;
    impl Host for Store {
        fn call(&self, _: &str, _: &str, _: &str, params: Value) -> Result<Value> {
            Ok(if params["kind"] == "select" {
                json!([{"item_id":"a","quantity":2}])
            } else {
                json!([{"item_id":"a","quantity":3}])
            })
        }
    }
    #[test]
    fn receipt_has_the_actual_old_and_saved_rows_and_reads_have_no_receipt() {
        let h = Recorded::new(&Store);
        let q = Query::update(
            Filter::eq("item_id", "a"),
            [("quantity".into(), json!(3))].into(),
        );
        h.call(
            "db",
            "query",
            "app.meals_pantry_items",
            serde_json::to_value(q).unwrap(),
        )
        .unwrap();
        let mut data = json!({"ok":true});
        h.append(&mut data);
        assert_eq!(
            data["changed"][0]["before"],
            r#"[{"item_id":"a","quantity":2}]"#
        );
        assert_eq!(
            data["changed"][0]["after"],
            r#"[{"item_id":"a","quantity":3}]"#
        );
        let read = Recorded::new(&Store);
        read.call(
            "db",
            "query",
            "app.meals_pantry_items",
            serde_json::to_value(Query::default()).unwrap(),
        )
        .unwrap();
        let mut data = json!({});
        read.append(&mut data);
        assert!(data.get("changed").is_none());
    }
}
