//! A scripted Connectors package for the installed-guest proofs: the api port
//! answers the public calendar surface with a stand-in provider that records
//! every write, so the database tests can prove what left the package. The
//! authorization check still runs, so only the declared api capability passes.
use moss_module_host::runtime::{authorize, CallScope, Ports, Request};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// The stand-in provider state: the events it holds and every call it saw.
#[derive(Default)]
pub struct StandIn {
    pub events: Mutex<std::collections::BTreeMap<String, Value>>,
    pub writes: Mutex<Vec<(&'static str, Value)>>,
    pub context_probes: std::sync::atomic::AtomicUsize,
}

/// One reserved addition's provider identity, matching the real Connectors
/// writer and the TypeScript apply.
fn apply_id(actor: &str, plan: &str, block: &str, revision: &Value, operation: &str) -> String {
    let canonical = format!(
        "{actor}|{plan}|{block}|{}|{operation}",
        revision.as_i64().unwrap_or_default()
    );
    let alphabet = b"0123456789abcdefghijklmnopqrstuv";
    let tail: String = Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|b| alphabet[(b & 0x1f) as usize] as char)
        .collect();
    format!("jap{tail}")
}

/// Wraps the real ports: the api port's Connectors calls are answered by the
/// stand-in, everything else reaches the host unchanged.
pub struct Guard {
    pub stand_in: Arc<StandIn>,
    pub next: Arc<dyn Ports>,
}

impl Ports for Guard {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        if port != "api" || request.resource != "connectors" {
            return self.next.invoke(scope, port, request);
        }
        authorize(scope.module(), port, request)?;
        let name = request.parameters["name"].as_str().unwrap_or_default().to_owned();
        let params = request.parameters["parameters"].clone();
        let actor = scope.access().actor_user_id().to_string();
        if name == "listCalendarContext" {
            self.stand_in.context_probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        let reply = match name.as_str() {
            "listCalendarContext" => json!({
                "items": [], "accounts": [{"source": "live"}], "gaps": [], "truncated": false,
                "asOf": "2026-11-10T08:00:00.000Z",
            }),
            "lookupCalendarEvent" => {
                let id = params["eventId"].as_str().unwrap_or_default();
                self.stand_in
                    .events
                    .lock()
                    .unwrap()
                    .get(id)
                    .map(|event| {
                        json!({"found": true, "id": id, "start": event["start"], "end": event["end"],
                            "provenance": event["provenance"], "attendeeCount": event["attendeeCount"]})
                    })
                    .unwrap_or(json!({"found": false}))
            }
            "createCalendarEvent" => {
                let provenance = &params["provenance"];
                let id = apply_id(
                    &actor,
                    provenance["jarvisPlanId"].as_str().unwrap_or_default(),
                    provenance["jarvisBlockId"].as_str().unwrap_or_default(),
                    &provenance["jarvisPlanRevision"],
                    provenance["jarvisOperationId"].as_str().unwrap_or_default(),
                );
                self.stand_in.writes.lock().unwrap().push(("create", params.clone()));
                self.stand_in.events.lock().unwrap().insert(
                    id.clone(),
                    json!({"start": params["windowStart"], "end": params["windowEnd"],
                        "provenance": {
                            "jarvisCreated": "true", "jarvisTool": "applyAddition",
                            "jarvisActorUserId": actor,
                            "jarvisPlanId": provenance["jarvisPlanId"],
                            "jarvisBlockId": provenance["jarvisBlockId"],
                            "jarvisPlanRevision": provenance["jarvisPlanRevision"].to_string().replace("\"", ""),
                            "jarvisOperationId": provenance["jarvisOperationId"],
                        },
                        "attendeeCount": 0}),
                );
                json!({"created": true, "resolvedStart": params["windowStart"],
                    "resolvedEnd": params["windowEnd"], "shifted": false, "conflict": "none",
                    "googleEventId": id, "calendarMirror": "written"})
            }
            "rescheduleCalendarEvent" => {
                let id = params["eventRef"].as_str().unwrap_or_default().to_owned();
                if let Some(event) = self.stand_in.events.lock().unwrap().get_mut(&id) {
                    event["start"] = params["newStart"].clone();
                    event["end"] = params["newEnd"].clone();
                }
                self.stand_in.writes.lock().unwrap().push(("reschedule", params.clone()));
                json!({"ok": true})
            }
            "deleteCalendarEvent" => {
                let id = params["eventId"].as_str().unwrap_or_default().to_owned();
                self.stand_in.events.lock().unwrap().remove(&id);
                self.stand_in.writes.lock().unwrap().push(("delete", params.clone()));
                json!({"deleted": true, "googleDeleted": true, "cacheMirror": "evicted"})
            }
            _ => anyhow::bail!("The stand-in does not serve {name}"),
        };
        Ok(reply)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.next.finish_call(scope, success)
    }
}
