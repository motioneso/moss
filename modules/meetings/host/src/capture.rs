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

/// A paired Mac and what it may record.
pub struct Device {
    pub recording_allowed: bool,
    pub expires_at: String,
}

pub trait CaptureAuthority: Send + Sync {
    /// The live browser session for this request, or `None`.
    fn browser(&self, owner: Uuid, request_id: &str) -> Result<Option<Browser>>;
    /// The paired device record for `device_id`, or `None` when it is not paired to `owner`.
    fn device(&self, owner: Uuid, device_id: &str) -> Result<Option<Device>>;
    /// Whether the account has a model that can write meeting text.
    fn processing_ready(&self, owner: Uuid) -> Result<bool>;
}

/// Used until pairing exists. Nothing is allowed.
pub struct Refusing;
impl CaptureAuthority for Refusing {
    fn browser(&self, _: Uuid, _: &str) -> Result<Option<Browser>> {
        Ok(None)
    }
    fn device(&self, _: Uuid, _: &str) -> Result<Option<Device>> {
        Ok(None)
    }
    fn processing_ready(&self, _: Uuid) -> Result<bool> {
        Ok(false)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    kind: Option<String>,
    key: Option<String>,
    device_id: Option<String>,
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
            "device" => {
                let device = need(&p.device_id, "Device id")?;
                Ok(match self.capture_authority.device(owner, &device)? {
                    Some(d) => json!({"found": true, "recordingAllowed": d.recording_allowed, "expiresAt": d.expires_at}),
                    None => json!({"found": false}),
                })
            }
            "processing" => Ok(json!({"ready": self.capture_authority.processing_ready(owner)?})),
            _ => anyhow::bail!("Unsupported Meetings capture operation"),
        }
    }
}
