//! The extended host posts into the same recipient feed the server and desktop poll.
use crate::runtime::{CallScope, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::DataContext;
use serde_json::{json, Value};

/// A path on this app: leading slash, no way to change origin.
fn app_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.starts_with("/\\")
        && !value.contains([':', '\\'])
        && !value.chars().any(char::is_control)
        && value.len() <= 2048
}

fn optional<'a>(r: &'a Request, name: &str, limit: usize) -> Result<Option<&'a str>> {
    match &r.parameters[name] {
        Value::Null => Ok(None),
        Value::String(text) if !text.trim().is_empty() && text.len() <= limit => {
            Ok(Some(text.as_str()))
        }
        _ => anyhow::bail!("Invalid notification {name}"),
    }
}

/// `text` is the title. Optional `body`, `urgency` (urgent, normal or low), `eventKey` and
/// `href`. Posting the same `eventKey` again updates that notification in place and returns it
/// to unread. Non-urgent posts made inside quiet hours stay in the bell but wait to alert.
pub(crate) async fn post(cx: &DataContext, scope: &CallScope, r: &Request) -> Result<Value> {
    ensure!(r.operation == "post", "Unknown notification operation");
    let text = r.parameters["text"]
        .as_str()
        .context("Notification text required")?;
    ensure!(
        !text.trim().is_empty() && text.len() <= 4096,
        "Invalid notification text"
    );
    let body = optional(r, "body", 4096)?;
    let event_key = optional(r, "eventKey", 128)?;
    let href = optional(r, "href", 2048)?;
    ensure!(href.is_none_or(app_path), "href must be a path inside the app");
    let urgency = optional(r, "urgency", 16)?.unwrap_or("normal");
    ensure!(
        matches!(urgency, "urgent" | "normal" | "low"),
        "Invalid notification urgency"
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
    let quiet = match urgency {
        "urgent" => None,
        _ => crate::quiet_hours::window(cx, actor).await?,
    };
    let (zone, start, end) = match &quiet {
        Some(w) => (Some(w.zone.as_str()), Some(w.start.as_str()), Some(w.end.as_str())),
        None => (None, None, None),
    };
    let id = uuid::Uuid::new_v4();
    // The release time is the next quiet-hours end in the person's own zone, or null.
    let row = cx
        .db()
        .query_one(
            "WITH win AS (SELECT $8::text AS zone, $9::text::time AS s, $10::text::time AS e),
             here AS (SELECT date_trunc('minute', now() AT TIME ZONE zone) AS l, s, e FROM win WHERE zone IS NOT NULL),
             release AS (
               SELECT CASE WHEN CASE WHEN s >= e THEN l::time >= s OR l::time < e
                                     ELSE l::time >= s AND l::time < e END
                      THEN ((l::date + CASE WHEN e <= l::time THEN 1 ELSE 0 END) + e)
                           AT TIME ZONE (SELECT zone FROM win) END AS until
                 FROM here
             ),
             upserted AS (
               INSERT INTO app.notifications(id,actor_user_id,recipient_user_id,title,body,module_id,
                                             urgency,event_key,href,deferred_until)
               VALUES($1,$2,$2,$3,$4,$5,$6,$7,$11,(SELECT until FROM release))
               ON CONFLICT (recipient_user_id, module_id, event_key) WHERE event_key IS NOT NULL
               DO UPDATE SET title=excluded.title, body=excluded.body, urgency=excluded.urgency,
                             deferred_until=excluded.deferred_until, href=excluded.href,
                             updated_at=now()
               RETURNING id, (xmax = 0) AS inserted, deferred_until IS NOT NULL AS deferred
             ),
             cleared AS (
               DELETE FROM app.notification_reads WHERE notification_id IN (SELECT id FROM upserted)
             )
             SELECT id, inserted, deferred FROM upserted",
            &[
                &id, &actor, &text, &body, &scope.module().id, &urgency, &event_key, &zone, &start,
                &end, &href,
            ],
        )
        .await?;
    Ok(json!({
        "posted": true,
        "id": row.get::<_, uuid::Uuid>(0),
        "updated": !row.get::<_, bool>(1),
        "deferred": row.get::<_, bool>(2),
    }))
}

#[cfg(test)]
mod tests {
    use super::app_path;

    #[test]
    fn only_paths_inside_the_app_are_links() {
        for good in ["/tasks", "/tasks/12?tab=open", "/"] {
            assert!(app_path(good), "{good}");
        }
        for bad in ["tasks", "//evil.example", "/\\evil", "https://evil.example", "/a:b", "/a\nb", ""] {
            assert!(!app_path(bad), "{bad:?}");
        }
    }
}
