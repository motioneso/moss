//! Sorting mail with six yes/no questions. The model gives a probability for each
//! question and this code turns the answers into a category, first match wins. An
//! answer the decision depends on that sits in the unsure band sends the mail to the
//! general model instead.
use super::extract::{otp_skipped, sanitize, Extract, Parsed};
use super::gate::Gate;
use super::otp::SignInCode;
use serde_json::{json, Map, Value};

pub const UNSURE_LOW: f64 = 0.35;
pub const UNSURE_HIGH: f64 = 0.65;
pub const MAX_REQUEST_BYTES: usize = 12_000;
const ENVELOPE_RESERVE_BYTES: usize = 400;

/// The six agreed questions. The wording is part of the approved design.
pub const QUESTIONS: [(&str, &str); 6] = [
    ("personal_sender", "Did a real person write this to you personally, rather than an automated or bulk sender?"),
    ("asks_reply", "Does it ask you a question or expect a reply?"),
    ("asks_action", "Does it ask you to do something (pay, sign, book, fill in a form)?"),
    ("near_deadline", "Does it mention a date or deadline in the next week?"),
    ("marketing", "Is it marketing, a newsletter or a promotion?"),
    ("receipt_or_notice", "Is this a receipt, order or booking confirmation, or an account or policy notice?"),
];

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Answer {
    Yes,
    No,
    Unsure,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Category(&'static str),
    Unsure,
}

/// Whether the newest cached message in the thread was sent by the person.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum UserSentLast {
    Yes,
    No,
    Unknown,
}

fn answer(probabilities: &Map<String, Value>, id: &str) -> Answer {
    match probabilities.get(id).and_then(Value::as_f64).filter(|v| v.is_finite()) {
        Some(p) if p > UNSURE_HIGH => Answer::Yes,
        Some(p) if p < UNSURE_LOW => Answer::No,
        _ => Answer::Unsure,
    }
}

/// The agreed mapping, first match wins: sign-in code, noise (marketing and not a
/// personal sender), needs_reply, needs_action, receipt_or_notice, waiting_on_someone,
/// time_sensitive_info, fyi.
pub fn decide(sign_in: SignInCode, sent_last: UserSentLast, p: &Map<String, Value>) -> Decision {
    if sign_in != SignInCode::Ordinary {
        return Decision::Category("sign_in_code");
    }
    let marketing = answer(p, "marketing");
    let personal = answer(p, "personal_sender");
    if marketing == Answer::Yes && personal == Answer::No {
        return Decision::Category("noise");
    }
    if marketing != Answer::No && personal != Answer::Yes {
        return Decision::Unsure;
    }
    for (id, category) in [
        ("asks_reply", "needs_reply"),
        ("asks_action", "needs_action"),
        ("receipt_or_notice", "receipt_or_notice"),
    ] {
        match answer(p, id) {
            Answer::Yes => return Decision::Category(category),
            Answer::Unsure => return Decision::Unsure,
            Answer::No => {}
        }
    }
    match sent_last {
        UserSentLast::Unknown => return Decision::Unsure,
        UserSentLast::Yes => return Decision::Category("waiting_on_someone"),
        UserSentLast::No => {}
    }
    match answer(p, "near_deadline") {
        Answer::Yes => Decision::Category("time_sensitive_info"),
        Answer::Unsure => Decision::Unsure,
        Answer::No => Decision::Category("fyi"),
    }
}

fn questions_json() -> Value {
    Value::Object(QUESTIONS.iter().map(|(id, text)| ((*id).into(), json!({"instructions":text}))).collect())
}

/// The request the questions are asked in. The body is cut until the whole request
/// fits the byte budget.
pub fn build_prompt(parsed: &Parsed) -> String {
    let head = json!({
        "subject":parsed.subject,"from":parsed.from,
        "received":parsed.received_day,"today":parsed.today,
    });
    let questions = questions_json();
    let used = questions.to_string().len() + head.to_string().len() + 20;
    let budget = MAX_REQUEST_BYTES.saturating_sub(ENVELOPE_RESERVE_BYTES + used);
    let mut body = parsed.body.clone();
    while json!(body).to_string().len() > budget && !body.is_empty() {
        let keep = body.chars().count().saturating_sub(1).min(body.chars().count() * budget / body.len().max(1));
        body = body.chars().take(keep).collect();
    }
    let mut state = head;
    state["body"] = json!(body);
    format!(
        "Answer each question about the email with the probability, from 0 to 1, that the answer is yes. \
Reply with one JSON object only, keyed by question id, with a number for every question.\n\n\
Questions: {questions}\n\nEmail: {state}"
    )
}

/// The six probabilities in a model reply, or None when the reply is not usable.
pub fn parse_answers(reply: &str) -> Option<Map<String, Value>> {
    let start = reply.find('{')?;
    let end = reply.rfind('}')?;
    let value: Value = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let object = value.as_object()?;
    let kept: Map<String, Value> = QUESTIONS
        .iter()
        .filter_map(|(id, _)| object.get(*id).and_then(Value::as_f64).filter(|p| (0.0..=1.0).contains(p)).map(|p| ((*id).into(), json!(p))))
        .collect();
    (!kept.is_empty()).then_some(kept)
}

/// How sure the least sure answer was.
pub fn certainty(p: &Map<String, Value>) -> f64 {
    p.values()
        .filter_map(Value::as_f64)
        .map(|v| v.max(1.0 - v))
        .fold(None, |min: Option<f64>, v| Some(min.map_or(v, |m| m.min(v))))
        .unwrap_or(1.0)
}

/// The stored result for a category the sorting questions settled.
pub fn result_for(parsed: &Parsed, category: &str, confidence: f64, known_sender: bool) -> Extract {
    let mark = |mut result: Extract| {
        result.signals.insert("sortedBy".into(), json!("sorting_model"));
        result
    };
    match category {
        "sign_in_code" => otp_skipped(),
        "noise" => {
            let mut r = Extract::new(None, json!({"actionability":{"category":"noise"},"confidence":confidence}));
            r.gate = Some(Gate::Nothing);
            mark(r)
        }
        "needs_reply" | "needs_action" | "time_sensitive_info" => {
            let mut signals = json!({"pendingJudgement":true,"confidence":confidence});
            if category != "time_sensitive_info" {
                signals["actionability"] = json!({"category":category});
            }
            let mut r = Extract::new(None, signals);
            r.gate = Some(Gate::MaybeOwed);
            mark(r)
        }
        _ => {
            let mut r = Extract::new(None, json!({"actionability":{"category":category},"confidence":confidence}));
            if category == "fyi" {
                r.gate = Some(Gate::WorthKnowing);
            }
            mark(sanitize(parsed, r, known_sender))
        }
    }
}
