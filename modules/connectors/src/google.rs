//! Google connect. The guest validates the request and shapes the answer. Building the
//! consent address, the pending row, the token exchange and the sealing happen in the host,
//! so the client secret and the tokens never pass through the guest's answer.
use crate::{fastify, kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

const STEPS: [&str; 5] = [
    "In Google Cloud Console, create a project and enable the Gmail API and Google Calendar API.",
    "Configure the OAuth consent screen and add yourself as a test user.",
    "Create an OAuth client of type 'Desktop app' and copy the client ID and secret.",
    "Open Jarv1s Settings \u{2192} Connect Google, paste the client ID and secret, and start authorization.",
    "Approve in the browser. The http://localhost:1 page will fail to load (expected). Copy the full address-bar URL and paste it back in Settings to finish.",
];

fn field(body: &serde_json::Map<String, Value>, name: &str) -> Result<String> {
    let text = fastify::string(&body[name], name)?;
    if text.is_empty() {
        return Err(Error::new(
            400,
            format!("body/{name} must NOT have fewer than 1 characters"),
        ));
    }
    fastify::trimmed(&text, name)
}

pub fn authorize(host: &impl Host, body: &Value) -> Result<Value> {
    let body = fastify::object(body)?;
    fastify::required(body, &["clientId", "clientSecret"])?;
    let client_id = field(body, "clientId")?;
    let client_secret = field(body, "clientSecret")?;
    let answer = kv(
        host,
        "set",
        "connectors.google-authorize",
        json!({"clientId":client_id,"clientSecret":client_secret}),
    )?;
    let url = answer["authUrl"].as_str().ok_or_else(|| Error::new(500, "Internal server error"))?;
    Ok(json!({"authUrl":url}))
}

pub fn complete(host: &impl Host, body: &Value) -> Result<(u16, Value)> {
    let body = fastify::object(body)?;
    fastify::required(body, &["redirectUrl"])?;
    let redirect = field(body, "redirectUrl")?;
    let answer = kv(host, "set", "connectors.google-complete", json!({"redirectUrl":redirect}))?;
    if let Some(refused) = answer.get("refused") {
        let status = refused["status"].as_u64().unwrap_or(429) as u16;
        return Ok((status, refused["body"].clone()));
    }
    if let Some(message) = answer["failure"].as_str() {
        return Err(Error::new(400, message));
    }
    match answer.get("account") {
        Some(account) if !account.is_null() => {
            if let Some(id) = account["id"].as_str() {
                crate::google_sync::reconcile_schedule(host, id);
                let _ = crate::google_sync::sync_soon(host, id, "on-connect", false);
            }
            Ok((201, json!({"account":account})))
        }
        _ => Err(Error::new(500, "Internal server error")),
    }
}

/// The chat tool answer. It carries no account data.
pub fn guidance() -> Value {
    json!({"data":{"steps":STEPS,"settingsUrl":"/settings"}})
}
