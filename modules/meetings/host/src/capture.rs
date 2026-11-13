//! Mac recorder link: the narrow ports and the one store resource the guest uses.
//!
//! Route requests carry no headers, so the sign-in session, the paired device and the model
//! readiness are answered here. Device pairing is a separate part that is not built, so the
//! default refuses every device and every model check.
use crate::MeetingsPorts;
use anyhow::{ensure, Result};
use moss_module_host::runtime::{CallScope, Request};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

pub const CAPTURE: &str = "meetings.capture";

/// The signed-in browser session behind a call.
pub struct Browser {
    pub session_id: Uuid,
    pub expires_at: String,
}

/// The paired Mac behind a native request.
pub struct Native {
    pub device_id: String,
    pub device_name: String,
    pub capability_revision: i64,
    pub expires_at: String,
}

pub trait CaptureAuthority: Send + Sync {
    /// The live browser session for this request, or `None`.
    fn browser(&self, owner: Uuid, request_id: &str) -> Result<Option<Browser>>;
    /// The paired Mac that made this request, or `None`.
    fn native(&self, owner: Uuid, request_id: &str) -> Result<Option<Native>>;
    /// When the Mac's recording permission at `capability_revision` ends, or `None` when it is
    /// not allowed to record.
    fn recording(&self, owner: Uuid, device_id: &str, capability_revision: i64) -> Result<Option<String>>;
    /// The model route that can write this account's meeting text, or `None` when there is none.
    fn processing_route(&self, owner: Uuid) -> Result<Option<String>>;
}

/// Used until pairing exists. Nothing is allowed.
pub struct Refusing;
impl CaptureAuthority for Refusing {
    fn browser(&self, _: Uuid, _: &str) -> Result<Option<Browser>> {
        Ok(None)
    }
    fn native(&self, _: Uuid, _: &str) -> Result<Option<Native>> {
        Ok(None)
    }
    fn recording(&self, _: Uuid, _: &str, _: i64) -> Result<Option<String>> {
        Ok(None)
    }
    fn processing_route(&self, _: Uuid) -> Result<Option<String>> {
        Ok(None)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    kind: Option<String>,
    key: Option<String>,
    device_id: Option<String>,
    capability_revision: Option<i64>,
}

fn need(value: &Option<String>, what: &str) -> Result<String> {
    value.clone().ok_or_else(|| anyhow::anyhow!("{what} required"))
}

impl MeetingsPorts {
    pub(crate) fn capture(&self, scope: &CallScope, request: &Request) -> Result<Value> {
        let p: Params = serde_json::from_value(request.parameters.clone())?;
        let owner = scope.access().actor_user_id();
        match request.operation.as_str() {
            "lock" => {
                let kind = need(&p.kind, "Lock kind")?;
                let key = need(&p.key, "Lock key")?;
                ensure!(key.len() <= 80, "Lock key too long");
                let meeting = match kind.as_str() {
                    "request" => false,
                    "device" => false,
                    "limit" => false,
                    "meeting" => true,
                    _ => anyhow::bail!("Unsupported lock kind"),
                };
                if meeting {
                    let id = Uuid::parse_str(&key)?;
                    return self.run(scope, move |cx| {
                        Box::pin(async move {
                            let found = cx.db().query_opt("SELECT id FROM app.meeting_records WHERE id=$1 FOR UPDATE", &[&id]).await?;
                            Ok(json!({"found": found.is_some()}))
                        })
                    });
                }
                if kind == "limit" {
                    return self.run(scope, move |cx| {
                        Box::pin(async move {
                            cx.db().execute("SELECT pg_advisory_xact_lock(hashtextextended(app.current_actor_user_id()::text,2983))", &[]).await?;
                            Ok(json!({"locked": true}))
                        })
                    });
                }
                let prefix = if kind == "request" { "meeting-start:" } else { "meeting-device:" };
                let id = Uuid::parse_str(&key)?.to_string();
                self.run(scope, move |cx| {
                    Box::pin(async move {
                        cx.db()
                            .execute(
                                "SELECT pg_advisory_xact_lock(hashtextextended($1 || CASE WHEN $1 = 'meeting-start:' THEN app.current_actor_user_id()::text || ':' ELSE '' END || $2,0))",
                                &[&prefix, &id],
                            )
                            .await?;
                        Ok(json!({"locked": true}))
                    })
                })
            }
            "browser" => Ok(match self.capture_authority.browser(owner, scope.access().request_id())? {
                Some(b) => json!({"found": true, "sessionId": b.session_id, "expiresAt": b.expires_at}),
                None => json!({"found": false}),
            }),
            "native" => Ok(match self.capture_authority.native(owner, scope.access().request_id())? {
                Some(n) => json!({"found": true, "deviceId": n.device_id, "deviceName": n.device_name,
                    "capabilityRevision": n.capability_revision, "expiresAt": n.expires_at}),
                None => json!({"found": false}),
            }),
            "recording" => {
                let device = need(&p.device_id, "Device id")?;
                let revision = p.capability_revision.ok_or_else(|| anyhow::anyhow!("Capability revision required"))?;
                Ok(match self.capture_authority.recording(owner, &device, revision)? {
                    Some(expires) => json!({"found": true, "expiresAt": expires}),
                    None => json!({"found": false}),
                })
            }
            "processing" => Ok(match self.capture_authority.processing_route(owner)? {
                Some(route) => json!({"ready": true, "modelRoute": route}),
                None => json!({"ready": false}),
            }),
            _ => anyhow::bail!("Unsupported Meetings capture operation"),
        }
    }
}
