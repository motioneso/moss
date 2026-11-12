//! Reading the model's triage answer. The model's JSON is never trusted: only known
//! fields are kept, every string is capped, and any text that echoes the mail is
//! dropped before it reaches a stored column.
use super::gate::Gate;
use super::otp::SignInCode;
use super::prompt::TRIAGE_INSTRUCTIONS;
use super::text::collapse_whitespace;
use serde_json::{json, Map, Value};

pub const MAX_SUMMARY_CHARS: usize = 600;
pub const SUMMARY_BODY_SUBSTRING_FLOOR: usize = 200;
pub const MAX_SIGNAL_STR_CHARS: usize = 280;
pub const MAX_SIGNAL_ITEMS: usize = 50;
pub const BODY_RECONSTRUCTION_FRACTION: f64 = 0.5;

const CATEGORIES: [&str; 8] = [
    "needs_reply", "needs_action", "time_sensitive_info", "waiting_on_someone", "fyi",
    "receipt_or_notice", "noise", "unknown",
];

/// The mail as the understanding pass sees it. `body` is the cached preview.
#[derive(Clone, Debug, Default)]
pub struct Parsed {
    pub subject: String,
    pub from: String,
    pub snippet: Option<String>,
    pub body: String,
    pub received_day: Option<String>,
    pub today: String,
    pub has_list_unsubscribe: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Extract {
    pub summary: Option<String>,
    pub gate: Option<Gate>,
    pub signals: Map<String, Value>,
}

impl Extract {
    pub fn new(summary: Option<String>, signals: Value) -> Self {
        Self { summary, gate: None, signals: signals.as_object().cloned().unwrap_or_default() }
    }
    pub fn category(&self) -> Option<&str> {
        self.signals.get("actionability")?.get("category")?.as_str()
    }
    fn confidence(&self) -> f64 {
        self.signals.get("confidence").and_then(Value::as_f64).unwrap_or(0.0)
    }
}

pub fn otp_skipped() -> Extract {
    Extract::new(None, json!({"skipped":"otp","confidence":0}))
}

pub fn own_sent() -> Extract {
    Extract::new(None, json!({"skipped":"own_sent","confidence":1}))
}

/// A word-for-word bulk hint. The header flag wins, else the word "unsubscribe".
pub fn looks_like_bulk(has_header: Option<bool>, body: &str) -> bool {
    if has_header == Some(true) {
        return true;
    }
    super::text::has_any_word(&body.to_lowercase(), &["unsubscribe"])
}

const KNOWN_SENDER_LINE: &str = "Sender: someone this user already deals with (in their People or previously replied to). Lean toward maybe_owed, but it is not proof.";

/// The email as the model sees it: subject, sender, two dates in the person's own
/// day, the bulk hint, then the preview.
pub fn prompt_input(parsed: &Parsed, known_sender: bool) -> String {
    let mut header = vec![format!("Subject: {}", parsed.subject), format!("From: {}", parsed.from)];
    if known_sender {
        header.push(KNOWN_SENDER_LINE.into());
    }
    if let Some(day) = &parsed.received_day {
        header.push(format!("Received: {day}"));
    }
    header.push(format!("Today: {}", parsed.today));
    if looks_like_bulk(parsed.has_list_unsubscribe, &parsed.body) {
        header.push("Bulk mail: yes (carries an unsubscribe link)".into());
    }
    format!("{}\n\n{}", header.join("\n"), parsed.body)
}

pub fn build_prompt(parsed: &Parsed, known_sender: bool) -> String {
    format!("{}\n\n{}", TRIAGE_INSTRUCTIONS.join("\n"), prompt_input(parsed, known_sender))
}

fn normalize(value: &str) -> String {
    collapse_whitespace(value).to_lowercase()
}

/// True when any `SUMMARY_BODY_SUBSTRING_FLOOR` window of the text sits in the body.
fn contains_long_run(text: &str, body: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < SUMMARY_BODY_SUBSTRING_FLOOR {
        return false;
    }
    (0..=chars.len() - SUMMARY_BODY_SUBSTRING_FLOOR).any(|i| {
        body.contains(&chars[i..i + SUMMARY_BODY_SUBSTRING_FLOOR].iter().collect::<String>())
    })
}

/// A bounded, body-safe copy of one model string, or None.
fn safe_str(value: &Value, body: &str) -> Option<String> {
    let text: String = value.as_str()?.chars().take(MAX_SIGNAL_STR_CHARS).collect();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = normalize(trimmed);
    if !body.is_empty() {
        if normalized == body {
            return None;
        }
        if body.contains(&normalized) && normalized.chars().count() > 40 {
            return None;
        }
        if contains_long_run(&normalized, body) {
            return None;
        }
    }
    Some(trimmed.to_string())
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), json!(value));
    }
}

fn items(value: &Value, body: &str, key: &str, due: &str) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_SIGNAL_ITEMS)
        .filter_map(|raw| {
            let mut out = Map::new();
            put(&mut out, key, safe_str(&raw[key], body));
            if !out.contains_key(key) {
                return None;
            }
            put(&mut out, due, safe_str(&raw[due], body));
            Some(Value::Object(out))
        })
        .collect()
}

fn bills(value: &Value, body: &str) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_SIGNAL_ITEMS)
        .filter_map(|raw| {
            let mut out = Map::new();
            put(&mut out, "description", safe_str(&raw["description"], body));
            if !out.contains_key("description") {
                return None;
            }
            if let Some(amount) = raw["amount"].as_f64().filter(|_| raw["amount"].is_number()) {
                out.insert("amount".into(), json!(amount));
            }
            put(&mut out, "currency", safe_str(&raw["currency"], body));
            put(&mut out, "dueDate", safe_str(&raw["dueDate"], body));
            Some(Value::Object(out))
        })
        .collect()
}

fn actionability(value: &Value, body: &str, subject: &str, compact: bool) -> Option<Value> {
    let o = value.as_object()?;
    let category = o
        .get("category")
        .and_then(Value::as_str)
        .filter(|c| CATEGORIES.contains(c))
        .unwrap_or("unknown");
    let action = if compact { safe_str(&value["action"], body) } else { None };
    let tasks: Vec<Value> = if compact {
        match (&action, category) {
            (Some(text), c) if c != "noise" => {
                let mut task = Map::new();
                task.insert("text".into(), json!(text));
                put(&mut task, "dueDate", safe_str(&value["dueDate"], body));
                vec![Value::Object(task)]
            }
            _ => vec![],
        }
    } else if category == "noise" {
        vec![]
    } else {
        items(&value["suggestedTasks"], body, "text", "dueDate")
    };
    let inferred = if compact {
        if ["needs_reply", "needs_action", "time_sensitive_info"].contains(&category) {
            safe_str(&json!(subject), body)
        } else {
            None
        }
    } else {
        safe_str(&value["inferredSubject"], body)
    };
    let mut out = Map::new();
    out.insert("category".into(), json!(category));
    put(&mut out, "reason", safe_str(&value["reason"], body));
    put(&mut out, "dueDate", safe_str(&value["dueDate"], body));
    put(&mut out, "inferredSubject", inferred);
    if !tasks.is_empty() {
        out.insert("suggestedTasks".into(), Value::Array(tasks));
    }
    Some(Value::Object(out))
}

fn json_object(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end < start {
        return None;
    }
    serde_json::from_str(&text[start..=end]).ok()
}

fn empty_result() -> Extract {
    Extract::new(None, json!({"billsDue":[],"actionItems":[],"deadlines":[],"confidence":0}))
}

/// Parses the model reply into a sanitized summary and signals.
pub fn safe_parse(text: &str, parsed: &Parsed) -> Extract {
    let body = normalize(&parsed.body);
    let Some(obj) = json_object(text).filter(Value::is_object) else {
        return empty_result();
    };
    let compact = obj.get("summary").is_none() && obj.get("category").is_some();
    let importance = match obj["importance"].as_str() {
        Some(i @ ("low" | "high")) => i,
        _ => "normal",
    };
    let confidence = obj["confidence"].as_f64().filter(|c| (0.0..=1.0).contains(c)).unwrap_or(0.0);
    let gate = match obj.get("gate") {
        None => None,
        Some(g) => Some(g.as_str().and_then(Gate::parse).unwrap_or(Gate::Nothing)),
    };
    let mut signals = Map::new();
    let list = |compact: bool, make: &dyn Fn() -> Vec<Value>| if compact { vec![] } else { make() };
    signals.insert("billsDue".into(), Value::Array(list(compact, &|| bills(&obj["billsDue"], &body))));
    signals.insert(
        "actionItems".into(),
        Value::Array(list(compact, &|| items(&obj["actionItems"], &body, "text", "dueDate"))),
    );
    signals.insert(
        "deadlines".into(),
        Value::Array(list(compact, &|| items(&obj["deadlines"], &body, "text", "date"))),
    );
    let source = if compact { &obj } else { &obj["actionability"] };
    if let Some(a) = actionability(source, &body, &parsed.subject, compact) {
        signals.insert("actionability".into(), a);
    }
    signals.insert("mayGetLostInShuffle".into(), json!(obj["mayGetLostInShuffle"] == json!(true)));
    signals.insert("importance".into(), json!(importance));
    signals.insert("confidence".into(), json!(confidence));
    Extract { summary: obj["summary"].as_str().map(String::from), gate, signals }
}

fn signal_strings(signals: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    let mut take = |value: &Value, keys: &[&str]| {
        for key in keys {
            if let Some(s) = value[*key].as_str().filter(|s| !s.is_empty()) {
                out.push(s.to_string());
            }
        }
    };
    for b in signals.get("billsDue").and_then(Value::as_array).into_iter().flatten() {
        take(b, &["description", "currency", "dueDate"]);
    }
    for a in signals.get("actionItems").and_then(Value::as_array).into_iter().flatten() {
        take(a, &["text", "dueDate"]);
    }
    for d in signals.get("deadlines").and_then(Value::as_array).into_iter().flatten() {
        take(d, &["text", "date"]);
    }
    if let Some(a) = signals.get("actionability") {
        take(a, &["reason", "dueDate", "inferredSubject"]);
        for t in a["suggestedTasks"].as_array().into_iter().flatten() {
            take(t, &["text", "dueDate"]);
        }
    }
    out
}

/// Strips every text-bearing signal when the signal strings together rebuild
/// at least half of the mail.
fn strip_if_reconstructed(signals: Map<String, Value>, body: &str) -> Map<String, Value> {
    if body.is_empty() {
        return signals;
    }
    let covered: usize = signal_strings(&signals)
        .iter()
        .map(|s| normalize(s))
        .filter(|n| !n.is_empty() && body.contains(n.as_str()))
        .map(|n| n.chars().count())
        .sum();
    if (covered as f64) < body.chars().count() as f64 * BODY_RECONSTRUCTION_FRACTION {
        return signals;
    }
    let mut out = Map::new();
    for key in ["mayGetLostInShuffle", "importance", "confidence", "truncated"] {
        if let Some(v) = signals.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    for key in ["billsDue", "actionItems", "deadlines"] {
        out.insert(key.into(), json!([]));
    }
    if let Some(c) = signals.get("actionability").and_then(|a| a.get("category")) {
        out.insert("actionability".into(), json!({"category":c}));
    }
    out
}

/// The preview summary, body-echo guard, reconstruction guard, bulk flag and gate.
pub fn sanitize(parsed: &Parsed, initial: Extract, known_sender: bool) -> Extract {
    let mut result = initial;
    let use_fallback = result.summary.is_none() && result.confidence() > 0.0;
    let preview = parsed.snippet.as_deref().unwrap_or("").trim().to_string();
    if use_fallback {
        let fallback = if preview.is_empty() { parsed.subject.trim().to_string() } else { preview.clone() };
        result.summary =
            (!fallback.is_empty()).then(|| fallback.chars().take(MAX_SUMMARY_CHARS).collect());
    }
    let body = normalize(&parsed.body);
    if let Some(summary) = result.summary.clone() {
        let normalized = normalize(&summary);
        let echoes = normalized == body
            || (!body.is_empty() && normalized.contains(&body))
            || (!body.is_empty() && contains_long_run(&normalized, &body));
        let subject_fallback = if use_fallback && !preview.is_empty() { parsed.subject.trim() } else { "" };
        result.summary = if echoes {
            (!subject_fallback.is_empty()).then(|| subject_fallback.chars().take(MAX_SUMMARY_CHARS).collect())
        } else {
            Some(summary.chars().take(MAX_SUMMARY_CHARS).collect())
        };
    }
    result.signals = strip_if_reconstructed(result.signals, &body);
    if looks_like_bulk(parsed.has_list_unsubscribe, &parsed.body) {
        result.signals.insert("bulk".into(), json!(true));
    }
    super::gate::apply(result, known_sender, &parsed.subject, &parsed.body)
}

/// True when the model says a message the rule was unsure about hands over a code.
pub fn model_says_sign_in_code(reply: &str, decision: SignInCode) -> bool {
    decision == SignInCode::Unclear
        && json_object(reply).is_some_and(|o| o["deliversSignInCode"] == json!(true))
}

/// Why a model call failed, so a retry can pick a sensible wait.
pub fn retry_reason(error: &str) -> &'static str {
    let text = error.to_lowercase();
    let expired = ["login expired", "login-expired", "session expired", "credentials expired",
        "token expired", "not logged in", "unauthenticated", "unauthorized", "401",
        "invalid_api_key", "please log in", "please sign in"];
    if expired.iter().any(|p| text.contains(p)) {
        "login-expired"
    } else if text.contains("timeout") || text.contains("timed out") || text.contains("deadline") {
        "timeout"
    } else if text.contains("busy") {
        "busy"
    } else if text.contains("no reply") || text.contains("without a reply") {
        "no-reply"
    } else {
        "structured-output"
    }
}

/// True when the AI service itself is missing or unreachable. The router hides the reason
/// behind one message, so a missing choice and an outage look the same. Neither says
/// anything about the mail, so no attempt is counted against it.
pub fn needs_configuration(error: &str) -> bool {
    error.contains("not configured")
        || error.contains("not set up")
        || error.contains("could not complete the request")
        || error.contains("AI deadline exceeded")
}
