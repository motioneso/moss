mod common;
use common::Fake;
use moss_web_research_module::gate::{decide, Engine, Reason};
use serde_json::json;

#[test]
fn saved_key_wins_whatever_else_is_set() {
    for native in [true, false] {
        for model in [None, Some(false), Some(true)] {
            assert_eq!(decide(true, native, model), Engine::Brave);
        }
    }
}

#[test]
fn switch_off_blocks_even_a_searching_model() {
    assert_eq!(
        decide(false, false, Some(true)),
        Engine::None(Reason::NativeDisabled)
    );
    assert_eq!(
        decide(false, false, None),
        Engine::None(Reason::NativeDisabled)
    );
}

#[test]
fn model_decides_when_there_is_no_key_and_the_switch_is_on() {
    assert_eq!(
        decide(false, true, None),
        Engine::None(Reason::NoKeyNoNativeModel)
    );
    assert_eq!(
        decide(false, true, Some(false)),
        Engine::None(Reason::ModelHasNoSearch)
    );
    assert_eq!(decide(false, true, Some(true)), Engine::ModelNative);
}

#[test]
fn reason_words_match_what_news_already_shows() {
    assert_eq!(
        Reason::NoKeyNoNativeModel.as_str(),
        "no-key-no-native-model"
    );
    assert_eq!(Reason::NativeDisabled.as_str(), "native-disabled");
    assert_eq!(Reason::ModelHasNoSearch.as_str(), "model-has-no-search");
}

#[test]
fn status_route_reads_the_host_and_defaults_the_switch_on() {
    let host = Fake::new();
    *host.model.borrow_mut() = Some(true);
    let (status, body) = host.route("GET", "/status");
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({"webSearchConfigured": true, "engine": "model-native", "webSearchReason": null})
    );

    *host.model.borrow_mut() = None;
    assert_eq!(
        host.route("GET", "/status").1["webSearchReason"],
        "no-key-no-native-model"
    );
    *host.native.borrow_mut() = Some(false);
    assert_eq!(
        host.route("GET", "/status").1["webSearchReason"],
        "native-disabled"
    );
    *host.model.borrow_mut() = Some(false);
    *host.native.borrow_mut() = Some(true);
    assert_eq!(
        host.route("GET", "/status").1["webSearchReason"],
        "model-has-no-search"
    );
    assert_eq!(host.route("POST", "/status").0, 404);
}

#[test]
fn saved_key_reports_brave() {
    let host = Fake::new().with_key();
    let body = host.route("GET", "/status").1;
    assert_eq!(
        body,
        json!({"webSearchConfigured": true, "engine": "brave", "webSearchReason": null})
    );
}

#[test]
fn unreadable_host_answers_never_count_as_available() {
    struct Broken;
    impl moss_module_sdk::Host for Broken {
        fn call(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: serde_json::Value,
        ) -> moss_module_sdk::Result<serde_json::Value> {
            Err(moss_module_sdk::Error::new("down"))
        }
    }
    assert_eq!(
        moss_web_research_module::gate::current(&Broken),
        Engine::None(Reason::NoKeyNoNativeModel)
    );
}

#[test]
fn news_api_calls_get_the_same_status() {
    let host = Fake::new();
    *host.model.borrow_mut() = Some(false);
    let reply = host.api("webSearchStatus", json!({}));
    assert_eq!(reply["data"]["webSearchReason"], "model-has-no-search");
}
