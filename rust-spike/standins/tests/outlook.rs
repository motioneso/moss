//! The stand-in Outlook page answers the helper protocol the way the host expects.
use moss_standins::outlook::{OutlookConfig, OutlookStandIn};
use serde_json::{json, Value};

async fn ask(page: &OutlookStandIn, op: &str, args: Value) -> Value {
    reqwest::Client::new().post(page.endpoint()).json(&json!({"op":op,"args":args})).send().await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn the_page_answers_each_operation() {
    let page = OutlookStandIn::start(OutlookConfig::default()).await;
    page.add_event("e1", "Invented standup", "10 AM to 10:30 AM", 0);
    assert_eq!(ask(&page, "account-address", json!({})).await["value"], "person@example.invalid");
    assert_eq!(ask(&page, "display", json!({})).await["value"]["language"], "en-US");
    assert_eq!(ask(&page, "primary-calendar", json!({})).await["value"], true);
    assert!(ask(&page, "week-header", json!({})).await["value"].as_str().unwrap().ends_with("date range."));
    let rows = ask(&page, "read-week", json!({})).await["value"].clone();
    assert_eq!(rows[0]["id"], "e1");
    ask(&page, "step-week", json!({"forward":true})).await;
    assert_eq!(ask(&page, "read-week", json!({})).await["value"], json!([]));
    assert_eq!(ask(&page, "nonsense", json!({})).await["error"], "unknown-op");
}

#[tokio::test]
async fn a_signed_out_page_asks_for_sign_in() {
    let page = OutlookStandIn::start(OutlookConfig::default()).await;
    page.sign_out();
    assert_eq!(ask(&page, "account-address", json!({})).await["error"], "sign-in-needed");
}
