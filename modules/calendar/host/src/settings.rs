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
            let cx = DataContext::open_bounded(&self.database, scope.access(), scope.remaining())
                .await.map_err(|_| anyhow::anyhow!("Calendar settings unavailable"))?;
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
