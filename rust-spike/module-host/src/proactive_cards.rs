//! Proactive cards: the list and refresh routes, and the placement rules for a new card.
//!
//! Every query runs as the signed-in person through the row-level security policies on
//! `app.proactive_cards`. The pure rules live in the `usefulness-rules` crate.

use safety_core::db::DataContext;
use safety_core::error::ApiError;
use safety_core::payload::JobPayload;
use serde_json::{json, Value};
use usefulness_rules::proactive as rules;
use uuid::Uuid;

use crate::quiet_hours::{self, Resolved};

const PREFERENCE_KEY: &str = "proactive.monitoring.v1";
const SCAN_QUEUE: &str = "proactive-scan-source";

/// A card as the routes return it. Times are written the way the old server wrote them.
const CARD_COLUMNS: &str = "id, source, stable_key, title, summary, signal_type, priority_band,
    priority_reasons, status,
    to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS occurred_at,
    to_char(target_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS target_at,
    to_char(deferred_until AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS deferred_until,
    to_char(first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS first_seen_at,
    to_char(last_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS last_seen_at,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at";

fn card(row: &tokio_postgres::Row) -> Value {
    json!({
        "id": row.get::<_, Uuid>("id"),
        "source": row.get::<_, String>("source"),
        "stableKey": row.get::<_, String>("stable_key"),
        "title": row.get::<_, String>("title"),
        "summary": row.get::<_, String>("summary"),
        "signalType": row.get::<_, String>("signal_type"),
        "priorityBand": row.get::<_, String>("priority_band"),
        "priorityReasons": row.get::<_, Value>("priority_reasons"),
        "status": row.get::<_, String>("status"),
        "occurredAt": row.get::<_, Option<String>>("occurred_at"),
        "targetAt": row.get::<_, Option<String>>("target_at"),
        "deferredUntil": row.get::<_, Option<String>>("deferred_until"),
        "firstSeenAt": row.get::<_, String>("first_seen_at"),
        "lastSeenAt": row.get::<_, String>("last_seen_at"),
        "createdAt": row.get::<_, String>("created_at"),
    })
}

/// `GET /api/me/proactive-cards`. Cards held back by quiet hours or past expiry stay hidden.
pub async fn list(cx: &DataContext, limit: Option<&str>) -> Result<(u16, Value), ApiError> {
    let limit = rules::parse_limit(limit);
    let actor = cx.actor_user_id();
    let rows = cx
        .db()
        .query(
            &format!(
                "SELECT {CARD_COLUMNS} FROM app.proactive_cards
                 WHERE owner_user_id = $1 AND status = 'active'
                   AND (deferred_until IS NULL OR deferred_until <= now())
                   AND (expires_at IS NULL OR expires_at > now())
                 ORDER BY CASE priority_band WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                             WHEN 'normal' THEN 2 ELSE 3 END,
                          COALESCE(target_at, last_seen_at) ASC
                 LIMIT $2"
            ),
            &[&actor, &limit],
        )
        .await?;
    Ok((
        200,
        json!({ "cards": rows.iter().map(card).collect::<Vec<_>>() }),
    ))
}

async fn saved_preference(cx: &DataContext, actor: Uuid) -> Result<rules::Saved, ApiError> {
    let stored = cx
        .db()
        .query_opt(
            "SELECT value_json FROM app.preferences WHERE owner_user_id=$1 AND key=$2",
            &[&actor, &PREFERENCE_KEY],
        )
        .await?
        .map(|row| row.get::<_, Value>(0));
    Ok(rules::saved_from(stored.as_ref()))
}

/// `POST /api/me/proactive-cards/refresh`. `registered` names the sources whose scanners exist.
pub async fn refresh(cx: &DataContext, registered: &[String]) -> Result<(u16, Value), ApiError> {
    let actor = cx.actor_user_id();
    let saved = saved_preference(cx, actor).await?;
    let ages = cx
        .db()
        .query(
            "SELECT source, (EXTRACT(EPOCH FROM (now() - last_checked_at)) * 1000)::bigint
               FROM app.proactive_monitor_state
              WHERE owner_user_id = $1 AND last_checked_at IS NOT NULL",
            &[&actor],
        )
        .await?;
    let age = |source: &str| {
        ages.iter()
            .find(|r| r.get::<_, String>(0) == source)
            .map(|r| r.get::<_, i64>(1))
    };
    let now_ms = cx
        .db()
        .query_one("SELECT (EXTRACT(EPOCH FROM now()) * 1000)::bigint", &[])
        .await?
        .get::<_, i64>(0);
    let scans = rules::plan_refresh(&saved, registered, &age, now_ms, &actor.to_string());
    for scan in &scans {
        let payload = JobPayload::builder()
            .id("actorUserId", actor)
            .choice("source", scan.source)
            .choice("reason", "manual-refresh")
            .key_hash("idempotencyKey", &scan.idempotency_key)
            .build()
            .map_err(|e| ApiError::Internal(format!("{e:?}")))?;
        safety_core::queue::enqueue(cx, SCAN_QUEUE, &payload).await?;
    }
    Ok((202, json!({ "enqueued": scans.len() })))
}

/// A card a scanner wants on Today.
pub struct Candidate {
    pub source: String,
    pub stable_key: String,
    pub source_ref_hash: String,
    pub title: String,
    pub summary: String,
    pub signal_type: String,
    pub priority_band: String,
    pub priority_reasons: Value,
    pub target_at: Option<String>,
    pub expires_at: Option<String>,
}

/// What happened to a candidate.
#[derive(Debug, PartialEq)]
pub enum Placement {
    Placed { id: Uuid, deferred: bool },
    Refused(&'static str),
}

/// The quiet window for cards as (zone, start, end), or `None` when nothing is deferred.
fn quiet_window(saved: &quiet_hours::Saved, pref: &Value) -> Option<(String, String, String)> {
    match saved.resolve() {
        Resolved::Window(w) => Some((w.zone, w.start, w.end)),
        Resolved::Off => None,
        Resolved::Unresolved { zone } => {
            let quiet = &pref["quietHours"];
            if quiet["enabled"] != json!(true) {
                return None;
            }
            let valid = |t: &str| {
                let (h, m) = (t[..2].parse::<u8>().ok(), t[3..].parse::<u8>().ok());
                h.is_some_and(|h| h < 24) && m.is_some_and(|m| m < 60)
            };
            let (start, end) = (
                quiet["startLocalTime"].as_str()?,
                quiet["endLocalTime"].as_str()?,
            );
            // An impossible time such as 99:99 means no deferral, as on the old server.
            if !(valid(start) && valid(end)) {
                return None;
            }
            Some((zone, start.to_owned(), end.to_owned()))
        }
    }
}

/// Applies the anti-spam rules and the quiet window, then saves the card. `now` is an RFC 3339
/// instant, so tests can place a card at a chosen moment.
pub async fn place(cx: &DataContext, c: &Candidate, now: &str) -> Result<Placement, ApiError> {
    let actor = cx.actor_user_id();
    let pref_saved = saved_preference(cx, actor).await?;
    let pref = rules::effective(&pref_saved);
    let quiet = quiet_hours::saved(cx, actor)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let zone = quiet.owner_zone();
    let window = quiet_window(&quiet, &pref);

    let dismissed: bool = cx
        .db()
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM app.proactive_cards
                WHERE owner_user_id=$1 AND source=$2 AND stable_key=$3 AND status='dismissed'
                  AND dismissed_at >= $4::text::timestamptz - interval '30 days')",
            &[&actor, &c.source, &c.stable_key, &now],
        )
        .await?
        .get(0);
    let counts = cx
        .db()
        .query_one(
            "SELECT count(*), count(*) FILTER (WHERE source=$2),
                    count(*) FILTER (WHERE source=$2
                                       AND COALESCE(deferred_until, created_at) >= $3::text::timestamptz - interval '1 hour')
               FROM app.proactive_cards
              WHERE owner_user_id=$1
                AND COALESCE(deferred_until, created_at) >=
                    date_trunc('day', $3::text::timestamptz AT TIME ZONE $4) AT TIME ZONE $4",
            &[&actor, &c.source, &now, &zone],
        )
        .await?;
    let counts = rules::Counts {
        total_today: counts.get(0),
        source_today: counts.get(1),
        source_last_hour: counts.get(2),
    };
    if let Some(reason) = rules::placement_refusal(dismissed, &counts, &pref, &c.source) {
        return Ok(Placement::Refused(reason));
    }

    let (wz, ws, we) = match &window {
        Some((z, s, e)) => (Some(z.as_str()), Some(s.as_str()), Some(e.as_str())),
        None => (None, None, None),
    };
    // The release time is the next quiet-hours end in the person's own zone, or null.
    let row = cx
        .db()
        .query_one(
            "WITH win AS (SELECT $11::text AS zone, $12::text::time AS s, $13::text::time AS e),
             here AS (SELECT date_trunc('minute', $1::text::timestamptz AT TIME ZONE zone) AS l, s, e
                        FROM win WHERE zone IS NOT NULL),
             release AS (
               SELECT CASE WHEN s = e THEN 'infinity'::timestamptz
                      WHEN CASE WHEN s >= e THEN l::time >= s OR l::time < e
                                     ELSE l::time >= s AND l::time < e END
                      THEN ((l::date + CASE WHEN e <= l::time THEN 1 ELSE 0 END) + e)
                           AT TIME ZONE (SELECT zone FROM win) END AS until
                 FROM here)
             INSERT INTO app.proactive_cards (
               owner_user_id, source, stable_key, source_ref_hash, title, summary, signal_type,
               priority_band, priority_reasons, target_at, expires_at, deferred_until,
               first_seen_at, last_seen_at)
             VALUES ($2,$3,$4,$5,$6,$7,$8,$9,$10,$14::text::timestamptz,$15::text::timestamptz,
                     (SELECT until FROM release), $1::text::timestamptz, $1::text::timestamptz)
             ON CONFLICT (owner_user_id, source, stable_key)
               WHERE status NOT IN ('dismissed','expired','suppressed')
             DO UPDATE SET source_ref_hash=excluded.source_ref_hash, title=excluded.title,
               summary=excluded.summary, priority_band=excluded.priority_band,
               priority_reasons=excluded.priority_reasons, target_at=excluded.target_at,
               expires_at=excluded.expires_at, last_seen_at=excluded.last_seen_at, updated_at=now()
             RETURNING id, deferred_until IS NOT NULL AS deferred",
            &[
                &now,
                &actor,
                &c.source,
                &c.stable_key,
                &c.source_ref_hash,
                &c.title,
                &c.summary,
                &c.signal_type,
                &c.priority_band,
                &c.priority_reasons,
                &wz,
                &ws,
                &we,
                &c.target_at,
                &c.expires_at,
            ],
        )
        .await?;
    Ok(Placement::Placed {
        id: row.get(0),
        deferred: row.get(1),
    })
}
