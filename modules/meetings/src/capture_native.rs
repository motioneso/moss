//! The Mac's proof on audio, status and control calls. The bearer credential comes from the host
//! (route requests carry no headers). It names the owner and the grant, and its hash must match
//! the grant's stored hash. Every failure is the same 401 and none says which check failed.
use crate::capture_auth::{denied, proof_matches, require_recording};
use crate::capture_errors::Stop;
use crate::capture_store::{self as store, now, parse, CAPTURE};
use crate::capture_state::revoke;
use crate::text::is_uuid;
use moss_module_sdk::Host;
use serde_json::{json, Value};

const OPEN: [&str; 3] = ["active", "finalizing", "complete"];

/// `mm1_<user>.<grant>.<43 character secret>`. Returns the whole credential when the grant part
/// matches `grant_id`.
fn parse_credential(text: &str, grant_id: &str) -> Option<String> {
    let rest = text.strip_prefix("mm1_")?;
    let mut parts = rest.split('.');
    let (user, grant, secret) = (parts.next()?, parts.next()?, parts.next()?);
    let shaped = parts.next().is_none()
        && user.len() == 36
        && is_uuid(user)
        && grant.len() == 36
        && is_uuid(grant)
        && grant.eq_ignore_ascii_case(grant_id)
        && secret.len() == 43
        && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    shaped.then(|| text.to_owned())
}

fn credential<H: Host + ?Sized>(host: &H, grant_id: &str) -> Result<String, Stop> {
    let answer = host.call("kv", "credential", CAPTURE, json!({}))?;
    answer["credential"]
        .as_str()
        .filter(|_| answer["found"] == json!(true))
        .and_then(|text| parse_credential(text, grant_id))
        .ok_or_else(|| denied().into())
}

/// The grant when it belongs to `meeting`, has not expired or been revoked, and matches the
/// credential.
fn valid(grant: Option<Value>, meeting: &str, credential: &str, at: chrono::DateTime<chrono::Utc>) -> Result<Value, Stop> {
    let grant = grant.ok_or_else(denied)?;
    let status = grant["status"].as_str().unwrap_or_default();
    let stored = grant["credential_hash"].as_str().unwrap_or_default();
    let alive = grant["meeting_id"] == json!(meeting) && parse(&grant["expires_at"]).is_some_and(|t| t > at) && OPEN.contains(&status);
    if !alive || stored.len() != 64 || !proof_matches(credential, stored) {
        return Err(denied().into());
    }
    Ok(grant)
}

/// Locks the device and meeting, rereads the grant and checks the Mac's connection and live
/// recording permission. Returns the fresh grant row. A lost permission revokes the grant.
pub fn prove<H: Host + ?Sized>(host: &H, meeting: &str, grant_id: &str) -> Result<Value, Stop> {
    let secret = credential(host, grant_id)?;
    let at = now(host)?;
    let first = valid(store::grant(host, grant_id)?, meeting, &secret, at)?;
    store::lock(host, "device", first["device_id"].as_str().unwrap_or_default())?;
    store::lock(host, "meeting", meeting)?;
    let grant = valid(store::grant(host, grant_id)?, meeting, &secret, at)?;
    let device = grant["device_id"].as_str().unwrap_or_default();
    let connection = store::connection(host, device)?.ok_or_else(denied)?;
    if connection["connection_id"] != grant["connection_id"]
        || connection["capability_revision"] != grant["capability_revision"]
        || connection["verifier_hash"] != grant["verifier_hash"]
    {
        return Err(denied().into());
    }
    match require_recording(host, device, grant["capability_revision"].as_i64().unwrap_or(0)) {
        Ok(_) => Ok(grant),
        Err(stop) => {
            settle(host, &grant)?;
            Err(stop)
        }
    }
}

pub fn denied_stop() -> Stop {
    denied().into()
}

/// Revokes a grant whose permission is gone, so the Mac and the browser both see it end.
pub fn settle<H: Host + ?Sized>(host: &H, grant: &Value) -> Result<(), Stop> {
    let mut saved = store::state(grant);
    if saved["desired"] == "revoked" {
        return Ok(());
    }
    let at = now(host)?;
    let at_ms = crate::capture_state::elapsed(&saved, at);
    revoke(&mut saved, at_ms, Some("recording-permission-revoked"));
    store::save(host, grant, &saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "11111111-1111-4111-8111-111111111111";
    const GRANT: &str = "22222222-2222-4222-8222-222222222222";
    const SECRET: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    #[test]
    fn accepts_the_exact_shape() {
        let text = format!("mm1_{USER}.{GRANT}.{SECRET}");
        assert_eq!(parse_credential(&text, GRANT), Some(text));
    }

    #[test]
    fn refuses_other_shapes_and_other_grants() {
        let other = "33333333-3333-4333-8333-333333333333";
        for text in [
            format!("mm1_{USER}.{other}.{SECRET}"),
            format!("mm2_{USER}.{GRANT}.{SECRET}"),
            format!("mm1_{USER}.{GRANT}.{}", &SECRET[1..]),
            format!("mm1_{USER}.{GRANT}.{SECRET}.x"),
            format!("mm1_{USER}.{GRANT}.{}!", &SECRET[..42]),
            format!("{USER}.{GRANT}.{SECRET}"),
        ] {
            assert_eq!(parse_credential(&text, GRANT), None, "{text}");
        }
    }
}
