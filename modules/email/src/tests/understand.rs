//! Fixed cases for the sorting mapping, gate and model-reply parsing, from the old app's tests.
use moss_email::understand::extract::{safe_parse, sanitize, Parsed};
use moss_email::understand::gate::Gate;
use moss_email::understand::otp::SignInCode;
use moss_email::understand::sorting::{decide, Decision, UserSentLast};
use serde_json::{json, Map, Value};

const YES: f64 = 0.9;
const NO: f64 = 0.1;
const UNSURE: f64 = 0.5;

fn answers(over: &[(&str, f64)]) -> Map<String, Value> {
    let mut m = Map::new();
    for id in ["personal_sender", "asks_reply", "asks_action", "near_deadline", "marketing", "receipt_or_notice"] {
        m.insert(id.into(), json!(NO));
    }
    for (k, v) in over {
        m.insert((*k).into(), json!(v));
    }
    m
}

fn pick(over: &[(&str, f64)], sent: UserSentLast) -> Decision {
    decide(SignInCode::Ordinary, sent, &answers(over))
}

fn cat(c: &'static str) -> Decision {
    Decision::Category(c)
}

#[test]
fn sign_in_code_wins() {
    let d = decide(SignInCode::HandsOver, UserSentLast::No, &answers(&[("marketing", YES), ("asks_reply", YES)]));
    assert_eq!(d, cat("sign_in_code"));
    assert_eq!(decide(SignInCode::Unclear, UserSentLast::No, &answers(&[])), cat("sign_in_code"));
}

#[test]
fn mapping_order() {
    use UserSentLast::*;
    assert_eq!(pick(&[("marketing", YES), ("asks_reply", YES)], No), cat("noise"));
    assert_eq!(pick(&[("marketing", YES), ("personal_sender", YES), ("asks_reply", YES)], No), cat("needs_reply"));
    assert_eq!(pick(&[("asks_reply", YES), ("asks_action", YES)], No), cat("needs_reply"));
    assert_eq!(pick(&[("asks_action", YES)], Yes), cat("needs_action"));
    assert_eq!(pick(&[("receipt_or_notice", YES), ("asks_action", YES)], No), cat("needs_action"));
    assert_eq!(pick(&[("receipt_or_notice", YES), ("near_deadline", YES)], Yes), cat("receipt_or_notice"));
    assert_eq!(pick(&[("near_deadline", YES)], Yes), cat("waiting_on_someone"));
    assert_eq!(pick(&[("near_deadline", YES)], No), cat("time_sensitive_info"));
    assert_eq!(pick(&[], No), cat("fyi"));
}

#[test]
fn unreadable_thread_defers_only_when_it_matters() {
    assert_eq!(pick(&[("near_deadline", YES)], UserSentLast::Unknown), Decision::Unsure);
    assert_eq!(pick(&[("receipt_or_notice", YES)], UserSentLast::Unknown), cat("receipt_or_notice"));
}

#[test]
fn unsure_band_defers_only_when_the_answer_decides() {
    use UserSentLast::No;
    assert_eq!(pick(&[("marketing", UNSURE)], No), Decision::Unsure);
    assert_eq!(pick(&[("marketing", YES), ("personal_sender", UNSURE)], No), Decision::Unsure);
    assert_eq!(pick(&[("marketing", UNSURE), ("personal_sender", YES), ("asks_reply", YES)], No), cat("needs_reply"));
    assert_eq!(pick(&[("personal_sender", UNSURE)], No), cat("fyi"));
    assert_eq!(pick(&[("asks_reply", UNSURE), ("asks_action", YES)], No), Decision::Unsure);
    assert_eq!(pick(&[("asks_action", UNSURE)], No), Decision::Unsure);
}

#[test]
fn band_edges_are_unsure() {
    use UserSentLast::No;
    assert_eq!(pick(&[("asks_action", 0.34)], No), cat("fyi"));
    assert_eq!(pick(&[("asks_action", 0.35)], No), Decision::Unsure);
    assert_eq!(pick(&[("asks_action", 0.65)], No), Decision::Unsure);
    assert_eq!(pick(&[("asks_action", 0.66)], No), cat("needs_action"));
}

fn parsed(subject: &str, body: &str) -> Parsed {
    Parsed {
        subject: subject.into(),
        from: "Shop <news@shop.example>".into(),
        snippet: Some(body.chars().take(200).collect()),
        body: body.into(),
        received_day: Some("2026-11-10".into()),
        today: "2026-11-12".into(),
        has_list_unsubscribe: None,
    }
}

#[test]
fn gate_words_round_trip() {
    for g in [Gate::Nothing, Gate::WorthKnowing, Gate::MaybeOwed] {
        assert_eq!(Gate::parse(g.as_str()), Some(g));
    }
    assert_eq!(Gate::parse("other"), None);
}

#[test]
fn unparseable_reply_gives_an_empty_result() {
    let p = parsed("Hello", "Plain body text that is long enough to count as a real message body here.");
    let r = safe_parse("not json at all", &p);
    assert!(r.summary.is_none());
    assert_eq!(r.signals.get("confidence"), Some(&json!(0)));
}

#[test]
fn bulk_mail_from_unknown_sender_with_noise_verdict_keeps_nothing() {
    let body = "Big sale this week only, forty percent off everything in store. To stop getting these, unsubscribe at any time using the link below.";
    let p = parsed("Sale", body);
    let reply = r#"{"category":"noise","gate":"maybe_owed","confidence":0.8}"#;
    let r = sanitize(&p, safe_parse(reply, &p), false);
    assert_eq!(r.gate, Some(Gate::Nothing));
}

#[test]
fn a_reply_that_copies_the_body_is_not_kept_as_the_summary() {
    let body = "Please send me the signed form by Friday so that I can file it with the office before the weekend starts.";
    let p = parsed("Form", body);
    let reply = json!({"summary": body, "category": "needs_reply", "confidence": 0.7}).to_string();
    let r = sanitize(&p, safe_parse(&reply, &p), true);
    assert_ne!(r.summary.as_deref(), Some(body));
}
