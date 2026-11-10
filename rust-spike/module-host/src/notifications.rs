//! The extended host posts into the same recipient feed the server and desktop poll.
use crate::runtime::{CallScope, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::DataContext;
use serde_json::{json, Value};

pub(crate) async fn post(cx: &DataContext, scope: &CallScope, r: &Request) -> Result<Value> {
    ensure!(r.operation == "post", "Unknown notification operation");
    let text = r.parameters["text"]
        .as_str()
        .context("Notification text required")?;
    ensure!(
        !text.trim().is_empty() && text.len() <= 4096,
        "Invalid notification text"
    );
    let actor = scope.access().actor_user_id();
    let preference_key = format!("notifications:{}", scope.module().id);
    let preference = cx
        .db()
        .query_opt(
            "SELECT value_json FROM app.preferences WHERE owner_user_id=$1 AND key=$2",
            &[&actor, &preference_key],
        )
        .await?;
    if preference.is_some_and(|row| row.get::<_, Value>(0)["enabled"] == false) {
        return Ok(json!({"posted":false}));
    }
    let id = uuid::Uuid::new_v4();
    cx.db().execute(
        "INSERT INTO app.notifications(id,actor_user_id,recipient_user_id,title,module_id) VALUES($1,$2,$2,$3,$4)",
        &[&id, &actor, &text, &scope.module().id],
    ).await?;
    Ok(json!({"posted":true}))
}
