//! Account-wide state is reached only through the host's public contracts.
use crate::repository::{Repository, Result};
use chrono::{DateTime, NaiveDate, Utc};
use moss_module_sdk::Host;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDay {
    pub timezone: String,
    pub date: NaiveDate,
    pub start: DateTime<Utc>,
    pub next_start: DateTime<Utc>,
}
impl<H: Host + ?Sized> Repository<'_, H> {
    pub fn local_day(&self, instant: DateTime<Utc>, offset: i32) -> Result<LocalDay> {
        let value = self.client.0.call(
            "context",
            "local-date",
            "account",
            json!({"instant":instant.to_rfc3339(),"offsetDays":offset}),
        )?;
        Ok(serde_json::from_value(value)?)
    }
    pub fn policy(&self, enabled: Option<bool>) -> Result<Value> {
        let (operation, parameters) = match enabled {
            Some(value) => (
                "route-write",
                json!({"tier":if value {"trusted_auto"} else {"ask_each_time"}}),
            ),
            None => ("route-read", json!({})),
        };
        let value = self
            .client
            .0
            .call("action-policy", operation, "task_changes", parameters)?;
        Ok(json!({"enabled":value["tier"] == "trusted_auto"}))
    }
}
