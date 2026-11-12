//! The understanding pass against a scripted host with fixed fake-model replies.
use moss_email::handle;
use moss_email::moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

const SECRET: &str = "SENTINEL-PREVIEW-77ab";

struct Script {
    messages: Value,
    replies: RefCell<Vec<std::result::Result<String, String>>>,
    calls: RefCell<Vec<(String, String, Value)>>,
}

impl Host for Script {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), resource.into(), p.clone()));
        match (port, operation, resource) {
            ("kv", "get", "email.understand") => Ok(json!({
                "today":"2026-11-12","ownAddresses":["me@example.test"],"messages":self.messages})),
            ("kv", "set", "email.understand") => Ok(json!({"changed":1})),
            ("ai", "generate", _) => {
                let mut replies = self.replies.borrow_mut();
                assert!(!replies.is_empty(), "unexpected model call");
                replies.remove(0).map(|t| json!({"text":t})).map_err(Error::new)
            }
            _ => panic!("unexpected call {port} {resource}"),
        }
    }
}

fn message(id: &str, sender: &str, subject: &str, body: &str) -> Value {
    json!({"id":id,"sender":sender,"subject":subject,"snippet":body,"bodyExcerpt":body,
           "receivedDay":"2026-11-10","attempts":0,"knownSender":false,"threadLastSender":sender})
}

fn run(messages: Vec<Value>, replies: Vec<std::result::Result<&str, &str>>) -> (std::result::Result<Value, String>, Script) {
    let host = Script {
        messages: Value::Array(messages),
        replies: RefCell::new(replies.into_iter().map(|r| r.map(String::from).map_err(String::from)).collect()),
        calls: RefCell::default(),
    };
    let out = handle(&host, "api", &json!({"name":"understandMessages","parameters":{"limit":10}}).to_string())
        .map(|s| serde_json::from_str(&s).unwrap());
    (out, host)
}

fn writes(host: &Script) -> Vec<Value> {
    host.calls.borrow().iter().filter(|c| c.1 == "email.understand" && c.2["action"].is_string()).map(|c| c.2.clone()).collect()
}
fn model_calls(host: &Script) -> usize {
    host.calls.borrow().iter().filter(|c| c.0 == "ai").count()
}

const FYI: &str = r#"{"personal_sender":0.1,"asks_reply":0.1,"asks_action":0.1,"near_deadline":0.1,"marketing":0.1,"receipt_or_notice":0.1}"#;
const UNSURE: &str = r#"{"personal_sender":0.5,"asks_reply":0.5,"asks_action":0.5,"near_deadline":0.1,"marketing":0.1,"receipt_or_notice":0.1}"#;

#[test]
fn sorting_answers_settle_a_message_with_one_model_call() {
    let m = message("m1", "Ann <ann@example.test>", "Lunch notes", &format!("Notes from lunch today. {SECRET}"));
    let (out, host) = run(vec![m], vec![Ok(FYI)]);
    assert_eq!(model_calls(&host), 1);
    let w = writes(&host);
    assert_eq!(w[0]["action"], "result");
    assert_eq!(w[0]["signals"]["actionability"]["category"], "fyi");
    assert_eq!(w[0]["signals"]["sortedBy"], "sorting_model");
    assert_eq!(out.unwrap()["analysed"], 1);
}

#[test]
fn an_unsure_sort_falls_back_to_the_general_model() {
    let m = message("m2", "Ann <ann@example.test>", "Question", "Could you tell me whether the printer on the second floor has been fixed yet?");
    let general = r#"{"category":"needs_reply","gate":"maybe_owed","confidence":0.8}"#;
    let (out, host) = run(vec![m], vec![Ok(UNSURE), Ok(general)]);
    assert_eq!(model_calls(&host), 2);
    assert_eq!(writes(&host)[0]["action"], "result");
    assert_eq!(out.unwrap()["analysed"], 1);
}

#[test]
fn sign_in_codes_and_own_sent_mail_never_reach_a_model() {
    let code = message("m3", "Bank <no-reply@bank.example>", "Your verification code", "Your verification code is 481920. It expires in 10 minutes.");
    let mine = message("m4", "Me <me@example.test>", "Plans", "See you then.");
    let (out, host) = run(vec![code, mine], vec![]);
    assert_eq!(model_calls(&host), 0);
    let w = writes(&host);
    assert_eq!(w[0]["signals"]["skipped"], "otp");
    assert_eq!(w[1]["signals"]["skipped"], "own_sent");
    assert_eq!(out.unwrap()["analysed"], 2);
}

#[test]
fn a_failed_call_counts_an_attempt_and_the_pass_carries_on() {
    let a = message("m5", "a@example.test", "One", "A body long enough to be a real message for the pass to read.");
    let b = message("m6", "b@example.test", "Two", "Another body long enough to be a real message for the pass.");
    let (out, host) = run(vec![a, b], vec![Err("timed out"), Err("timed out"), Ok(FYI)]);
    let w = writes(&host);
    assert_eq!(w[0]["action"], "fail");
    assert_eq!(w[1]["action"], "result");
    let out = out.unwrap();
    assert_eq!((out["failed"].as_i64(), out["analysed"].as_i64()), (Some(1), Some(1)));
}

#[test]
fn a_missing_ai_setup_asks_for_setup_and_counts_no_attempt() {
    let a = message("m7", "a@example.test", "One", "A body long enough to be a real message for the pass to read.");
    let (out, host) = run(vec![a], vec![Err("Module AI is not configured on this server")]);
    assert!(out.is_err());
    assert!(writes(&host).is_empty());
}

#[test]
fn prompts_carry_only_cached_text_and_the_result_carries_none() {
    let m = message("m8", "Ann <ann@example.test>", "Subject line", &format!("Preview text {SECRET} with enough words to read properly."));
    let (out, host) = run(vec![m], vec![Ok(FYI)]);
    for call in host.calls.borrow().iter().filter(|c| c.0 == "ai") {
        let prompt = call.2["prompt"].as_str().unwrap();
        assert!(prompt.contains("Subject line"));
        assert!(!call.2.to_string().contains("attempts") && !call.2.to_string().contains("threadLastSender"));
    }
    assert!(!out.unwrap().to_string().contains(SECRET));
    assert!(!writes(&host).iter().any(|w| w["summary"].as_str().is_some_and(|s| s.contains(SECRET))));
}
