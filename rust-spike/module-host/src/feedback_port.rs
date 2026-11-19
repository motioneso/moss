//! The `feedback` port. A module records, undoes and lists usefulness ratings for its own
//! target kinds. The host decides who the rating belongs to and which target kinds a module may
//! touch, so a module can neither rate as another person nor rate another module's targets.
//!
//! The owner always comes from the call's access context. No request field can name a user,
//! and the database applies the same owner through row-level security.
use crate::{
    runtime::{CallScope, Request},
    usefulness_feedback,
};
use access_context::AccessContext;
use anyhow::{bail, ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use tokio::runtime::Runtime;
use usefulness_rules::feedback as rules;

/// Target kinds a module may declare. Cards and chat messages stay host-owned.
pub const MODULE_TARGET_KINDS: &[&str] = &["briefing_run", "briefing_item", "news_story", "sports_story"];

const RECORD_KEYS: &[&str] = &[
    "targetRef",
    "surface",
    "kind",
    "sourceKind",
    "sourceLabel",
    "metadata",
];
const METADATA_SUFFIXES: &[&str] = &["Id", "Ref", "Label", "Kind", "Type", "Band"];
const METADATA_VALUE_MAX: usize = 80;

/// The store behind the port. Every method runs as the given account.
pub trait Feedback: Send + Sync {
    /// Writes the target row and the rating in one transaction. Returns the rating id.
    fn record(&self, access: &AccessContext, target_kind: &str, input: &Record) -> Result<String>;
    /// Takes back one of the account's own ratings on the named target kind.
    fn undo(&self, access: &AccessContext, target_kind: &str, id: &str) -> Result<()>;
    /// The target refs the account has an active rating on.
    fn active(
        &self,
        access: &AccessContext,
        target_kind: &str,
        surface: &str,
        kind: &str,
    ) -> Result<Vec<String>>;
}

pub struct Record {
    pub target_ref: String,
    pub surface: String,
    pub kind: String,
    pub source_kind: Option<String>,
    pub source_label: Option<String>,
    pub metadata: Value,
}

/// Refuses every call. The default until the shell supplies a store.
pub struct NoFeedback;
impl Feedback for NoFeedback {
    fn record(&self, _: &AccessContext, _: &str, _: &Record) -> Result<String> {
        bail!("Feedback is not available on this install")
    }
    fn undo(&self, _: &AccessContext, _: &str, _: &str) -> Result<()> {
        bail!("Feedback is not available on this install")
    }
    fn active(&self, _: &AccessContext, _: &str, _: &str, _: &str) -> Result<Vec<String>> {
        bail!("Feedback is not available on this install")
    }
}

fn text(parameters: &Value, key: &str) -> Result<String> {
    parameters[key]
        .as_str()
        .map(str::to_owned)
        .with_context(|| format!("{key} is required"))
}

fn only_keys(parameters: &Value, allowed: &[&str]) -> Result<()> {
    let fields = parameters
        .as_object()
        .context("Feedback parameters must be an object")?;
    ensure!(
        fields.keys().all(|key| allowed.contains(&key.as_str())),
        "Feedback accepts only its documented fields"
    );
    Ok(())
}

/// Keeps ids and short labels. Item text, long values and nested data never reach the row.
fn clean_metadata(raw: &Value) -> Value {
    let mut out = Map::new();
    for (key, value) in raw.as_object().into_iter().flatten() {
        let named = key.len() <= 40
            && (matches!(key.as_str(), "id" | "ref" | "label" | "kind")
                || METADATA_SUFFIXES.iter().any(|s| key.ends_with(s)));
        let value_ok = match value {
            Value::String(s) => s.chars().count() <= METADATA_VALUE_MAX && !s.contains('\n'),
            Value::Bool(_) | Value::Number(_) => true,
            _ => false,
        };
        if named && value_ok {
            out.insert(key.clone(), value.clone());
        }
    }
    rules::sanitize_metadata(&Value::Object(out))
}

/// Routes one port request to the store as the caller.
pub fn invoke(store: &dyn Feedback, scope: &CallScope, r: &Request) -> Result<Value> {
    let access = scope.access();
    // The resource is the target kind. `authorize` already checked the manifest lists it.
    let kind = r.resource.as_str();
    ensure!(
        MODULE_TARGET_KINDS.contains(&kind),
        "A module cannot rate this kind of target"
    );
    match r.operation.as_str() {
        "record" => {
            only_keys(&r.parameters, RECORD_KEYS)?;
            let record = Record {
                target_ref: text(&r.parameters, "targetRef")?,
                surface: text(&r.parameters, "surface")?,
                kind: text(&r.parameters, "kind")?,
                source_kind: r.parameters["sourceKind"].as_str().map(str::to_owned),
                source_label: r.parameters["sourceLabel"].as_str().map(str::to_owned),
                metadata: clean_metadata(&r.parameters["metadata"]),
            };
            Ok(json!({"id": store.record(access, kind, &record)?}))
        }
        "undo" => {
            only_keys(&r.parameters, &["id"])?;
            store.undo(access, kind, &text(&r.parameters, "id")?)?;
            Ok(json!({"undone": true}))
        }
        "active" => {
            only_keys(&r.parameters, &["surface", "kind"])?;
            let refs = store.active(
                access,
                kind,
                &text(&r.parameters, "surface")?,
                &text(&r.parameters, "kind")?,
            )?;
            Ok(json!({"refs": refs}))
        }
        _ => bail!("Unknown feedback operation"),
    }
}

/// The store over the shared feedback tables. Each call opens its own transaction as the caller.
pub struct PostgresFeedback {
    database: Database,
    runtime: Runtime,
}

impl PostgresFeedback {
    pub fn new(database: Database) -> Result<Self> {
        Ok(Self {
            database,
            runtime: Runtime::new()?,
        })
    }

    fn open(&self, access: &AccessContext) -> Result<DataContext> {
        self.runtime
            .block_on(DataContext::open(&self.database, access))
            .map_err(|_| anyhow::anyhow!("Could not open the feedback data context"))
    }
}

fn refused(error: safety_core::error::ApiError) -> anyhow::Error {
    let (_, body) = error.status_and_body();
    anyhow::anyhow!(
        "{}",
        body["message"].as_str().unwrap_or("Feedback was refused")
    )
}

impl Feedback for PostgresFeedback {
    fn record(&self, access: &AccessContext, target_kind: &str, input: &Record) -> Result<String> {
        let cx = self.open(access)?;
        self.runtime.block_on(async {
            let source_kind = input.source_kind.as_deref().filter(|s| s.len() <= 40);
            let source_label = input
                .source_label
                .as_deref()
                .map(|s| s.chars().take(80).collect::<String>());
            cx.db()
                .execute(
                    "INSERT INTO app.usefulness_feedback_targets
                       (owner_user_id, target_kind, target_ref, surface, source_kind, source_label,
                        metadata_json)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (owner_user_id, target_kind, target_ref, surface)
                     DO UPDATE SET source_kind = EXCLUDED.source_kind,
                                   source_label = EXCLUDED.source_label,
                                   metadata_json = EXCLUDED.metadata_json,
                                   last_seen_at = now()",
                    &[
                        &cx.actor_user_id(),
                        &target_kind,
                        &input.target_ref,
                        &input.surface,
                        &source_kind,
                        &source_label,
                        &input.metadata,
                    ],
                )
                .await
                .map_err(|_| anyhow::anyhow!("Feedback target was refused"))?;
            let body = json!({
                "targetKind": target_kind,
                "targetRef": input.target_ref,
                "surface": input.surface,
                "kind": input.kind,
            });
            let (_, reply) = usefulness_feedback::create(&cx, &body)
                .await
                .map_err(refused)?;
            let id = reply["feedback"]["id"]
                .as_str()
                .context("The rating has no id")?
                .to_owned();
            cx.commit().await.map_err(refused)?;
            Ok(id)
        })
    }

    fn undo(&self, access: &AccessContext, target_kind: &str, id: &str) -> Result<()> {
        let cx = self.open(access)?;
        self.runtime.block_on(async {
            let id = uuid::Uuid::parse_str(id).context("The rating id is not valid")?;
            let row = cx
                .db()
                .query_opt(
                    "SELECT target_kind FROM app.usefulness_feedback_signals
                      WHERE owner_user_id = $1 AND id = $2",
                    &[&cx.actor_user_id(), &id],
                )
                .await
                .map_err(|_| anyhow::anyhow!("Could not read the rating"))?
                .context("Feedback not found")?;
            ensure!(
                row.get::<_, String>(0) == target_kind,
                "This rating is for another kind of target"
            );
            usefulness_feedback::undo(&cx, &id.to_string())
                .await
                .map_err(refused)?;
            cx.commit().await.map_err(refused)?;
            Ok(())
        })
    }

    fn active(
        &self,
        access: &AccessContext,
        target_kind: &str,
        surface: &str,
        kind: &str,
    ) -> Result<Vec<String>> {
        let cx = self.open(access)?;
        self.runtime.block_on(async {
            let rows = cx
                .db()
                .query(
                    "SELECT target_ref FROM app.usefulness_feedback_signals
                      WHERE owner_user_id = $1 AND target_kind = $2 AND surface = $3
                        AND kind = $4 AND status = 'active'
                      ORDER BY created_at DESC LIMIT 1000",
                    &[&cx.actor_user_id(), &target_kind, &surface, &kind],
                )
                .await
                .map_err(|_| anyhow::anyhow!("Could not read ratings"))?;
            Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
        })
    }
}

/// Wraps a store for `Services::with_feedback`.
pub fn shared(store: impl Feedback + 'static) -> Arc<dyn Feedback> {
    Arc::new(store)
}
