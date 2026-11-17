//! One understanding pass. It reads pending cached messages from the host, asks the
//! person's configured model (through the router, never by name) and stores the result.
//! Only the cached subject, sender and preview text go into a prompt, and nothing from a
//! message is logged or returned to the caller.
use super::extract::{self, Extract, Parsed};
use super::otp::{sign_in_code_decision, SignInCode};
use super::sorting::{self, Decision, UserSentLast};
use super::text::sender_address;
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

/// The sorting questions come back as six numbers, so a short answer is enough.
const SORTING_TOKENS: u64 = 200;
const EXTRACT_TOKENS: u64 = 1500;

enum Outcome {
    Stored,
    Failed,
    NeedsConfiguration,
}

fn ask(host: &impl Host, resource: &str, prompt: &str, tokens: u64) -> std::result::Result<String, String> {
    let reply = host
        .call("ai", "generate", resource, json!({"prompt":prompt,"maxOutputTokens":tokens}))
        .map_err(|e| e.message)?;
    reply["text"].as_str().map(String::from).ok_or_else(|| "no reply".to_string())
}

fn parsed(message: &Value, today: &str) -> Parsed {
    let text = |k: &str| message[k].as_str().map(String::from);
    let snippet = text("snippet");
    Parsed {
        subject: text("subject").unwrap_or_default(),
        from: text("sender").unwrap_or_default(),
        body: text("bodyExcerpt").or_else(|| snippet.clone()).unwrap_or_default(),
        snippet,
        received_day: text("receivedDay"),
        today: today.to_string(),
        has_list_unsubscribe: message["hasListUnsubscribe"].as_bool(),
    }
}

/// Settles a message with the sorting questions, or None when the general model must decide.
fn sorted(host: &impl Host, p: &Parsed, sign_in: SignInCode, sent_last: UserSentLast, known: bool)
    -> std::result::Result<Option<Extract>, String> {
    let reply = match ask(host, "structured", &sorting::build_prompt(p), SORTING_TOKENS) {
        Ok(reply) => reply,
        Err(error) if extract::needs_configuration(&error) => return Err(error),
        Err(_) => return Ok(None),
    };
    let Some(answers) = sorting::parse_answers(&reply) else { return Ok(None) };
    Ok(match sorting::decide(sign_in, sent_last, &answers) {
        Decision::Category(category) => {
            Some(sorting::result_for(p, category, sorting::certainty(&answers), known))
        }
        Decision::Unsure => None,
    })
}

fn analyse(host: &impl Host, message: &Value, today: &str, own: &[String]) -> std::result::Result<Extract, String> {
    let p = parsed(message, today);
    if own.contains(&sender_address(&p.from)) {
        return Ok(extract::own_sent());
    }
    let sign_in = sign_in_code_decision(&p.subject, &p.body);
    if sign_in == SignInCode::HandsOver {
        return Ok(extract::otp_skipped());
    }
    let known = message["knownSender"].as_bool().unwrap_or(false);
    let sent_last = match message["threadLastSender"].as_str() {
        Some(s) if own.contains(&sender_address(s)) => UserSentLast::Yes,
        Some(_) => UserSentLast::No,
        None => UserSentLast::Unknown,
    };
    if let Some(done) = sorted(host, &p, sign_in, sent_last, known)? {
        return Ok(done);
    }
    let reply = ask(host, "chat", &extract::build_prompt(&p, known), EXTRACT_TOKENS)?;
    if extract::model_says_sign_in_code(&reply, sign_in) {
        return Ok(extract::otp_skipped());
    }
    let parsed_reply = extract::safe_parse(&reply, &p);
    if parsed_reply.signals.get("confidence").and_then(Value::as_f64).unwrap_or(0.0) <= 0.0
        && parsed_reply.category().is_none()
    {
        return Err("structured output".into());
    }
    Ok(extract::sanitize(&p, parsed_reply, known))
}

fn one(host: &impl Host, message: &Value, today: &str, own: &[String]) -> Result<Outcome> {
    let id = message["id"].clone();
    match analyse(host, message, today, own) {
        Ok(result) => {
            kv(host, "set", "email.understand", json!({
                "action":"result","id":id,"summary":result.summary,"signals":result.signals}))?;
            Ok(Outcome::Stored)
        }
        Err(error) if extract::needs_configuration(&error) => Ok(Outcome::NeedsConfiguration),
        Err(_) => {
            kv(host, "set", "email.understand", json!({"action":"fail","id":id}))?;
            Ok(Outcome::Failed)
        }
    }
}

/// Runs one pass over at most `limit` pending messages and returns only counts.
pub fn run(host: &impl Host, limit: i64) -> Result<Value> {
    let batch = kv(host, "get", "email.understand", json!({"limit":limit}))?;
    let today = batch["today"].as_str().unwrap_or("").to_string();
    let own: Vec<String> = batch["ownAddresses"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let (mut stored, mut failed, mut needs_configuration) = (0, 0, false);
    for message in batch["messages"].as_array().into_iter().flatten() {
        match one(host, message, &today, &own)? {
            Outcome::Stored => stored += 1,
            Outcome::Failed => failed += 1,
            Outcome::NeedsConfiguration => {
                needs_configuration = true;
                break;
            }
        }
    }
    if needs_configuration && stored == 0 && failed == 0 {
        return Err(Error::new(409, "Email could not reach your AI service. Choose one in settings or try again later"));
    }
    Ok(json!({"analysed":stored,"failed":failed,"needsConfiguration":needs_configuration}))
}

/// Reads one message's meaning without storing it. The caller supplies the message fields,
/// today's date and the person's own addresses. Used for live mail that is not cached.
pub fn triage(host: &impl Host, input: &Value) -> Result<Value> {
    let own: Vec<String> = input["ownAddresses"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let today = input["today"].as_str().unwrap_or("");
    Ok(match analyse(host, &input["message"], today, &own) {
        Ok(result) => json!({"summary":result.summary,"signals":result.signals}),
        Err(error) if extract::needs_configuration(&error) => json!({"error":"needs_configuration"}),
        Err(_) => json!({"error":"failed"}),
    })
}

/// Today's date and the person's own addresses, for callers that triage live mail.
pub fn context(host: &impl Host) -> Result<Value> {
    let batch = kv(host, "get", "email.understand", json!({"contextOnly":true}))?;
    Ok(json!({"today":batch["today"],"ownAddresses":batch["ownAddresses"]}))
}
