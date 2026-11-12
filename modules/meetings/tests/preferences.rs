//! Capture preferences. Reads never create or substitute anything; saves touch only the keys sent.
mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const DEVICE: &str = "44444444-4444-4444-8444-444444444444";

fn get(f: &Fake) -> Value {
    let (status, body) = f.route("GET", "/preferences", &[], Value::Null);
    assert_eq!(status, 200);
    body
}
fn put(f: &Fake, body: Value) -> (u16, Value) {
    f.route("PUT", "/preferences", &[], body)
}

#[test]
fn reading_shows_defaults_without_saving_any() {
    let f = Fake::new();
    let body = get(&f);
    assert_eq!(
        body,
        json!({"transcriptVocabulary":[],"transcriptLanguage":null,"rememberedSource":null,
               "defaultCaptureMode":"computer-audio","summarizeOnStop":true,"summaryTemplateId":"general"})
    );
    assert!(f.prefs.borrow().is_empty(), "a read created a preference row");
    assert!(!f.calls.borrow().iter().any(|c| c.starts_with("kv.set")));
}

#[test]
fn a_save_writes_only_the_keys_it_was_given() {
    let f = Fake::new();
    let (status, body) = put(&f, json!({"summarizeOnStop":false}));
    assert_eq!(status, 200);
    assert_eq!(body["summarizeOnStop"], false);
    let saved = f.prefs.borrow()[A].clone();
    assert_eq!(saved.keys().collect::<Vec<_>>(), vec!["meetings.summarize-on-stop"]);
    assert_eq!(get(&f)["summarizeOnStop"], false);
    assert_eq!(f.calls.borrow().iter().filter(|c| c.starts_with("kv.lock")).count(), 1);
}

#[test]
fn language_vocabulary_and_style_round_trip() {
    let f = Fake::new();
    let (status, body) = put(
        &f,
        json!({"transcriptLanguage":"en","transcriptVocabulary":["  Moss ","Moss","Rust",""],
               "summaryTemplateId":"interview","defaultCaptureMode":"microphone-only"}),
    );
    assert_eq!(status, 200);
    assert_eq!(body["transcriptVocabulary"], json!(["Moss","Rust"]));
    assert_eq!(body["transcriptLanguage"], "en");
    let now = get(&f);
    assert_eq!(now["summaryTemplateId"], "interview");
    assert_eq!(now["defaultCaptureMode"], "microphone-only");
}

#[test]
fn bad_input_is_refused_with_the_old_codes_and_saves_nothing() {
    let f = Fake::new();
    // Vocabulary needs a language.
    assert_eq!(put(&f, json!({"transcriptVocabulary":["Moss"]})), (400, json!({"code":"meeting_vocabulary_invalid"})));
    assert_eq!(
        put(&f, json!({"transcriptLanguage":"en","transcriptVocabulary":["bad\u{0007}term"]})),
        (400, json!({"code":"meeting_vocabulary_invalid"}))
    );
    let too_many: Vec<String> = (0..21).map(|n| format!("t{n}")).collect();
    assert_eq!(
        put(&f, json!({"transcriptLanguage":"en","transcriptVocabulary":too_many})).1,
        json!({"code":"meeting_vocabulary_invalid"})
    );
    assert_eq!(put(&f, json!({"rememberedSource":{"deviceId":DEVICE,"microphoneId":"mic","mode":"selected-app"}})).0, 400);
    assert_eq!(put(&f, json!({"transcriptLanguage":"xx"})).0, 400);
    assert_eq!(put(&f, json!({"summaryTemplateId":"other"})).0, 400);
    assert_eq!(put(&f, json!({"unknown":1})).0, 400);
    assert_eq!(put(&f, json!({})).0, 400);
    assert!(f.prefs.borrow().is_empty());
}

#[test]
fn a_remembered_source_saves_and_clears() {
    let f = Fake::new();
    let source = json!({"deviceId":DEVICE,"microphoneId":"mic-1","mode":"selected-app","applicationId":"app-1"});
    let (status, body) = put(&f, json!({"rememberedSource":source}));
    assert_eq!(status, 200);
    assert_eq!(body["rememberedSource"], source);
    let (status, body) = put(&f, json!({"rememberedSource":null}));
    assert_eq!((status, body["rememberedSource"].clone()), (200, Value::Null));
}

#[test]
fn preferences_belong_to_one_account() {
    let f = Fake::new();
    assert_eq!(put(&f, json!({"summarizeOnStop":false})).0, 200);
    f.as_actor(B);
    assert_eq!(get(&f)["summarizeOnStop"], true);
    assert_eq!(put(&f, json!({"summaryTemplateId":"interview"})).0, 200);
    f.as_actor(A);
    let mine = get(&f);
    assert_eq!(mine["summarizeOnStop"], false);
    assert_eq!(mine["summaryTemplateId"], "general");
}
