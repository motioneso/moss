mod common;
mod conformance;
use common::Fake;
use moss_scratchpad_module::handle;
use serde_json::{json, Value};

#[test]
fn native_chat_contract() {
    let host = Fake::default();
    conformance::check(|kind, input| {
        serde_json::from_str::<Value>(&handle(&host, kind, &input.to_string()).unwrap()).unwrap()
    });
}

#[test]
fn chat_append_reports_the_actual_change_and_adapts_the_card() {
    let host = Fake::default();
    let call = |kind, value: Value| -> Value {
        serde_json::from_str(&handle(&host, kind, &value.to_string()).unwrap()).unwrap()
    };
    let input = json!({"tool":"scratchpad.append","parameters":{"text":"first"}});
    let card = call(
        "api",
        json!({"name":"prepareChatAction","parameters":input}),
    );
    assert_eq!(card["target"], "Your scratchpad");
    assert_eq!(
        card["fields"],
        json!([{"label":"Text to append","value":"first"}])
    );
    assert!(host.body.borrow().is_empty());
    let first = call("tool", input);
    assert_eq!(
        first["data"]["changed"],
        json!([{"label":"Text appended","before":"","after":"first"}])
    );
    let second = call(
        "tool",
        json!({"tool":"scratchpad.append","parameters":{"text":" second "}}),
    );
    assert_eq!(
        second["data"]["changed"],
        json!([{"label":"Text appended","before":"","after":"\nsecond"}])
    );
    let invalid = call(
        "tool",
        json!({"tool":"scratchpad.append","parameters":{"text":" "}}),
    );
    assert!(invalid["data"].get("changed").is_none());
    assert!(handle(&host, "api", &json!({"name":"prepareChatAction","parameters":{"tool":"scratchpad.read","parameters":{}}}).to_string()).is_err());
}
