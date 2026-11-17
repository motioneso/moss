//! Capture preferences. Values live in the account preference store under fixed keys, reached
//! only through the trusted `meetings.preferences` host resource. A read never creates a default
//! and never substitutes a recording source.
use crate::schema::Failure;
use crate::text::{is_uuid, js_trim};
use moss_module_sdk::{Host, Response, Result};
use serde_json::{json, Map, Value};

pub const RESOURCE: &str = "meetings.preferences";
pub const KEY_MODE: &str = "meetings.capture.default-mode";
pub const KEY_SOURCE: &str = "meetings.capture.remembered-source";
pub const KEY_SUMMARIZE: &str = "meetings.summarize-on-stop";
pub const KEY_TEMPLATE: &str = "meetings.summary-template";
pub const KEY_LANGUAGE: &str = "meetings.transcript-language";
pub const KEY_VOCABULARY: &str = "meetings.transcript-vocabulary";
pub const KEYS: [&str; 6] = [KEY_MODE, KEY_SOURCE, KEY_SUMMARIZE, KEY_TEMPLATE, KEY_LANGUAGE, KEY_VOCABULARY];

const MODES: [&str; 3] = ["microphone-only", "selected-app", "computer-audio"];
const TEMPLATES: [&str; 4] = ["general", "one-to-one", "project-review", "interview"];
const MAX_TERMS: usize = 20;
const MAX_PROMPT_BYTES: usize = 200;

/// ISO 639-1 input language codes, the same list the old app accepts.
const LANGUAGES: &str = "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs \
ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy \
ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu \
ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv \
mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny \
oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw \
ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu";

pub fn is_language(value: &str) -> bool {
    LANGUAGES.split_whitespace().any(|code| code == value)
}
fn mode(value: &Value) -> Option<&'static str> {
    MODES.iter().copied().find(|m| value.as_str() == Some(m))
}

#[derive(Debug, PartialEq)]
pub struct VocabularyError;

fn invalid_character(c: char) -> bool {
    c.is_control() || c == '\u{2028}' || c == '\u{2029}'
}

/// Trims, drops blanks and repeats, and keeps the whole list within the speech hint limits.
pub fn normalize_vocabulary(value: &Value) -> std::result::Result<Vec<String>, VocabularyError> {
    let items = value.as_array().filter(|a| a.len() <= 100).ok_or(VocabularyError)?;
    let mut terms: Vec<String> = Vec::new();
    for item in items {
        let text = item.as_str().ok_or(VocabularyError)?;
        if text.encode_utf16().count() > 1000 {
            return Err(VocabularyError);
        }
        let term = js_trim(text);
        if term.chars().any(invalid_character) {
            return Err(VocabularyError);
        }
        if !term.is_empty() && !terms.iter().any(|t| t == term) {
            terms.push(term.to_owned());
        }
    }
    if terms.len() > MAX_TERMS || (!terms.is_empty() && terms.join(", ").len() > MAX_PROMPT_BYTES) {
        return Err(VocabularyError);
    }
    Ok(terms)
}

/// Vocabulary needs a language, as the old app required.
fn transcription_options(language: &Value, vocabulary: &[String]) -> std::result::Result<(), VocabularyError> {
    if !vocabulary.is_empty() && language.is_null() {
        return Err(VocabularyError);
    }
    Ok(())
}

fn remembered_source(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let device = source.get("deviceId")?.as_str()?;
    let microphone = source.get("microphoneId")?.as_str()?;
    let mode = mode(source.get("mode")?)?;
    let app = source.get("applicationId");
    if mode == "selected-app" && !app.is_some_and(Value::is_string) {
        return None;
    }
    let mut out = Map::new();
    out.insert("deviceId".into(), json!(device));
    out.insert("microphoneId".into(), json!(microphone));
    out.insert("mode".into(), json!(mode));
    if let Some(app) = app.and_then(Value::as_str).filter(|a| !a.is_empty()) {
        out.insert("applicationId".into(), json!(app));
    }
    Some(Value::Object(out))
}

/// Reads the saved values and fills documented defaults for display only.
pub fn current(host: &(impl Host + ?Sized)) -> Result<Value> {
    let saved = host.call("kv", "get", RESOURCE, json!({}))?;
    let get = |key: &str| saved.get(key).cloned().unwrap_or(Value::Null);
    let source = remembered_source(&get(KEY_SOURCE));
    let vocabulary = match saved.get(KEY_VOCABULARY) {
        Some(value) => normalize_vocabulary(value)
            .map_err(|_| moss_module_sdk::Error::new("Saved vocabulary is invalid"))?,
        None => Vec::new(),
    };
    let language = get(KEY_LANGUAGE);
    let default_mode = mode(&get(KEY_MODE))
        .or_else(|| source.as_ref().and_then(|s| mode(&s["mode"])))
        .unwrap_or("computer-audio");
    let template = get(KEY_TEMPLATE);
    Ok(json!({
        "transcriptVocabulary": vocabulary,
        "transcriptLanguage": if language.as_str().is_some_and(is_language) { language } else { Value::Null },
        "rememberedSource": source,
        "defaultCaptureMode": default_mode,
        "summarizeOnStop": get(KEY_SUMMARIZE).as_bool().unwrap_or(true),
        "summaryTemplateId": template.as_str().filter(|t| TEMPLATES.contains(t)).unwrap_or("general"),
    }))
}

pub fn get(host: &(impl Host + ?Sized)) -> Result<Response> {
    Ok(Response::new(200, current(host)?))
}

fn enum_failure(at: &str, null_allowed: bool) -> Failure {
    if null_allowed {
        format!("{at} must be equal to constant, {at} must be equal to one of the allowed values, {at} must match a schema in anyOf")
    } else {
        format!("{at} must be equal to one of the allowed values")
    }
}

/// Body checks in schema order, with Ajv's wording and no coercion.
fn check_body(body: &Value) -> std::result::Result<(), Failure> {
    let map = body.as_object().ok_or("body must be object")?;
    if map.is_empty() {
        return Err("body must NOT have fewer than 1 items".into());
    }
    const ALLOWED: [&str; 6] = [
        "transcriptVocabulary", "transcriptLanguage", "rememberedSource",
        "defaultCaptureMode", "summarizeOnStop", "summaryTemplateId",
    ];
    if map.keys().any(|k| !ALLOWED.contains(&k.as_str())) {
        return Err("body must NOT have additional properties".into());
    }
    if let Some(value) = map.get("transcriptVocabulary") {
        let items = value.as_array().ok_or("body/transcriptVocabulary must be array")?;
        if items.len() > 100 {
            return Err("body/transcriptVocabulary must NOT have more than 100 items".into());
        }
        for (i, item) in items.iter().enumerate() {
            let at = format!("body/transcriptVocabulary/{i}");
            let text = item.as_str().ok_or(format!("{at} must be string"))?;
            if text.chars().count() > 1000 {
                return Err(format!("{at} must NOT have more than 1000 characters"));
            }
        }
    }
    if let Some(value) = map.get("transcriptLanguage") {
        if !value.is_null() && !value.as_str().is_some_and(is_language) {
            return Err(enum_failure("body/transcriptLanguage", true));
        }
    }
    if let Some(value) = map.get("rememberedSource") {
        check_source(value)?;
    }
    if let Some(value) = map.get("defaultCaptureMode") {
        if !value.is_null() && mode(value).is_none() {
            return Err(enum_failure("body/defaultCaptureMode", true));
        }
    }
    if let Some(value) = map.get("summarizeOnStop") {
        if !value.is_boolean() {
            return Err("body/summarizeOnStop must be boolean".into());
        }
    }
    if let Some(value) = map.get("summaryTemplateId") {
        let text = value.as_str().ok_or("body/summaryTemplateId must be string")?;
        if !TEMPLATES.contains(&text) {
            return Err(enum_failure("body/summaryTemplateId", false));
        }
    }
    Ok(())
}

fn check_source(value: &Value) -> std::result::Result<(), Failure> {
    const AT: &str = "body/rememberedSource";
    if value.is_null() {
        return Ok(());
    }
    let map = value.as_object().ok_or(format!("{AT} must be object"))?;
    for name in ["deviceId", "microphoneId", "mode"] {
        if !map.contains_key(name) {
            return Err(format!("{AT} must have required property '{name}'"));
        }
    }
    if map.keys().any(|k| !["deviceId", "microphoneId", "applicationId", "mode"].contains(&k.as_str())) {
        return Err(format!("{AT} must NOT have additional properties"));
    }
    let device = map["deviceId"].as_str().ok_or(format!("{AT}/deviceId must be string"))?;
    if !is_uuid(device) {
        return Err(format!("{AT}/deviceId must match format \"uuid\""));
    }
    for name in ["microphoneId", "applicationId"] {
        if let Some(value) = map.get(name) {
            let text = value.as_str().ok_or(format!("{AT}/{name} must be string"))?;
            let n = text.chars().count();
            if n > 256 {
                return Err(format!("{AT}/{name} must NOT have more than 256 characters"));
            }
            if n < 1 {
                return Err(format!("{AT}/{name} must NOT have fewer than 1 characters"));
            }
        }
    }
    if mode(&map["mode"]).is_none() {
        return Err(format!("{AT}/mode must be equal to one of the allowed values"));
    }
    Ok(())
}

fn code(code: &str) -> Response {
    Response::new(400, json!({"code":code}))
}

pub fn put(host: &(impl Host + ?Sized), body: &Value) -> Result<Response> {
    if let Err(failure) = check_body(body) {
        return Ok(Response::new(400, json!({"error":failure})));
    }
    // The lock serializes concurrent saves for this account until the call ends.
    host.call("kv", "lock", RESOURCE, json!({}))?;
    let now = current(host)?;
    let input = body.as_object().expect("checked object");
    let source = match input.get("rememberedSource") {
        None => now["rememberedSource"].clone(),
        Some(value) => remembered_source(value).unwrap_or(Value::Null),
    };
    if input.get("rememberedSource").is_some_and(|v| !v.is_null()) && source.is_null() {
        return Ok(code("meeting_capture_invalid_input"));
    }
    let vocabulary = match input.get("transcriptVocabulary") {
        None => now["transcriptVocabulary"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        Some(value) => match normalize_vocabulary(value) {
            Ok(terms) => terms,
            Err(_) => return Ok(code("meeting_vocabulary_invalid")),
        },
    };
    let language = input.get("transcriptLanguage").cloned().unwrap_or_else(|| now["transcriptLanguage"].clone());
    let default_mode = match input.get("defaultCaptureMode") {
        None => now["defaultCaptureMode"].clone(),
        Some(value) if !value.is_null() => value.clone(),
        Some(_) => source.get("mode").cloned().unwrap_or(json!("computer-audio")),
    };
    let next = json!({
        "transcriptVocabulary": vocabulary,
        "transcriptLanguage": language,
        "rememberedSource": source,
        "defaultCaptureMode": default_mode,
        "summarizeOnStop": input.get("summarizeOnStop").cloned().unwrap_or_else(|| now["summarizeOnStop"].clone()),
        "summaryTemplateId": input.get("summaryTemplateId").cloned().unwrap_or_else(|| now["summaryTemplateId"].clone()),
    });
    if transcription_options(&next["transcriptLanguage"], &vocabulary).is_err() {
        return Ok(code("meeting_vocabulary_invalid"));
    }
    let mut writes = Map::new();
    let stored = [
        ("transcriptVocabulary", KEY_VOCABULARY),
        ("transcriptLanguage", KEY_LANGUAGE),
        ("defaultCaptureMode", KEY_MODE),
        ("rememberedSource", KEY_SOURCE),
        ("summarizeOnStop", KEY_SUMMARIZE),
        ("summaryTemplateId", KEY_TEMPLATE),
    ];
    for (field, key) in stored {
        if input.contains_key(field) {
            writes.insert(key.to_owned(), next[field].clone());
        }
    }
    host.call("kv", "set", RESOURCE, json!({"writes":writes}))?;
    Ok(Response::new(200, next))
}

/// Body fields the preferences route accepts.
pub const FIELDS: [&str; 6] = [
    "transcriptVocabulary", "transcriptLanguage", "rememberedSource",
    "defaultCaptureMode", "summarizeOnStop", "summaryTemplateId",
];
