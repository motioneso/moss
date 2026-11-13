//! One briefing run. A scheduled fire carries no run id, so the id is minted here, when the job
//! fires. The whole run commits or rolls back together, so an overrun leaves no row and no
//! notification. Private text is never logged and never leaves in an error.
use crate::compose::{Composed, Composer, Subject};
use crate::definitions;
use crate::queue;
use crate::runs::TABLE;
use crate::schedule::{self, Scheduled};
use crate::sources;
use crate::util::{call, new_id, owner_zone, values};
use chrono::{DateTime, Utc};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};

/// A run that takes longer than this fails and rolls back.
pub const DEADLINE_MS: i64 = 6 * 60_000;
/// The only text recorded for an overrun. It names no prompt or briefing content.
pub const DEADLINE_LABEL: &str = "briefing_run_timeout";

pub const BLOCKED_TEXT: &str = "Briefing blocked because selected tools are not all declared read tools.";

/// How far back the same-day check looks.
const RECENT_RUNS: u32 = 20;

pub struct Fire {
    pub scheduled: bool,
    pub definition_id: String,
    /// Present for manual runs. A scheduled fire mints its own.
    pub run_id: Option<String>,
}

/// A started run's clock. Composition may call `check` between its own steps.
pub struct Deadline {
    started: DateTime<Utc>,
}

fn instant(text: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .map(|at| at.with_timezone(&Utc))
        .map_err(|_| Error::new("Invalid host clock"))
}

impl Deadline {
    pub fn start<H: Host + ?Sized>(host: &H) -> Result<Self> {
        Ok(Self { started: instant(&call(host)?.now)? })
    }
    /// Fails with the fixed label once the run has outlived its limit.
    pub fn check<H: Host + ?Sized>(&self, host: &H) -> Result<()> {
        let now = instant(&call(host)?.now)?;
        if (now - self.started).num_milliseconds() > DEADLINE_MS {
            return Err(Error::new(DEADLINE_LABEL));
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq)]
pub struct Outcome {
    /// created, blocked, duplicate (already ran today or already stored), skipped or gone.
    pub kind: &'static str,
    pub run_id: Option<String>,
    pub notified: bool,
}

impl Outcome {
    fn of(kind: &'static str, run_id: Option<String>) -> Self {
        Self { kind, run_id, notified: false }
    }
    pub fn to_json(&self) -> String {
        json!({"status":self.kind,"runId":self.run_id,"notified":self.notified}).to_string()
    }
}

fn local_day<H: Host + ?Sized>(host: &H, at: &str) -> Result<String> {
    let day = host.call("context", "local-date", "account", json!({"instant":at,"offsetDays":0}))?;
    day["date"].as_str().map(str::to_owned).ok_or_else(|| Error::new("Invalid local date"))
}

/// A scheduled run already stored for the owner's current local day.
fn todays_scheduled_run<H: Host + ?Sized>(host: &H, definition_id: &str, now: &str) -> Result<Option<String>> {
    let mut query = Query::select(Filter::eq("definition_id", definition_id));
    query.order = vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    query.limit = Some(RECENT_RUNS);
    let today = local_day(host, now)?;
    for row in Client(host).query(TABLE, &query)? {
        if row["run_kind"].as_str() != Some("scheduled") {
            continue;
        }
        let created = row["created_at"].as_str().unwrap_or_default();
        if local_day(host, created)? == today {
            return Ok(row["id"].as_str().map(str::to_owned));
        }
    }
    Ok(None)
}

fn run_exists<H: Host + ?Sized>(host: &H, run_id: &str) -> Result<bool> {
    let mut query = Query::select(Filter::eq("id", run_id));
    query.limit = Some(1);
    Ok(!Client(host).query(TABLE, &query)?.is_empty())
}

fn title(briefing_type: &str) -> &'static str {
    match briefing_type {
        "evening" => "Your evening review is ready",
        "weekly_review" => "Your weekly review is ready",
        _ => "Your morning briefing is ready",
    }
}

fn persist<H: Host + ?Sized>(
    host: &H,
    definition: &Value,
    run_id: &str,
    run_kind: &str,
    composed: &Composed,
    now: &str,
) -> Result<()> {
    let insert = Query::insert(values(vec![
        ("id", json!(run_id)),
        ("definition_id", definition["id"].clone()),
        ("status", json!(composed.status)),
        ("run_kind", json!(run_kind)),
        ("briefing_type", definition["briefing_type"].clone()),
        ("summary_text", json!(composed.summary_text)),
        ("source_metadata", composed.source_metadata.clone()),
        ("created_at", json!(now)),
    ]));
    Client(host).query(TABLE, &insert)?;
    let touch = Query::update(
        Filter::eq("id", definition["id"].as_str().unwrap_or_default()),
        values(vec![("last_run_at", json!(now)), ("updated_at", json!(now))]),
    );
    Client(host).query(definitions::TABLE, &touch)?;
    Ok(())
}

/// A scheduled fire registered in another zone than the owner's is registered again in the
/// owner's zone. It runs only when it lands close enough to the owner's target time.
fn aligned<H: Host + ?Sized>(host: &H, definition: &Value, now: DateTime<Utc>) -> bool {
    let Some(zone) = owner_zone(host, &now.to_rfc3339()) else { return true };
    let id = definition["id"].as_str().unwrap_or_default();
    let metadata = definition["schedule_metadata"].as_object().cloned().unwrap_or_default();
    let scheduled = Scheduled {
        id,
        briefing_type: definition["briefing_type"].as_str().unwrap_or("morning"),
        cadence: definition["cadence"].as_str().unwrap_or("manual"),
        enabled: definition["enabled"].as_bool().unwrap_or(false),
        metadata: &metadata,
    };
    let registered = queue::registered_zone(host, id).ok().flatten();
    let result = schedule::align_fire(&scheduled, registered.as_deref(), &zone, now);
    if result.realigned {
        schedule::reconcile_quietly(host, &scheduled, Some(&zone), false);
    }
    result.run
}

pub fn run<H: Host + ?Sized, C: Composer>(host: &H, composer: &C, fire: &Fire) -> Result<Outcome> {
    let deadline = Deadline::start(host)?;
    let context = call(host)?;
    let now = context.now.clone();
    // Only the owner's own definition runs. A shared definition never runs for the viewer.
    let Some(definition) = definitions::find(host, &fire.definition_id)? else {
        return Ok(Outcome::of("gone", None));
    };
    if definition["owner_user_id"].as_str() != Some(context.actor.as_str()) {
        return Ok(Outcome::of("gone", None));
    }
    if fire.scheduled {
        if !aligned(host, &definition, instant(&now)?) {
            return Ok(Outcome::of("skipped", None));
        }
        // The same local day never gets a second scheduled run, so no second notification.
        if let Some(existing) = todays_scheduled_run(host, &fire.definition_id, &now)? {
            return Ok(Outcome::of("duplicate", Some(existing)));
        }
    }
    // The id is minted when the job fires.
    let run_id = match &fire.run_id {
        Some(id) => id.clone(),
        None => new_id(host)?,
    };
    if run_exists(host, &run_id)? {
        return Ok(Outcome::of("duplicate", Some(run_id)));
    }
    let kind = if fire.scheduled { "scheduled" } else { "manual" };
    let tools: Vec<String> = definition["selected_tool_names"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|name| name.as_str().map(str::to_owned))
        .collect();
    if tools.iter().any(|name| !sources::allowed(name)) {
        let blocked = Composed {
            status: "blocked",
            summary_text: BLOCKED_TEXT.into(),
            source_metadata: json!({
                "degraded": false,
                "gaps": [],
                "blockedReason": "non_read_tool",
                "structuredPayload": {"version":1,"actionRows":[],"catchUp":null},
            }),
        };
        persist(host, &definition, &run_id, kind, &blocked, &now)?;
        return Ok(Outcome::of("blocked", Some(run_id)));
    }
    let briefing_type = definition["briefing_type"].as_str().unwrap_or("morning");
    let subject = Subject {
        definition_id: &fire.definition_id,
        briefing_type,
        selected_tools: &tools,
        deadline: &deadline,
    };
    let composed = composer.compose(host, &subject)?;
    // An overrun fails here, before anything is stored, so the run rolls back.
    deadline.check(host)?;
    persist(host, &definition, &run_id, kind, &composed, &now)?;
    let mut outcome = Outcome::of("created", Some(run_id.clone()));
    if fire.scheduled && composed.status == "succeeded" {
        // Metadata only. The same key never makes a second notification.
        host.call(
            "notify",
            "post",
            "briefings",
            json!({"text":title(briefing_type),"urgency":"normal","eventKey":format!("briefing-run-{run_id}")}),
        )?;
        outcome.notified = true;
    }
    Ok(outcome)
}

