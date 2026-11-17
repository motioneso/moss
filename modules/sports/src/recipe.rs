//! The declarative recipe for a site that publishes no feed. A recipe names one request shape
//! and one way to pull headlines out of the answer. It never runs code. This file holds the strict
//! check, the request expansion, the headline extraction and the fingerprint, all pure.
use crate::source_web::{lean_html, resolve, sha256_hex};
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use moss_news_reader::publisher_identity;
use moss_news_reader::url::Url;
use scraper::{Html, Selector};
use serde_json::Value;

pub const VERSION: u64 = 1;
const MAX_HTML_BYTES: usize = 2_000_000;
const MAX_HTML_NODES: usize = 10_000;
const HEADLINE_CAP: usize = 300;
const URL_CAP: usize = 2048;
const JSON_ACCEPT: &str = "application/json";
const HTML_ACCEPT: &str = "text/html,application/xhtml+xml";

/// One headline pulled from a publisher answer.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub headline: String,
    pub url: Option<String>,
    pub published_at: Option<String>,
}

/// Why a read produced nothing usable.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Reason {
    /// The answer was the wrong kind of document.
    Unsupported,
    /// The page layout no longer matches the recipe.
    Drift,
}

#[derive(Clone, Debug)]
pub struct Slot {
    pub name: String,
    pub location: String,
    pub max_length: usize,
}

/// A recipe that passed the strict check. `value` is the exact accepted JSON.
#[derive(Clone, Debug)]
pub struct Recipe {
    pub value: Value,
    pub kind: Kind,
    pub fetch_hosts: Vec<String>,
    pub url_template: String,
    pub slots: Vec<Slot>,
    pub item_limit: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Json,
    Html,
}

fn only_keys(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|k| allowed.contains(&k.as_str()))
}

fn text<'a>(value: &'a Value, min: usize, max: usize) -> Option<&'a str> {
    let s = value.as_str()?;
    let n = s.chars().count();
    (n >= min && n <= max).then_some(s)
}

fn path_ok(value: &Value) -> bool {
    let Some(list) = value.as_array() else { return false };
    !list.is_empty()
        && list.len() <= 8
        && list.iter().all(|p| text(p, 1, 64).is_some_and(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')))
}

fn normalize_ok(value: &Value) -> bool {
    let Some(list) = value.as_array() else { return false };
    list.len() <= 4 && list.iter().all(|v| matches!(v.as_str(), Some("trim" | "collapse_whitespace" | "strip_controls")))
}

fn field_ok(value: &Value) -> bool {
    let Some(o) = value.as_object() else { return false };
    if o.get("selector").and_then(|v| text(v, 1, 256)).is_none() {
        return false;
    }
    match o.get("source").and_then(Value::as_str) {
        Some("text") => only_keys(o, &["selector", "source"]),
        Some("attribute") => only_keys(o, &["selector", "source", "attribute"]) && matches!(o.get("attribute").and_then(Value::as_str), Some("href" | "datetime" | "content")),
        _ => false,
    }
}

fn host_ok(host: &str) -> bool {
    let b = host.as_bytes();
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 253 && edge(b[0]) && edge(b[b.len() - 1]) && b.iter().all(|c| edge(*c) || *c == b'.' || *c == b'-')
}

fn unique<T: PartialEq>(list: &[T]) -> bool {
    list.iter().enumerate().all(|(i, a)| !list[..i].contains(a))
}

fn slot_ok(value: &Value) -> Option<Slot> {
    let o = value.as_object()?;
    if !only_keys(o, &["name", "location", "encoding", "maxLength"]) {
        return None;
    }
    let name = text(o.get("name")?, 1, 32)?;
    let mut chars = name.chars();
    if !chars.next()?.is_ascii_alphabetic() || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let location = o.get("location")?.as_str()?;
    let encoding = o.get("encoding")?.as_str()?;
    if !matches!((location, encoding), ("path", "path_segment") | ("query", "query_value")) {
        return None;
    }
    let max = o.get("maxLength")?.as_u64().filter(|m| (1..=128).contains(m))?;
    Some(Slot { name: name.to_owned(), location: location.to_owned(), max_length: max as usize })
}

fn placeholders(template: &str) -> Option<Vec<String>> {
    let mut found = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let close = after.find('}')?;
        let name = &after[..close];
        if name.is_empty() || name.contains('{') {
            return None;
        }
        found.push(name.to_owned());
        rest = &after[close + 1..];
    }
    if rest.contains('}') {
        return None;
    }
    Some(found)
}

fn compiles(selector: &str) -> bool {
    Selector::parse(selector).is_ok()
}

/// The strict check. A reply that fails any rule is refused whole. The fetch hosts must all
/// belong to one publisher and must include the host of the request.
pub fn validate(value: &Value) -> Option<Recipe> {
    let o = value.as_object()?;
    if !only_keys(o, &["version", "kind", "fetchHosts", "request", "scopes", "itemLimit", "extraction"]) {
        return None;
    }
    if o.get("version").and_then(Value::as_u64) != Some(VERSION) {
        return None;
    }
    let kind = match o.get("kind").and_then(Value::as_str)? {
        "json" => Kind::Json,
        "html" => Kind::Html,
        _ => return None,
    };
    let hosts: Vec<String> = o.get("fetchHosts")?.as_array()?.iter().map(|h| h.as_str().map(str::to_owned)).collect::<Option<_>>()?;
    if hosts.is_empty() || hosts.len() > 6 || !unique(&hosts) || !hosts.iter().all(|h| host_ok(h)) {
        return None;
    }
    let scopes: Vec<&str> = o.get("scopes")?.as_array()?.iter().map(Value::as_str).collect::<Option<_>>()?;
    if scopes.is_empty() || scopes.len() > 3 || !unique(&scopes) || !scopes.iter().all(|s| matches!(*s, "sport" | "team" | "competition")) {
        return None;
    }
    let item_limit = o.get("itemLimit")?.as_u64().filter(|n| (1..=50).contains(n))? as usize;
    let request = o.get("request")?.as_object()?;
    if !only_keys(request, &["urlTemplate", "slots", "headers"]) {
        return None;
    }
    let template = text(request.get("urlTemplate")?, 1, 4096)?.to_owned();
    let slot_values = request.get("slots")?.as_array()?;
    if slot_values.len() > 8 {
        return None;
    }
    let slots: Vec<Slot> = slot_values.iter().map(slot_ok).collect::<Option<_>>()?;
    let headers = request.get("headers")?.as_object()?;
    if !only_keys(headers, &["accept", "accept-language"]) {
        return None;
    }
    let accept = headers.get("accept")?.as_str()?;
    if accept != if kind == Kind::Json { JSON_ACCEPT } else { HTML_ACCEPT } {
        return None;
    }
    if headers.get("accept-language").is_some_and(|v| v.as_str() != Some("en-US,en;q=0.5")) {
        return None;
    }
    let extraction = o.get("extraction")?.as_object()?;
    if !normalize_ok(extraction.get("normalize")?) {
        return None;
    }
    match kind {
        Kind::Json => {
            if !only_keys(extraction, &["itemsPath", "headlinePath", "urlPath", "publishedAtPath", "normalize"])
                || !path_ok(extraction.get("itemsPath")?)
                || !path_ok(extraction.get("headlinePath")?)
                || extraction.get("urlPath").is_some_and(|v| !path_ok(v))
                || extraction.get("publishedAtPath").is_some_and(|v| !path_ok(v))
            {
                return None;
            }
        }
        Kind::Html => {
            if !only_keys(extraction, &["collectionSelector", "itemSelector", "headline", "url", "publishedAt", "normalize"])
                || !field_ok(extraction.get("headline")?)
                || extraction.get("url").is_some_and(|v| !field_ok(v))
                || extraction.get("publishedAt").is_some_and(|v| !field_ok(v))
            {
                return None;
            }
            let selectors = [extraction.get("collectionSelector")?, extraction.get("itemSelector")?];
            if !selectors.iter().all(|s| text(s, 1, 256).is_some_and(compiles)) {
                return None;
            }
            for key in ["headline", "url", "publishedAt"] {
                if let Some(f) = extraction.get(key) {
                    if !f["selector"].as_str().is_some_and(compiles) {
                        return None;
                    }
                }
            }
        }
    }
    // Meaning checks the shape alone cannot express.
    let marks = placeholders(&template)?;
    let names: Vec<&String> = slots.iter().map(|s| &s.name).collect();
    if !unique(&names) || marks.len() != slots.len() || !marks.iter().all(|m| names.contains(&m)) {
        return None;
    }
    let query_at = template.find('?');
    for slot in &slots {
        if marks.iter().filter(|m| **m == slot.name).count() != 1 {
            return None;
        }
        let at = template.find(&format!("{{{}}}", slot.name))?;
        let in_path = query_at.is_none_or(|q| at < q);
        if (slot.location == "path") != in_path {
            return None;
        }
    }
    let mut plain = template.clone();
    for slot in &slots {
        plain = plain.replace(&format!("{{{}}}", slot.name), "slot");
    }
    let url = Url::parse(&plain)?;
    let host = url.hostname.to_lowercase();
    let identity = publisher_identity(&host)?;
    if !url.https
        || !url.username.is_empty()
        || !url.password.is_empty()
        || url.port.is_some()
        || !url.hash.is_empty()
        || !hosts.contains(&host)
        || !hosts.iter().all(|h| publisher_identity(h).as_deref() == Some(identity.as_str()))
    {
        return None;
    }
    Some(Recipe { value: value.clone(), kind, fetch_hosts: hosts, url_template: template, slots, item_limit })
}

fn canonical(value: &Value, out: &mut String) {
    match value {
        Value::Array(list) => {
            out.push('[');
            for (i, v) in list.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(v, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                canonical(&map[*k], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Fingerprint of the accepted recipe: sha256 of its canonical JSON.
pub fn fingerprint(recipe: &Recipe) -> String {
    let mut out = String::new();
    canonical(&recipe.value, &mut out);
    sha256_hex(out.as_bytes())
}

fn encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The request for one set of parameters. The parameters must name exactly the slots, and every
/// value must be short and plain.
pub fn expand(recipe: &Recipe, parameters: &Value) -> Option<String> {
    let given = parameters.as_object()?;
    if given.len() != recipe.slots.len() {
        return None;
    }
    let mut url = recipe.url_template.clone();
    for slot in &recipe.slots {
        let value = given.get(&slot.name)?.as_str()?;
        let n = value.chars().count();
        if n < 1 || n > slot.max_length || value.chars().all(|c| c == '.') || !value.chars().all(|c| c.is_ascii_alphanumeric() || "._~ -".contains(c)) {
            return None;
        }
        url = url.replace(&format!("{{{}}}", slot.name), &encode(value));
    }
    Some(url)
}

fn normalized(value: &Value, ops: &[&str], cap: usize) -> Option<String> {
    let mut s = value.as_str()?.to_owned();
    for op in ops {
        match *op {
            "trim" => s = s.trim().to_owned(),
            "collapse_whitespace" => s = s.split_whitespace().collect::<Vec<_>>().join(" "),
            "strip_controls" => s = s.chars().filter(|c| (*c as u32) >= 32 && *c as u32 != 127).collect(),
            _ => {}
        }
    }
    let cut: String = s.chars().take(cap).collect();
    (!cut.is_empty()).then_some(cut)
}

fn safe_url(raw: &str, request_url: &str) -> Option<String> {
    if raw.len() > URL_CAP {
        return None;
    }
    let base = Url::parse(request_url)?;
    let url = if raw.starts_with("http://") || raw.starts_with("https://") { Url::parse(raw)? } else { resolve(raw, &base)? };
    (url.https && url.username.is_empty() && url.password.is_empty()).then_some(url.href)
}

fn iso_date(value: &Value) -> Option<String> {
    let at: DateTime<Utc> = match value {
        Value::Number(n) => Utc.timestamp_millis_opt(n.as_i64()?).single()?,
        Value::String(s) => {
            let s = s.trim();
            DateTime::parse_from_rfc3339(s).or_else(|_| DateTime::parse_from_rfc2822(s)).ok()?.with_timezone(&Utc)
        }
        _ => return None,
    };
    Some(at.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn ops(recipe: &Recipe) -> Vec<&str> {
    recipe.value["extraction"]["normalize"].as_array().map(|l| l.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

fn at_path<'a>(root: &'a Value, path: &Value) -> Option<&'a Value> {
    let mut current = root;
    for key in path.as_array()? {
        current = current.as_object()?.get(key.as_str()?)?;
    }
    Some(current)
}

fn media_ok(content_type: Option<&str>, accepted: &[&str]) -> bool {
    let lower = content_type.unwrap_or_default().to_lowercase();
    accepted.iter().any(|a| lower.contains(a))
}

fn extract_json(recipe: &Recipe, body: &str, request_url: &str) -> Result<Vec<Item>, Reason> {
    let parsed: Value = serde_json::from_str(body).map_err(|_| Reason::Unsupported)?;
    let e = &recipe.value["extraction"];
    let Some(collection) = at_path(&parsed, &e["itemsPath"]).and_then(Value::as_array) else { return Err(Reason::Drift) };
    let operations = ops(recipe);
    let mut items = Vec::new();
    for entry in collection.iter().take(recipe.item_limit) {
        let Some(headline) = at_path(entry, &e["headlinePath"]).and_then(|v| normalized(v, &operations, HEADLINE_CAP)) else { continue };
        let url = e.get("urlPath").and_then(|p| at_path(entry, p)).and_then(Value::as_str).and_then(|u| safe_url(u, request_url));
        let published_at = e.get("publishedAtPath").and_then(|p| at_path(entry, p)).and_then(iso_date);
        items.push(Item { headline, url, published_at });
    }
    if !collection.is_empty() && items.is_empty() {
        return Err(Reason::Drift);
    }
    Ok(items)
}

fn node_count(document: &Html) -> usize {
    document.tree.nodes().count()
}

fn field_value(item: scraper::ElementRef, field: &Value) -> Option<Value> {
    let selector = Selector::parse(field["selector"].as_str()?).ok()?;
    let found = item.select(&selector).next()?;
    let raw = match field["source"].as_str()? {
        "text" => found.text().collect::<String>(),
        _ => found.value().attr(field["attribute"].as_str()?)?.to_owned(),
    };
    Some(Value::String(raw))
}

fn extract_html(recipe: &Recipe, body: &str, request_url: &str) -> Result<Vec<Item>, Reason> {
    if body.len() > MAX_HTML_BYTES {
        return Err(Reason::Unsupported);
    }
    let document = Html::parse_document(&lean_html(body));
    if node_count(&document) > MAX_HTML_NODES {
        return Err(Reason::Unsupported);
    }
    let e = &recipe.value["extraction"];
    let pick = |key: &str| e[key].as_str().and_then(|s| Selector::parse(s).ok());
    let (Some(collection_selector), Some(item_selector)) = (pick("collectionSelector"), pick("itemSelector")) else { return Err(Reason::Unsupported) };
    let Some(collection) = document.select(&collection_selector).next() else { return Err(Reason::Drift) };
    let selected: Vec<_> = collection.select(&item_selector).take(recipe.item_limit).collect();
    let operations = ops(recipe);
    let mut items = Vec::new();
    for item in &selected {
        let Some(headline) = field_value(*item, &e["headline"]).and_then(|v| normalized(&v, &operations, HEADLINE_CAP)) else { continue };
        let url = e.get("url").and_then(|f| field_value(*item, f)).and_then(|v| v.as_str().and_then(|u| safe_url(u, request_url)));
        let published_at = e.get("publishedAt").and_then(|f| field_value(*item, f)).and_then(|v| iso_date(&v));
        items.push(Item { headline, url, published_at });
    }
    if !selected.is_empty() && items.is_empty() {
        return Err(Reason::Drift);
    }
    Ok(items)
}

/// Pulls headlines out of one publisher answer. Nothing runs and no second request is made.
pub fn extract(recipe: &Recipe, body: &str, content_type: Option<&str>, request_url: &str) -> Result<Vec<Item>, Reason> {
    match recipe.kind {
        Kind::Json => {
            if !media_ok(content_type, &["application/json", "text/json"]) {
                return Err(Reason::Unsupported);
            }
            extract_json(recipe, body, request_url)
        }
        Kind::Html => {
            if !media_ok(content_type, &["text/html", "application/xhtml+xml"]) {
                return Err(Reason::Unsupported);
            }
            extract_html(recipe, body, request_url)
        }
    }
}

/// The schema the model is shown. Mirrors the strict check above in plain words.
pub const PROMPT_SHAPE: &str = r#"A recipe is one JSON object with exactly these keys: version (the number 1), kind ("json" or "html"), fetchHosts (1 to 6 distinct lower-case hostnames, all of one publisher), request, scopes (1 to 3 distinct values from "sport", "team", "competition"), itemLimit (1 to 50), extraction.
request has exactly: urlTemplate (an https URL, no user, port or fragment, on one of the fetchHosts; each slot appears once as {name}), slots (up to 8 objects with exactly name, location "path" or "query", encoding "path_segment" for a path slot or "query_value" for a query slot, maxLength 1 to 128), headers (exactly accept, which is "application/json" for kind json and "text/html,application/xhtml+xml" for kind html).
For kind json, extraction has: itemsPath, headlinePath, optional urlPath and optional publishedAtPath (each a list of 1 to 8 keys of letters, digits, _ or -), and normalize (up to 4 of "trim", "collapse_whitespace", "strip_controls").
For kind html, extraction has: collectionSelector and itemSelector (CSS, up to 256 chars), headline and optional url and publishedAt (each {"selector": CSS, "source": "text"} or {"selector": CSS, "source": "attribute", "attribute": "href", "datetime" or "content"}), and normalize."#;
