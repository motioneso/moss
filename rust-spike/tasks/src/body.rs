//! Request bodies and query strings, read the way Fastify 5.8.5 reads them.
//!
//! The TypeScript server's root context carries the default JSON and plain-text parsers plus three
//! that other modules register on the same instance: `application/octet-stream` and `audio/*` as
//! buffers, and bare `text/markdown` as a string. Tasks routes inherit all of them.

use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE, TRANSFER_ENCODING};
use axum::http::{HeaderMap, Method};
use serde_json::{Map, Value};

use crate::schema::{self, Schema};
use safety_core::error::ApiError;

/// Fastify's default `bodyLimit`.
pub const BODY_LIMIT: usize = 1_048_576;

/// A parsed body. `Undefined` is a request that carried none.
#[derive(Debug, PartialEq)]
pub enum Body {
    Undefined,
    Json(Value),
    Text(String),
    /// A Buffer. It passes an object type check and has no named properties, so it behaves as `{}`.
    Bytes,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Parser {
    Json,
    Text,
    Buffer,
}

fn unsupported() -> ApiError {
    ApiError::framework(415, "Unsupported Media Type")
}

/// Header bytes as Node sees them: one char per byte.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&byte| byte as char).collect()
}

fn is_js_space(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{feff}'
    )
}

fn is_token(text: &str, allow_trailing_space: bool) -> bool {
    let text = if allow_trailing_space {
        text.trim_end_matches(char::is_whitespace)
    } else {
        text
    };
    !text.is_empty()
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "_!#$%&'*+.^`|~-".contains(ch))
}

/// What the `ContentType` class keeps: the media type, and whether any parameter parsed.
struct ContentType {
    media_type: String,
    kind: String,
    has_params: bool,
}

fn parse_content_type(header: &str) -> Option<ContentType> {
    if header.is_empty() || header == "undefined" {
        return None;
    }
    let (media, params) = match header.find(';') {
        Some(semi) => (
            header[..semi].to_ascii_lowercase(),
            Some(header[semi + 1..].trim_matches(is_js_space)),
        ),
        None => (header.to_ascii_lowercase(), None),
    };
    let slash = media.find('/')?;
    let kind = media[..slash].trim_start_matches(is_js_space);
    let subtype = media[slash + 1..].trim_end_matches(is_js_space);
    if !is_token(kind, false) || !is_token(subtype, true) {
        return None;
    }
    // `(?:^|;)\s*(token)=([^;]*)`, global over the parameter text.
    let has_params = params.is_some_and(|text| {
        text.split(';').any(|piece| {
            let piece = piece.trim_start_matches(char::is_whitespace);
            piece
                .find('=')
                .is_some_and(|eq| is_token(&piece[..eq], false))
        })
    });
    Some(ContentType {
        media_type: format!("{kind}/{subtype}"),
        kind: kind.to_owned(),
        has_params,
    })
}

fn parser_for(header: &str) -> Option<Parser> {
    let content_type = parse_content_type(header)?;
    match content_type.media_type.as_str() {
        "application/json" => Some(Parser::Json),
        "text/plain" => Some(Parser::Text),
        "application/octet-stream" => Some(Parser::Buffer),
        _ if content_type.kind == "audio" => Some(Parser::Buffer),
        "text/markdown" if !content_type.has_params => Some(Parser::Text),
        _ => None,
    }
}

/// `handleRequest` plus `ContentTypeParser.run` and `rawBody`.
pub fn read_body(method: &Method, headers: &HeaderMap, bytes: &[u8]) -> Result<Body, ApiError> {
    if matches!(method.as_str(), "GET" | "HEAD" | "TRACE") {
        return Ok(Body::Undefined);
    }
    let content_type = headers
        .get(CONTENT_TYPE)
        .map(|value| latin1(value.as_bytes()));
    let content_length = headers
        .get(CONTENT_LENGTH)
        .map(|value| latin1(value.as_bytes()));
    let chunked = headers.contains_key(TRANSFER_ENCODING);

    let Some(content_type) = content_type else {
        if !chunked && content_length.as_deref().is_none_or(|length| length == "0") {
            return Ok(Body::Undefined);
        }
        return Err(unsupported());
    };
    if content_length.is_none() && !chunked && method == Method::OPTIONS {
        return Ok(Body::Undefined);
    }
    let parser = parser_for(&content_type).ok_or_else(unsupported)?;

    let declared: Option<usize> = content_length
        .as_deref()
        .and_then(|length| length.parse().ok());
    if declared.is_some_and(|length| length > BODY_LIMIT) {
        return Err(ApiError::framework(413, "Request body is too large"));
    }
    let mismatch = || ApiError::framework(400, "Request body size did not match Content-Length");
    if parser == Parser::Buffer {
        if bytes.len() > BODY_LIMIT {
            return Err(ApiError::framework(413, "Request body is too large"));
        }
        if declared.is_some_and(|length| length != bytes.len()) {
            return Err(mismatch());
        }
        return Ok(Body::Bytes);
    }

    // The stream decodes as UTF-8 and counts the bytes of the decoded text.
    let text = String::from_utf8_lossy(bytes).into_owned();
    if text.len() > BODY_LIMIT {
        return Err(ApiError::framework(413, "Request body is too large"));
    }
    if declared.is_some_and(|length| length != text.len()) {
        return Err(mismatch());
    }
    match parser {
        Parser::Text => Ok(Body::Text(text)),
        _ => parse_json(&text).map(Body::Json),
    }
}

/// The default JSON parser: `secure-json-parse` with prototype and constructor poisoning errors.
fn parse_json(text: &str) -> Result<Value, ApiError> {
    if text.is_empty() {
        return Err(ApiError::framework(
            400,
            "Body cannot be empty when content-type is set to 'application/json'",
        ));
    }
    let invalid = || {
        ApiError::framework(
            400,
            "Body is not valid JSON but content-type is set to 'application/json'",
        )
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let value: Value =
        serde_json::from_str(&replace_lone_surrogates(text)).map_err(|_| invalid())?;
    if is_poisoned(&value) {
        return Err(invalid());
    }
    Ok(value)
}

/// `JSON.parse` accepts lone surrogate escapes; the pg driver later stores each as U+FFFD.
fn replace_lone_surrogates(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains("\\u") && !text.contains("\\U") {
        return std::borrow::Cow::Borrowed(text);
    }
    let bytes = text.as_bytes();
    let escape_at = |index: usize| -> Option<u16> {
        let hex = text.get(index + 2..index + 6)?;
        (bytes.get(index) == Some(&b'\\') && bytes.get(index + 1) == Some(&b'u'))
            .then(|| u16::from_str_radix(hex, 16).ok())
            .flatten()
    };
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if !in_string {
            in_string = byte == b'"';
        } else if byte == b'"' {
            in_string = false;
        } else if byte == b'\\' {
            if let Some(unit) = escape_at(index) {
                let high = (0xD800..0xDC00).contains(&unit);
                let low_follows =
                    escape_at(index + 6).is_some_and(|next| (0xDC00..0xE000).contains(&next));
                if high && low_follows {
                    out.push_str(&text[index..index + 12]);
                    index += 12;
                    continue;
                }
                if (0xD800..0xE000).contains(&unit) {
                    out.push_str("\\ufffd");
                    index += 6;
                    continue;
                }
            }
            let end = index + 1 + bytes.get(index + 1).map_or(0, |_| 1);
            out.push_str(&text[index..end.min(bytes.len())]);
            index = end;
            continue;
        }
        let width = text[index..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&text[index..index + width]);
        index += width;
    }
    std::borrow::Cow::Owned(out)
}

/// An own `__proto__` key anywhere, or a `constructor` key whose value is null or an object with
/// its own `prototype` key (null makes `hasOwnProperty.call` throw, which also rejects the body).
fn is_poisoned(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.contains_key("__proto__")
                || match map.get("constructor") {
                    Some(Value::Null) => true,
                    Some(Value::Object(inner)) => inner.contains_key("prototype"),
                    _ => false,
                }
                || map.values().any(is_poisoned)
        }
        Value::Array(items) => items.iter().any(is_poisoned),
        _ => false,
    }
}

/// The body handed to the handler after schema validation (Fastify validates `undefined` as null).
pub fn validated(body: Body, schema: Option<&Schema>) -> Result<Value, ApiError> {
    let mut value = match body {
        Body::Undefined => Value::Null,
        Body::Json(value) => value,
        Body::Text(text) => Value::String(text),
        Body::Bytes => Value::Object(Map::new()),
    };
    if let Some(schema) = schema {
        schema::validate(schema, &mut value, "body")
            .map_err(|failure| ApiError::framework(400, failure.message))?;
    }
    Ok(value)
}

/// `fast-querystring`: `+` is a space, percent escapes decode as UTF-8 (raw text kept when any
/// escape is invalid), repeated keys collect into an array, a bare key maps to "".
pub fn parse_query(raw: Option<&str>) -> Map<String, Value> {
    let mut result = Map::new();
    let Some(raw) = raw else { return result };
    for part in raw.split('&') {
        let (key, value) = match part.split_once('=') {
            Some((key, value)) => (key, Some(value)),
            None if part.is_empty() => continue,
            None => (part, None),
        };
        let key = decode_component(key);
        let value = value.map(decode_component).unwrap_or_default();
        match result.get_mut(&key) {
            None => {
                result.insert(key, Value::String(value));
            }
            Some(Value::Array(items)) => items.push(Value::String(value)),
            Some(existing) => {
                let first = existing.take();
                *existing = Value::Array(vec![first, Value::String(value)]);
            }
        }
    }
    result
}

fn decode_component(text: &str) -> String {
    let text = text.replace('+', " ");
    if !text.contains('%') {
        return text;
    }
    percent_decode(&text).unwrap_or(text)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(
                u8::from_str_radix(hex, 16)
                    .ok()
                    .filter(|_| hex.bytes().all(|b| b.is_ascii_hexdigit()))?,
            );
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn post(pairs: &[(&'static str, &str)], body: &[u8]) -> Result<Body, ApiError> {
        read_body(&Method::POST, &headers(pairs), body)
    }

    fn error(result: Result<Body, ApiError>) -> (u16, Value) {
        result.expect_err("expected an error").status_and_body()
    }

    #[test]
    fn bodyless_requests() {
        assert_eq!(
            read_body(&Method::GET, &headers(&[("content-type", "x/y")]), b"{").unwrap(),
            Body::Undefined
        );
        assert_eq!(post(&[], b"").unwrap(), Body::Undefined);
        assert_eq!(
            post(&[("content-length", "0")], b"").unwrap(),
            Body::Undefined
        );
        assert_eq!(error(post(&[("content-length", "2")], b"{}")).0, 415);
        let options =
            read_body(&Method::OPTIONS, &headers(&[("content-type", "x/y")]), b"").unwrap();
        assert_eq!(options, Body::Undefined);
    }

    #[test]
    fn content_type_matching() {
        let json_body = |ct: &str| post(&[("content-type", ct)], b"{\"a\":1}");
        assert_eq!(
            json_body("application/json").unwrap(),
            Body::Json(json!({"a": 1}))
        );
        assert_eq!(
            json_body("Application/JSON; charset=utf-8").unwrap(),
            Body::Json(json!({"a": 1}))
        );
        assert_eq!(
            json_body("application/json ;x").unwrap(),
            Body::Json(json!({"a": 1}))
        );
        assert_eq!(error(json_body("application/json-patch+json")).0, 415);
        assert_eq!(error(json_body("application /json")).0, 415);
        assert_eq!(error(json_body("json")).0, 415);
        assert_eq!(
            json_body("text/plain").unwrap(),
            Body::Text("{\"a\":1}".into())
        );
        assert_eq!(
            json_body("text/markdown").unwrap(),
            Body::Text("{\"a\":1}".into())
        );
        assert_eq!(
            json_body("text/markdown;").unwrap(),
            Body::Text("{\"a\":1}".into())
        );
        assert_eq!(error(json_body("text/markdown; charset=utf-8")).0, 415);
        assert_eq!(json_body("audio/wav").unwrap(), Body::Bytes);
        assert_eq!(json_body("application/octet-stream").unwrap(), Body::Bytes);
    }

    #[test]
    fn json_errors_match_fastify() {
        let ct = [("content-type", "application/json")];
        assert_eq!(
            error(post(&ct, b"")).1,
            json!({"error": "Body cannot be empty when content-type is set to 'application/json'"})
        );
        let invalid = json!({"error": "Body is not valid JSON but content-type is set to 'application/json'"});
        assert_eq!(error(post(&ct, b"{")).1, invalid);
        assert_eq!(error(post(&ct, br#"{"a":{"__proto__":1}}"#)).1, invalid);
        assert_eq!(
            error(post(&ct, br#"[{"constructor":{"prototype":{}}}]"#)).1,
            invalid
        );
        assert_eq!(error(post(&ct, br#"{"constructor":null}"#)).1, invalid);
        assert_eq!(
            post(&ct, br#"{"constructor":"x"}"#).unwrap(),
            Body::Json(json!({"constructor": "x"}))
        );
        assert_eq!(
            post(&ct, "\u{feff}{}".as_bytes()).unwrap(),
            Body::Json(json!({}))
        );
        assert_eq!(
            post(&ct, br#"{"t":"\ud800x"}"#).unwrap(),
            Body::Json(json!({"t": "\u{fffd}x"}))
        );
        assert_eq!(
            post(&ct, r#"{"t":"😀"}"#.as_bytes()).unwrap(),
            Body::Json(json!({"t": "\u{1f600}"}))
        );
    }

    #[test]
    fn length_checks_count_decoded_bytes() {
        let ct = ("content-type", "text/plain");
        assert_eq!(error(post(&[ct, ("content-length", "1")], b"\xff")).0, 400);
        assert_eq!(
            post(&[ct, ("content-length", "4")], b"\xf0\x90\x80A").unwrap(),
            Body::Text("\u{fffd}A".into())
        );
        assert_eq!(
            error(post(&[ct, ("content-length", "2000000")], b"")).0,
            413
        );
    }

    #[test]
    fn validation_sees_undefined_as_null() {
        let schema = crate::schemas::delete_list();
        let (status, body) = validated(Body::Undefined, Some(&schema))
            .unwrap_err()
            .status_and_body();
        assert_eq!(
            (status, body),
            (400, json!({"error": "body must be object"}))
        );
        assert_eq!(validated(Body::Bytes, Some(&schema)).unwrap(), json!({}));
    }

    #[test]
    fn query_strings() {
        let query = parse_query(Some("a=1&a=2&b&c=x+y%21&d=%zz+&=e&&"));
        assert_eq!(
            Value::Object(query),
            json!({"a": ["1", "2"], "b": "", "c": "x y!", "d": "%zz ", "": "e"})
        );
    }
}
