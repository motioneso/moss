//! Writes use Calendar's public day-plan routes, never task creation or module internals.
use crate::{
    review_model as model,
    today::{get, request, Snapshot},
};
use leptos::{prelude::*, task::spawn_local};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct State {
    pub snapshot: Snapshot,
    pub choices: model::Choices,
    pub invalid: std::collections::BTreeSet<String>,
    pub preview: Value,
    pub approval: Value,
    pub report: Value,
    pub notice: Option<String>,
    pub busy: bool,
}
impl State {
    pub fn display_snapshot(&self) -> Snapshot {
        let mut snapshot = self.snapshot.clone();
        if let Some(saved) = snapshot.saved.as_mut() {
            if let Some(blocks) = saved["plan"]["blocks"].as_array_mut() {
                for block in blocks {
                    block["pendingChange"] = model::pending(block, &self.choices);
                }
            }
        }
        snapshot
    }
    pub fn plan(&self) -> &Value {
        self.snapshot
            .saved
            .as_ref()
            .map(|s| &s["plan"])
            .unwrap_or(&Value::Null)
    }
}
#[derive(Clone, Copy)]
pub struct Controller {
    pub state: RwSignal<State>,
    parent: RwSignal<Option<Snapshot>>,
}
#[derive(Clone, Copy)]
pub enum Action {
    Save,
    Accept,
    Confirm,
    Retry,
}
impl Controller {
    pub fn new(snapshot: Snapshot, parent: RwSignal<Option<Snapshot>>) -> Self {
        Self {
            parent,
            state: RwSignal::new(State {
                snapshot,
                choices: Default::default(),
                invalid: Default::default(),
                preview: Value::Null,
                approval: Value::Null,
                report: Value::Null,
                notice: None,
                busy: false,
            }),
        }
    }
    pub fn edit(self, id: String, placement: String, starts_at: Option<String>) {
        self.state.update(|s| {
            s.invalid.remove(&id);
            s.choices.insert(
                id,
                model::Choice {
                    placement,
                    starts_at,
                },
            );
            s.preview = Value::Null;
            s.approval = Value::Null;
            s.notice = None;
        });
    }
    pub fn run(self, action: Action) {
        if self.state.get_untracked().busy || !self.state.get_untracked().invalid.is_empty() {
            return;
        }
        self.state.update(|s| {
            s.busy = true;
            s.notice = None;
        });
        spawn_local(async move {
            let result = self.execute(action).await;
            if let Err(status) = result {
                self.state.update(|s| {
                    s.approval = Value::Null;
                    s.preview = Value::Null;
                    s.notice = Some(
                        if status == 409 {
                            "The saved plan changed. Choices kept; review and save again."
                        } else {
                            "Calendar changes couldn't finish. Your choices are kept. Try again."
                        }
                        .into(),
                    );
                });
            }
            // Always refresh after an attempt: a partially completed operation may have written events.
            let refreshed = self.reload().await;
            if !refreshed && result.is_ok() {
                self.state.update(|s|s.notice=Some("Changes saved, but the latest schedule couldn't load. Reopen the review to refresh.".into()));
            }
            self.state.update(|s| s.busy = false);
        });
    }
    async fn reload(self) -> bool {
        let snap = self.state.get_untracked().snapshot;
        let saved = get(&format!(
            "/day-plan?date={}&timeZone={}",
            snap.day(),
            snap.zone()
        ))
        .await;
        let events = get("/events").await;
        let ok = saved.is_ok() && events.is_ok();
        self.state.update(|s| {
            if let Ok(saved) = saved {
                s.snapshot.saved = Some(saved);
            }
            if let Ok(events) = events {
                s.snapshot.events = Some(events);
            }
        });
        self.parent.set(Some(self.state.get_untracked().snapshot));
        ok
    }
    fn record(self, report: Value) {
        self.state.update(|s| {
            for item in report["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|i| i["outcome"] == "applied")
            {
                if let Some(id) = item["blockId"].as_str() {
                    s.choices.remove(id);
                }
            }
            s.approval = Value::Null;
            s.report = report;
        });
    }
    async fn execute(self, action: Action) -> Result<(), u16> {
        let state = self.state.get_untracked();
        let id = state.plan()["id"].as_str().ok_or(404u16)?.to_owned();
        if matches!(action, Action::Confirm | Action::Retry) {
            let (op, suffix, body) = if matches!(action, Action::Confirm) {
                (
                    &state.approval["operationId"],
                    "confirm",
                    json!({"approvalId":state.approval["approvalId"]}),
                )
            } else {
                (
                    &state.report["operationId"],
                    "retry",
                    json!({"itemIds":model::retry_ids(&state.report)}),
                )
            };
            let op = op.as_str().ok_or(404u16)?;
            let report = request(
                "POST",
                &format!("/day-plans/{id}/operations/{op}/{suffix}"),
                body,
            )
            .await?;
            self.record(report);
            return Ok(());
        }
        let all = matches!(action, Action::Accept);
        let selected = model::selection(state.plan(), &state.choices, all);
        let mut plan = state.plan().clone();
        if !state.choices.is_empty() {
            let saved = request(
                "PATCH",
                &format!("/day-plans/{id}/draft"),
                model::draft(&plan, &state.choices),
            )
            .await?;
            plan = saved["plan"].clone();
            self.state.update(|s| {
                if let Some(saved) = s.snapshot.saved.as_mut() {
                    saved["plan"] = plan.clone();
                }
            });
        }
        if selected.is_empty() {
            self.state.update(|s| {
                s.choices.clear();
                s.notice = Some("Changes saved.".into());
            });
            return Ok(());
        }
        let preview = request(
            "POST",
            &format!("/day-plans/{id}/preview"),
            json!({"expectedRevision":plan["revision"],"selectedChangeBlockIds":selected}),
        )
        .await?;
        let available = preview["calendarAvailability"] != "unavailable";
        let eligible = if available {
            model::eligible(&preview, &selected)
        } else {
            vec![]
        };
        self.state.update(|s| s.preview = preview);
        if eligible.is_empty() {
            self.state.update(|s| {
                s.notice =
                    Some("No selected changes can be applied. Check the details below.".into())
            });
            return Ok(());
        }
        let report=request("POST",&format!("/day-plans/{id}/apply"),json!({"expectedRevision":plan["revision"],"idempotencyKey":model::key(&plan,&eligible),"selectedBlockIds":eligible})).await?;
        if report["status"] == "confirmation-required" {
            self.state.update(|s| {
                if all {
                    s.notice = Some(
                        "These changes need review. Use Save changes to review and confirm them."
                            .into(),
                    );
                } else {
                    s.approval = report;
                }
            });
        } else {
            self.record(report);
        }
        Ok(())
    }
}
