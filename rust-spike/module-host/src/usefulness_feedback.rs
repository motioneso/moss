//! Usefulness feedback: the create, signal, list, undo and edit-reason routes.
//!
//! Every query runs as the signed-in person through the row-level security policies on the
//! feedback tables. The pure rules (which pairs are allowed, how a story rule is built, how input
//! is cleaned) live in the `usefulness-rules` crate.
//!
//! Not built here: saving a feedback signal as a memory (`remember_this`), removing calendar
//! follow-through events, and verifying chat messages, which belong to modules
//! that are not ported yet. Those answer with the same refusals the old server gave when the
//! owning module was absent.
//!
//! Briefing runs and items are verified against the target rows a module writes through the
//! `feedback` port (`feedback_port.rs`); the route never creates those rows itself.

use safety_core::db::DataContext;
use safety_core::error::ApiError;
use serde_json::{json, Value};
use usefulness_rules::{feedback as rules, rule};
use uuid::Uuid;

/// A feedback row as the routes return it. Times are written the way the old server wrote them.
const COLUMNS: &str = "id, owner_user_id, target_kind, target_ref, surface, kind, source_kind,
    source_label, priority_band, effect_kind, effect_ref, metadata_json, status, reason_text,
    revision, rule_version, rule_json,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at,
    to_char(resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS resolved_at";

fn feedback(row: &tokio_postgres::Row) -> Value {
    json!({
        "id": row.get::<_, Uuid>("id"),
        "ownerUserId": row.get::<_, Uuid>("owner_user_id"),
        "targetKind": row.get::<_, String>("target_kind"),
        "targetRef": row.get::<_, String>("target_ref"),
        "surface": row.get::<_, String>("surface"),
        "kind": row.get::<_, String>("kind"),
        "sourceKind": row.get::<_, Option<String>>("source_kind"),
        "sourceLabel": row.get::<_, Option<String>>("source_label"),
        "priorityBand": row.get::<_, Option<String>>("priority_band"),
        "effectKind": row.get::<_, Option<String>>("effect_kind"),
        "effectRef": row.get::<_, Option<String>>("effect_ref"),
        "metadata": row.get::<_, Value>("metadata_json"),
        "status": row.get::<_, String>("status"),
        "reason": row.get::<_, Option<String>>("reason_text"),
        "revision": row.get::<_, i32>("revision"),
        "ruleVersion": row.get::<_, Option<i32>>("rule_version"),
        "createdAt": row.get::<_, String>("created_at"),
        "updatedAt": row.get::<_, String>("updated_at"),
        "resolvedAt": row.get::<_, Option<String>>("resolved_at"),
    })
}

fn reject(r: usefulness_rules::Reject) -> ApiError {
    ApiError::http(r.status, r.message)
}

fn not_found() -> ApiError {
    ApiError::http(404, "Feedback not found")
}

fn parse_id(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw)
        .map_err(|_| ApiError::framework(400, "params/id must match format \"uuid\""))
}

/// What a verified target contributes to the new row.
struct Verified {
    source_kind: Option<String>,
    source_label: Option<String>,
    priority_band: Option<String>,
    metadata: Value,
}

async fn find_target(
    cx: &DataContext,
    input: &rules::Create,
) -> Result<Option<Verified>, ApiError> {
    let actor = cx.actor_user_id();
    if input.target_kind == "proactive_card" {
        let Ok(card) = Uuid::parse_str(&input.target_ref) else {
            return Ok(None);
        };
        let row = cx
            .db()
            .query_opt(
                "SELECT source, priority_band FROM app.proactive_cards
                  WHERE owner_user_id = $1 AND id = $2",
                &[&actor, &card],
            )
            .await?;
        return Ok(row.map(|r| {
            let source: String = r.get(0);
            let label = match source.as_str() {
                "tasks" => "Tasks",
                "calendar" => "Calendar",
                "email" => "Email",
                "notes" => "Notes",
                other => other,
            }
            .to_owned();
            Verified {
                source_kind: Some(source),
                source_label: Some(label),
                priority_band: Some(r.get(1)),
                metadata: json!({}),
            }
        }));
    }
    if input.target_kind == "chat_message" {
        return Ok(None);
    }
    let row = cx
        .db()
        .query_opt(
            "SELECT source_kind, source_label, priority_band, metadata_json
               FROM app.usefulness_feedback_targets
              WHERE owner_user_id = $1 AND target_kind = $2 AND target_ref = $3 AND surface = $4",
            &[
                &actor,
                &input.target_kind,
                &input.target_ref,
                &input.surface,
            ],
        )
        .await?;
    Ok(row.map(|r| {
        let stored: Value = r.get(3);
        Verified {
            source_kind: r.get(0),
            source_label: r.get(1),
            priority_band: r.get(2),
            metadata: if rules::is_story_target(&input.target_kind) {
                rules::sanitize_story_metadata(&stored)
            } else {
                stored
            },
        }
    }))
}

async fn clear_answers(cx: &DataContext, id: Uuid) -> Result<(), ApiError> {
    cx.db()
        .execute(
            "DELETE FROM app.story_relevance_answer_cache WHERE owner_user_id = $1 AND rule_id = $2",
            &[&cx.actor_user_id(), &id],
        )
        .await?;
    Ok(())
}

fn story_rule(
    kind: &str,
    target_kind: &str,
    target_ref: &str,
    context: &Value,
    reason: Option<&str>,
) -> Option<Value> {
    let module = rules::story_module(target_kind)?;
    let direction = rules::direction_for_kind(kind)?;
    Some(rule::compile(
        module, direction, target_ref, context, reason,
    ))
}

/// `POST /api/me/usefulness-feedback`.
pub async fn create(cx: &DataContext, body: &Value) -> Result<(u16, Value), ApiError> {
    let input = rules::parse_create(body).map_err(reject)?;
    if !rules::pair_allowed(&input.target_kind, &input.surface, &input.kind) {
        return Err(ApiError::http(
            400,
            "Feedback target/action pair is invalid",
        ));
    }
    let actor = cx.actor_user_id();
    let story = rules::is_story_target(&input.target_kind);

    // Only rows the caller already owns are visible here, so an early answer discloses nothing
    // about anyone else.
    let existing = if story {
        cx.db()
            .query_opt(
                &format!(
                    "SELECT {COLUMNS} FROM app.usefulness_feedback_signals
                      WHERE owner_user_id=$1 AND target_kind=$2 AND target_ref=$3 AND status='active'"
                ),
                &[&actor, &input.target_kind, &input.target_ref],
            )
            .await?
    } else {
        cx.db()
            .query_opt(
                &format!(
                    "SELECT {COLUMNS} FROM app.usefulness_feedback_signals
                      WHERE owner_user_id=$1 AND target_kind=$2 AND target_ref=$3 AND kind=$4
                        AND status='active'"
                ),
                &[&actor, &input.target_kind, &input.target_ref, &input.kind],
            )
            .await?
    };
    if let Some(row) = &existing {
        if row.get::<_, String>("kind") == input.kind {
            return Ok((200, json!({ "feedback": feedback(row) })));
        }
    }

    let verified = find_target(cx, &input)
        .await?
        .ok_or_else(|| ApiError::http(404, "Feedback target not found"))?;
    if input.kind == "remember_this" {
        return Err(ApiError::http(400, "Feedback target cannot be remembered"));
    }
    let (mut effect_kind, mut effect_ref): (Option<&str>, Option<String>) = (None, None);
    if input.kind == "dismiss" && input.target_kind == "proactive_card" {
        if let Ok(card) = Uuid::parse_str(&input.target_ref) {
            let changed = cx
                .db()
                .execute(
                    "UPDATE app.proactive_cards SET status='dismissed', dismissed_at=now(),
                            updated_at=now()
                      WHERE owner_user_id=$1 AND id=$2 AND status='active'",
                    &[&actor, &card],
                )
                .await?;
            // Only a dismissal that hid a card is undone by restoring it.
            if changed > 0 {
                effect_kind = Some("proactive_card_dismissed");
                effect_ref = Some(input.target_ref.clone());
            }
        }
    }
    // The opposite direction is retired, not deleted, so history stays readable.
    if let Some(row) = &existing {
        let id: Uuid = row.get("id");
        let retired = cx
            .db()
            .execute(
                "UPDATE app.usefulness_feedback_signals
                    SET status='superseded', resolved_at=now(), updated_at=now()
                  WHERE owner_user_id=$1 AND id=$2 AND status='active'",
                &[&actor, &id],
            )
            .await?;
        if retired > 0 {
            clear_answers(cx, id).await?;
        }
    }
    let metadata = rules::sanitize_metadata(&verified.metadata);
    let compiled = story_rule(
        &input.kind,
        &input.target_kind,
        &input.target_ref,
        &metadata,
        input.reason.as_deref(),
    );
    let rule_json = compiled.clone().unwrap_or_else(|| json!({}));
    let rule_version: Option<i32> = compiled.as_ref().map(|_| rule::RULE_VERSION as i32);
    let row = cx
        .db()
        .query_one(
            &format!(
                "INSERT INTO app.usefulness_feedback_signals (
                   owner_user_id, target_kind, target_ref, surface, kind, source_kind, source_label,
                   priority_band, effect_kind, effect_ref, metadata_json, reason_text, rule_json,
                   rule_version)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 RETURNING {COLUMNS}"
            ),
            &[
                &actor,
                &input.target_kind,
                &input.target_ref,
                &input.surface,
                &input.kind,
                &verified.source_kind,
                &verified.source_label,
                &verified.priority_band,
                &effect_kind,
                &effect_ref,
                &metadata,
                &input.reason,
                &rule_json,
                &rule_version,
            ],
        )
        .await?;
    Ok((201, json!({ "feedback": feedback(&row) })))
}

/// `POST /api/me/usefulness-feedback/signals`. Records a signal and changes nothing else.
pub async fn signal(cx: &DataContext, body: &Value) -> Result<(u16, Value), ApiError> {
    let input = rules::parse_signal(body).map_err(reject)?;
    let actor = cx.actor_user_id();
    let existing = cx
        .db()
        .query_opt(
            &format!(
                "SELECT {COLUMNS} FROM app.usefulness_feedback_signals
                  WHERE owner_user_id=$1 AND target_kind=$2 AND target_ref=$3 AND kind=$4
                    AND status='active'"
            ),
            &[&actor, &input.target_kind, &input.target_ref, &input.kind],
        )
        .await?;
    if let Some(row) = existing {
        return Ok((200, json!({ "feedback": feedback(&row) })));
    }
    let verified = find_target(cx, &input)
        .await?
        .ok_or_else(|| ApiError::http(404, "Feedback target not found"))?;
    let metadata = rules::sanitize_metadata(&verified.metadata);
    let row = cx
        .db()
        .query_one(
            &format!(
                "INSERT INTO app.usefulness_feedback_signals (
                   owner_user_id, target_kind, target_ref, surface, kind, source_kind, source_label,
                   priority_band, metadata_json)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 RETURNING {COLUMNS}"
            ),
            &[
                &actor,
                &input.target_kind,
                &input.target_ref,
                &input.surface,
                &input.kind,
                &verified.source_kind,
                &verified.source_label,
                &verified.priority_band,
                &metadata,
            ],
        )
        .await?;
    Ok((201, json!({ "feedback": feedback(&row) })))
}

/// `GET /api/me/usefulness-feedback`.
pub async fn list(cx: &DataContext, query: &[(String, String)]) -> Result<(u16, Value), ApiError> {
    let filter = rules::parse_list_query(query).map_err(reject)?;
    let actor = cx.actor_user_id();
    let rows = cx
        .db()
        .query(
            &format!(
                "SELECT {COLUMNS} FROM app.usefulness_feedback_signals
                  WHERE owner_user_id=$1
                    AND ($2::text[] IS NULL OR target_kind = ANY($2))
                    AND ($3::text IS NULL OR status = $3)
                  ORDER BY created_at DESC, id LIMIT 100"
            ),
            &[
                &actor,
                &filter.target_kind.as_ref().map(|k| vec![k.clone()]),
                &filter.status,
            ],
        )
        .await?;
    Ok((
        200,
        json!({ "feedback": rows.iter().map(feedback).collect::<Vec<_>>() }),
    ))
}

/// `POST /api/me/usefulness-feedback/:id/undo`. Taking back a dismissal also brings the card back.
pub async fn undo(cx: &DataContext, id: &str) -> Result<(u16, Value), ApiError> {
    let id = parse_id(id)?;
    let actor = cx.actor_user_id();
    let existing = cx
        .db()
        .query_opt(
            &format!(
                "SELECT {COLUMNS} FROM app.usefulness_feedback_signals
                  WHERE owner_user_id=$1 AND id=$2"
            ),
            &[&actor, &id],
        )
        .await?
        .ok_or_else(not_found)?;
    if existing.get::<_, String>("status") != "active" {
        return Ok((200, json!({ "feedback": feedback(&existing) })));
    }
    if existing.get::<_, Option<String>>("effect_kind").as_deref()
        == Some("proactive_card_dismissed")
    {
        if let Some(card) = existing
            .get::<_, Option<String>>("effect_ref")
            .and_then(|r| Uuid::parse_str(r.as_str()).ok())
        {
            cx.db()
                .execute(
                    "UPDATE app.proactive_cards SET status='active', dismissed_at=NULL,
                            updated_at=now()
                      WHERE owner_user_id=$1 AND id=$2 AND status='dismissed'
                        AND (expires_at IS NULL OR expires_at > now())",
                    &[&actor, &card],
                )
                .await?;
        }
    }
    let row = cx
        .db()
        .query_opt(
            &format!(
                "UPDATE app.usefulness_feedback_signals
                    SET status='undone', resolved_at=now(), updated_at=now()
                  WHERE owner_user_id=$1 AND id=$2 RETURNING {COLUMNS}"
            ),
            &[&actor, &id],
        )
        .await?
        .ok_or_else(not_found)?;
    clear_answers(cx, id).await?;
    Ok((200, json!({ "feedback": feedback(&row) })))
}

/// `PATCH /api/me/usefulness-feedback/:id`. Only a "Less like this" reason can be edited.
pub async fn update_reason(
    cx: &DataContext,
    id: &str,
    body: &Value,
) -> Result<(u16, Value), ApiError> {
    let id = parse_id(id)?;
    let reason = rules::parse_reason_body(body).map_err(reject)?;
    let actor = cx.actor_user_id();
    let owned = cx
        .db()
        .query_opt(
            &format!(
                "SELECT {COLUMNS} FROM app.usefulness_feedback_signals
                  WHERE owner_user_id=$1 AND id=$2"
            ),
            &[&actor, &id],
        )
        .await?
        .filter(|r| r.get::<_, String>("status") == "active")
        .ok_or_else(not_found)?;
    let kind: String = owned.get("kind");
    if kind != "less_like_this" {
        return Err(ApiError::http(
            400,
            "Only a Less like this reason can be edited",
        ));
    }
    // The rule is rebuilt from the row's own stored context and written in the same statement.
    let compiled = story_rule(
        &kind,
        &owned.get::<_, String>("target_kind"),
        &owned.get::<_, String>("target_ref"),
        &owned.get::<_, Value>("metadata_json"),
        Some(&reason),
    );
    let rule_json = compiled.clone().unwrap_or_else(|| json!({}));
    let rule_version: Option<i32> = compiled.as_ref().map(|_| rule::RULE_VERSION as i32);
    let row = cx
        .db()
        .query_opt(
            &format!(
                "UPDATE app.usefulness_feedback_signals
                    SET reason_text=$3, rule_json=$4, rule_version=$5, revision=revision+1,
                        updated_at=now()
                  WHERE owner_user_id=$1 AND id=$2 AND status='active' AND kind='less_like_this'
                  RETURNING {COLUMNS}"
            ),
            &[&actor, &id, &reason, &rule_json, &rule_version],
        )
        .await?
        .ok_or_else(not_found)?;
    clear_answers(cx, id).await?;
    Ok((200, json!({ "feedback": feedback(&row) })))
}
