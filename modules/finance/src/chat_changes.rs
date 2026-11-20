//! A chat write's receipt, captured at the guest's existing database boundary. Only the business
//! columns below are displayed; credential/link storage and activity/job plumbing are excluded.
use moss_module_sdk::{
    query::{Filter, Kind, Query},
    Client, Host, Result,
};
use serde_json::{json, Map, Value};
use std::{cell::RefCell, collections::BTreeMap};

struct Table {
    label: &'static str,
    keys: &'static [&'static str],
    columns: &'static [&'static str],
}

fn table(resource: &str) -> Option<Table> {
    let (label, keys, columns): (_, &[_], &[_]) = match resource {
        "app.finance_accounts" => (
            "Accounts",
            &["account_id"],
            &[
                "account_id",
                "name",
                "type",
                "subtype",
                "balance_cents",
                "iso_currency",
                "opening_date",
                "opening_balance_cents",
                "shared_to_household",
            ],
        ),
        "app.finance_transactions" => (
            "Transactions",
            &["id"],
            &[
                "id",
                "account_id",
                "name",
                "date",
                "amount_cents",
                "iso_currency",
                "category_id",
                "notes",
                "splits",
                "cleared",
                "review_state",
            ],
        ),
        "app.finance_categories" => (
            "Categories",
            &["id"],
            &["id", "name", "group_name", "is_income", "archived_at"],
        ),
        "app.finance_merchant_rules" => (
            "Payee rules",
            &["id"],
            &["id", "payee_key", "category_id", "enabled"],
        ),
        "app.finance_budget_policy" => (
            "Budget setup",
            &[],
            &["iso_currency", "revision", "taxonomy_ready"],
        ),
        "app.finance_budget_assignments" => (
            "Budget assignments",
            &["month", "category_id"],
            &["month", "category_id", "assigned_cents"],
        ),
        "app.finance_budget_drafts" => (
            "Budget draft",
            &["id"],
            &["id", "status", "iso_currency", "revision"],
        ),
        "app.finance_budget_draft_lines" => (
            "Draft lines",
            &["draft_id", "category_key"],
            &[
                "draft_id",
                "category_key",
                "category_name",
                "group_name",
                "proposed_cents",
                "adjusted_cents",
                "dropped",
            ],
        ),
        "app.finance_targets" => (
            "Category targets",
            &["category_id", "effective_month"],
            &[
                "category_id",
                "effective_month",
                "kind",
                "amount_cents",
                "iso_currency",
                "due_date",
                "weekday",
            ],
        ),
        "app.finance_bill_plans" => (
            "Bill plans",
            &["id"],
            &[
                "id",
                "name",
                "account_id",
                "category_id",
                "amount_cents",
                "anchor_date",
                "cadence",
                "end_date",
            ],
        ),
        "app.finance_bill_occurrences" => (
            "Bill occurrences",
            &["plan_id", "due_date"],
            &["plan_id", "due_date", "state", "transaction_id"],
        ),
        "app.finance_bill_adjustments" => (
            "Bill adjustments",
            &["plan_id", "due_date"],
            &["plan_id", "due_date", "planned_date", "amount_cents"],
        ),
        "app.finance_bill_suggestion_dismissals" => (
            "Dismissed bill suggestions",
            &["account_id", "payee_key", "cadence", "amount_cents"],
            &["account_id", "payee_key", "cadence", "amount_cents"],
        ),
        "app.finance_flex_policies" => (
            "Flexible pool",
            &["month"],
            &["month", "active", "flex_ids", "non_monthly_ids"],
        ),
        "app.finance_card_policies" => (
            "Card reserve policy",
            &["account_id"],
            &["account_id", "effective_month"],
        ),
        "app.finance_card_assignments" => (
            "Card reserves",
            &["account_id", "month"],
            &["account_id", "month", "assigned_cents", "available_cents"],
        ),
        "app.finance_items" => (
            "Bank sync status",
            &["item_id"],
            &["item_id", "status", "last_sync_at"],
        ),
        _ => return None,
    };
    Some(Table {
        label,
        keys,
        columns,
    })
}

fn project(rows: &[Value], columns: &[&str]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| {
                let out: Map<_, _> = columns
                    .iter()
                    .filter_map(|key| row.get(*key).map(|v| ((*key).into(), v.clone())))
                    .collect();
                Value::Object(out)
            })
            .collect(),
    )
}

fn shown(value: &Value) -> String {
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    if text.len() <= 7800 {
        return text;
    }
    let end = text
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|i| *i <= 7700)
        .last()
        .unwrap_or(0);
    format!(
        "{}… [truncated; read Finance for the full result]",
        &text[..end]
    )
}

#[derive(Default)]
struct Delta {
    before: Vec<String>,
    after: Vec<String>,
    truncated: bool,
}

pub struct Changes<'a, H: Host + ?Sized> {
    host: &'a H,
    deltas: RefCell<BTreeMap<&'static str, Delta>>,
}
impl<'a, H: Host + ?Sized> Changes<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self {
            host,
            deltas: RefCell::new(BTreeMap::new()),
        }
    }

    pub fn finish(&self, result: &mut Value) {
        // A refused call must never announce an accepted change.
        if result["status"] == "error" {
            return;
        }
        let mut fields = Vec::new();
        for (label, delta) in self.deltas.borrow().iter() {
            let suffix = if delta.truncated {
                " [more changes omitted; read Finance]"
            } else {
                ""
            };
            fields.push(
                json!({"label":label,"before":format!("{}{suffix}", shown(&json!(delta.before.join("\n")))),
                "after":format!("{}{suffix}", shown(&json!(delta.after.join("\n"))))}),
            );
        }
        if fields.is_empty() {
            fields.push(json!({"label":"Saved Finance records","before":"No displayed records changed","after":"No displayed records changed"}));
        }
        result["changed"] = json!(fields);
    }
}
impl<H: Host + ?Sized> Host for Changes<'_, H> {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        let Some(table) = (if port == "db" && operation == "query" {
            table(resource)
        } else {
            None
        }) else {
            return self.host.call(port, operation, resource, parameters);
        };
        let query: Query = serde_json::from_value(parameters.clone())?;
        if matches!(query.kind, Kind::Select) {
            return self.host.call(port, operation, resource, parameters);
        }
        let filter = if matches!(query.kind, Kind::Insert) {
            // Owner is supplied by the host; the remaining primary key identifies the prior row.
            let filters = table
                .keys
                .iter()
                .map(|key| Filter::eq(key, query.values.get(*key).cloned().unwrap_or(Value::Null)))
                .collect();
            Filter::And { filters }
        } else {
            query.filter.clone()
        };
        let before = Client(self.host).query(resource, &Query::select(filter))?;
        let result = self.host.call(port, operation, resource, parameters)?;
        let rows: Vec<Value> = serde_json::from_value(result.clone())?;
        // ON CONFLICT DO NOTHING returns no rows. It did not change any records.
        if rows.is_empty() {
            return Ok(result);
        }
        let after = if matches!(query.kind, Kind::Delete) {
            vec![]
        } else {
            rows
        };
        let (before, after) = (
            project(&before, table.columns),
            project(&after, table.columns),
        );
        if before != after {
            let mut deltas = self.deltas.borrow_mut();
            let delta = deltas.entry(table.label).or_default();
            if json!([delta.before, delta.after]).to_string().len() < 12000 {
                delta.before.push(shown(&before));
                delta.after.push(shown(&after));
            } else {
                delta.truncated = true;
            }
        }
        Ok(result)
    }
}
