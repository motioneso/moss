//! Thin helpers over the XML tokenizer shared by the feed readers.

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

/// Decodes the five XML entities and numeric references in one pass. Anything else stays as written.
pub(crate) fn decode_xml_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let end = after.find(|c: char| c == ';' || c == '&' || c == '<' || c.is_whitespace());
        match end {
            Some(e) if after[e..].starts_with(';') => {
                match entity_char(&after[..e]) {
                    Some(c) => out.push(c),
                    None => out.push_str(&rest[at..at + 1 + e + 1]),
                }
                rest = &after[e + 1..];
            }
            _ => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn entity_char(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => {
            let number = name.strip_prefix('#')?;
            let value = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse::<u32>().ok()?,
            };
            char::from_u32(value)
        }
    }
}

pub(crate) fn tag_name(e: &BytesStart<'_>) -> String {
    e.name().as_ref().to_ascii_lowercase()
}

/// Attributes as decoded (name, value) pairs. The first copy of a repeated name wins.
pub(crate) fn attributes(e: &BytesStart<'_>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for attr in e.attributes().with_checks(false).flatten() {
        let key = attr.key.as_ref().to_string();
        if out.iter().any(|(k, _)| *k == key) {
            continue;
        }
        let value = decode_xml_entities(&attr.value);
        out.push((key, value));
    }
    out
}

pub(crate) fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

pub(crate) fn new_reader(xml: &str) -> Reader<&[u8]> {
    let mut reader = Reader::from_str(xml);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_unmatched_ends = true;
    config.allow_dangling_amp = true;
    config.trim_text(false);
    reader
}

/// Text carried by a text-like event, or `None` for events that carry none.
pub(crate) fn event_text(event: &Event<'_>) -> Option<String> {
    match event {
        Event::Text(t) => Some(t.as_ref().to_string()),
        Event::CData(c) => Some(c.as_ref().to_string()),
        Event::GeneralRef(r) => {
            let name = r.as_ref().to_string();
            Some(match entity_char(&name) {
                Some(c) => c.to_string(),
                None => format!("&{name};"),
            })
        }
        _ => None,
    }
}
