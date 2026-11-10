//! Existing preference storage and Calendar's fixed writeback-policy key, in one transaction.
use super::{CalendarPorts, PREFERENCE_KEYS};
use anyhow::{ensure, Result};
use moss_module_host::runtime::CallScope;
use safety_core::db::DataContext;
use serde_json::{json, Map, Value};

impl CalendarPorts {
    pub(crate) fn save_settings(&self, scope: &CallScope, body: &Value) -> Result<Value> {
        let writes = moss_calendar::settings::patch(body)
            .map_err(|_| anyhow::anyhow!("Invalid calendar briefing settings"))?;
        let call = scope.call_id().to_string();
        ensure!(
            !self
                .settings_writes
                .lock()
                .map_err(|_| anyhow::anyhow!("Calendar settings busy"))?
                .contains_key(&call),
            "Only one settings patch per call"
        );
        let (cx, values) = self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
            let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                .await.map_err(|_| anyhow::anyhow!("Calendar settings unavailable"))?;
            let timeout = scope.remaining().as_millis().clamp(1, 30_000).to_string();
            cx.db().query_one("SELECT set_config('statement_timeout',$1,true)", &[&timeout]).await?;
            cx.db().execute("SELECT pg_advisory_xact_lock(hashtextextended(app.current_actor_user_id()::text || ':calendar.briefing-settings',0))", &[]).await?;
            for (key, value) in writes {
                cx.db().execute(
                    "INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) VALUES(app.current_actor_user_id(),$1,$2,now()) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json,revision=app.preferences.revision+1,updated_at=EXCLUDED.updated_at",
                    &[&key, &value],
                ).await?;
            }
            if let Some(mode) = body.get("timeBlockMode") {
                let tier = if mode == "auto" { "trusted_auto" } else { "ask_each_time" };
                cx.db().execute(
                    "INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) VALUES(app.current_actor_user_id(),'assistant.action_policy.v1.calendar.calendar_writeback',$1,now()) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at",
                    &[&json!(tier)],
                ).await?;
            }
            let keys: &[&str] = &PREFERENCE_KEYS;
            let rows = cx.db().query("SELECT key,value_json FROM app.preferences WHERE key=ANY($1)", &[&keys]).await?;
            let mut values = Map::new();
            for row in rows { values.insert(row.get(0), row.get(1)); }
            Ok::<_,anyhow::Error>((cx, Value::Object(values)))
            }).await.map_err(|_| anyhow::anyhow!("Calendar settings deadline expired"))?
        })?;
        // Do not hold the pending map while waiting on the account lock: another
        // request must be able to finish and release its transaction first.
        let mut pending = self
            .settings_writes
            .lock()
            .map_err(|_| anyhow::anyhow!("Calendar settings busy"))?;
        match pending.entry(call) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(cx);
            }
            std::collections::btree_map::Entry::Occupied(_) => {
                anyhow::bail!("Only one settings patch per call")
            }
        }
        Ok(values)
    }
}

/// Behaviors Calendar may toggle. The stored blob is shared with the existing app.
const BEHAVIOR_IDS: [&str; 3] = [
    "calendar.briefings",
    "calendar.planning",
    "calendar.writeback",
];
const BEHAVIOR_KEY: &str = "sourceBehaviors";

impl CalendarPorts {
    pub(crate) fn read_source_behaviors(&self, scope: &CallScope, parameters: &Value) -> Result<Value> {
        ensure!(
            parameters.as_object().is_some_and(|v| v.is_empty()),
            "Source behaviors take no parameters"
        );
        self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Source behaviors unavailable"))?;
                let row = cx
                    .db()
                    .query_opt("SELECT value_json FROM app.preferences WHERE key=$1", &[&BEHAVIOR_KEY])
                    .await?;
                cx.commit_bounded(scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Source behaviors unavailable"))?;
                Ok(row.map(|r| r.get::<_, Value>(0)).filter(Value::is_object).unwrap_or_else(|| json!({})))
            })
            .await
            .map_err(|_| anyhow::anyhow!("Source behaviors deadline expired"))?
        })
    }

    pub(crate) fn save_source_behavior(&self, scope: &CallScope, parameters: &Value) -> Result<Value> {
        let object = parameters.as_object().filter(|o| o.len() == 2);
        let id = object.and_then(|o| o.get("id")).and_then(Value::as_str);
        let enabled = object.and_then(|o| o.get("enabled")).and_then(Value::as_bool);
        let (Some(id), Some(enabled)) = (id, enabled) else {
            anyhow::bail!("Invalid source behavior write");
        };
        ensure!(BEHAVIOR_IDS.contains(&id), "Unknown source behavior");
        let call = scope.call_id().to_string();
        ensure!(
            !self
                .settings_writes
                .lock()
                .map_err(|_| anyhow::anyhow!("Calendar settings busy"))?
                .contains_key(&call),
            "Only one settings write per call"
        );
        let (cx, merged) = self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                    .await
                    .map_err(|_| anyhow::anyhow!("Source behaviors unavailable"))?;
                let timeout = scope.remaining().as_millis().clamp(1, 30_000).to_string();
                cx.db().query_one("SELECT set_config('statement_timeout',$1,true)", &[&timeout]).await?;
                cx.db().execute("SELECT pg_advisory_xact_lock(hashtextextended(app.current_actor_user_id()::text || ':sourceBehaviors',0))", &[]).await?;
                let row = cx
                    .db()
                    .query_opt("SELECT value_json FROM app.preferences WHERE key=$1", &[&BEHAVIOR_KEY])
                    .await?;
                let mut merged = row
                    .map(|r| r.get::<_, Value>(0))
                    .and_then(|v| v.as_object().cloned())
                    .unwrap_or_default();
                merged.insert(id.to_string(), Value::Bool(enabled));
                let merged = Value::Object(merged);
                cx.db().execute(
                    "INSERT INTO app.preferences(owner_user_id,key,value_json,updated_at) VALUES(app.current_actor_user_id(),$1,$2,now()) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json,revision=app.preferences.revision+1,updated_at=EXCLUDED.updated_at",
                    &[&BEHAVIOR_KEY, &merged],
                ).await?;
                Ok::<_, anyhow::Error>((cx, merged))
            })
            .await
            .map_err(|_| anyhow::anyhow!("Source behaviors deadline expired"))?
        })?;
        self.settings_writes
            .lock()
            .map_err(|_| anyhow::anyhow!("Calendar settings busy"))?
            .insert(call, cx);
        Ok(merged)
    }
}
