//! Calendar source switches. They edit only the two Calendar entries of the account's
//! existing source-behavior preference and leave every other entry untouched.
use super::CalendarPorts;
use anyhow::{ensure, Context, Result};
use moss_module_host::runtime::{CallScope, Request};
use safety_core::db::DataContext;
use serde_json::{json, Map, Value};

/// Guest field name, stored entry name. Both switches default to on.
const SWITCHES: [(&str, &str); 2] = [
    ("briefings", "calendar.briefings"),
    ("planning", "calendar.planning"),
];

fn shape(stored: &Value) -> Value {
    let mut out = Map::new();
    for (field, entry) in SWITCHES {
        out.insert(
            field.into(),
            json!(stored.get(entry).and_then(Value::as_bool).unwrap_or(true)),
        );
    }
    Value::Object(out)
}

impl CalendarPorts {
    pub(crate) fn source_behaviors(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let update = match request.operation.as_str() {
            "get" => {
                ensure!(
                    request.parameters.as_object().is_some_and(Map::is_empty),
                    "Calendar source switches take no parameters"
                );
                None
            }
            "set" => {
                let body = request
                    .parameters
                    .as_object()
                    .context("Invalid calendar source switches")?;
                let mut update = Map::new();
                for (field, value) in body {
                    let entry = SWITCHES
                        .iter()
                        .find(|(name, _)| name == field)
                        .context("Invalid calendar source switches")?
                        .1;
                    ensure!(value.is_boolean(), "Invalid calendar source switches");
                    update.insert(entry.into(), value.clone());
                }
                ensure!(!update.is_empty(), "Invalid calendar source switches");
                Some(Value::Object(update))
            }
            _ => anyhow::bail!("Unknown calendar source operation"),
        };
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Calendar source switches unavailable"))?;
                let stored = if let Some(update) = update {
                    // Merge only the declared members so sibling modules' entries survive.
                    let row = cx.db().query_one(
                        "INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) VALUES(app.current_actor_user_id(),'sourceBehaviors',$1,now()) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=(CASE WHEN jsonb_typeof(app.preferences.value_json)='object' THEN app.preferences.value_json ELSE '{}'::jsonb END) || EXCLUDED.value_json, revision=app.preferences.revision+1, updated_at=now() RETURNING value_json",
                        &[&update],
                    ).await?;
                    row.get::<_, Value>(0)
                } else {
                    cx.db()
                        .query_opt("SELECT value_json FROM app.preferences WHERE key='sourceBehaviors'", &[])
                        .await?
                        .map(|r| r.get(0))
                        .unwrap_or(Value::Null)
                };
                cx.commit_bounded(scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Calendar source switches could not be saved"))?;
                Ok::<_, anyhow::Error>(shape(&stored))
            })
            .await
            .map_err(|_| anyhow::anyhow!("Calendar source switches deadline expired"))?
        })
    }
}
