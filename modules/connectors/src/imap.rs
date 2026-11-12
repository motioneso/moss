//! IMAP mail connect. The guest validates the request and shapes the answer. The server
//! settings, the login test and the sealing of the password happen in the host, so the
//! password never appears in an answer.
use crate::{fastify, kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};

const PROVIDERS: [&str; 4] = ["imap-yahoo", "imap-proton", "imap-icloud", "imap-fastmail"];

struct Login {
    provider_id: String,
    username: String,
    password: String,
}

fn text(body: &Map<String, Value>, name: &str) -> Result<String> {
    let text = fastify::string(&body[name], name)?;
    if text.is_empty() {
        return Err(Error::new(
            400,
            format!("body/{name} must NOT have fewer than 1 characters"),
        ));
    }
    Ok(text)
}

fn login(body: &Value) -> Result<Login> {
    let body = fastify::object(body)?;
    fastify::required(body, &["providerId", "username", "password"])?;
    let provider = fastify::string(&body["providerId"], "providerId")?;
    if !PROVIDERS.contains(&provider.as_str()) {
        return Err(Error::new(
            400,
            "body/providerId must be equal to one of the allowed values",
        ));
    }
    let username = text(body, "username")?;
    let password = text(body, "password")?;
    Ok(Login {
        provider_id: fastify::trimmed(&provider, "providerId")?,
        username: fastify::trimmed(&username, "username")?,
        password: fastify::trimmed(&password, "password")?,
    })
}

fn params(login: &Login) -> Value {
    json!({"providerId":login.provider_id,"username":login.username,"password":login.password})
}

fn result(answer: &Value) -> Result<&str> {
    match answer["result"].as_str() {
        Some(r @ ("ok" | "auth_failed" | "tls_failed" | "unreachable")) => Ok(r),
        _ => Err(Error::new(500, "Internal server error")),
    }
}

pub fn test_connection(host: &impl Host, body: &Value) -> Result<Value> {
    let login = login(body)?;
    let answer = kv(host, "set", "connectors.imap-test", params(&login))?;
    Ok(json!({"result":result(&answer)?}))
}

pub fn connect(host: &impl Host, body: &Value) -> Result<(u16, Value)> {
    let login = login(body)?;
    let answer = kv(host, "set", "connectors.imap-connect", params(&login))?;
    if let Some(account) = answer.get("account").filter(|a| !a.is_null()) {
        return Ok((201, json!({"account":account})));
    }
    let message = match result(&answer)? {
        "auth_failed" => "The mail server rejected the supplied username/password",
        "tls_failed" => "Could not establish a secure connection to the mail server",
        _ => "Could not reach the mail server",
    };
    Err(Error::new(400, message))
}
