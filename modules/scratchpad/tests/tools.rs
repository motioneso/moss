mod common;
mod conformance;
use common::Fake;
use moss_scratchpad_module::handle;
use serde_json::Value;

#[test]
fn native_chat_contract() {
    let host = Fake::default();
    conformance::check(|kind, input| {
        serde_json::from_str::<Value>(&handle(&host, kind, &input.to_string()).unwrap()).unwrap()
    });
}
