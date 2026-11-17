//! The free rule that gives a connected tool a readable name at once.
use std::collections::BTreeMap;

use crate::{js, tool::Tool};

pub const MAX_CHARS: usize = 80;
const GLUED_PREFIX_SHARE: f64 = 0.25;
const VERBS: &[&str] = &[
    "add", "cancel", "check", "close", "confirm", "continue", "create", "delete", "disable",
    "enable", "fetch", "find", "finish", "get", "list", "mark", "open", "play", "post", "put",
    "query", "read", "remove", "resolve", "run", "save", "search", "send", "set", "show", "start",
    "stop", "store", "toggle", "turn", "update", "write", "",
];

fn is_verb(word: &str) -> bool {
    !word.is_empty() && VERBS.contains(&word)
}

fn method_verb(method: &str) -> Option<&'static str> {
    match method {
        "GET" => Some("Look up"),
        "POST" => Some("Create"),
        "PUT" | "PATCH" => Some("Update"),
        "DELETE" => Some("Delete"),
        _ => None,
    }
}

/// `sanitizeToolName` from the OpenAPI converter.
pub fn sanitize_tool_name(raw: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            if pending {
                out.push('_');
                pending = false;
            }
            out.push(c);
        } else {
            pending = true;
        }
    }
    if pending {
        out.push('_');
    }
    let trimmed = out.trim_matches('_');
    let cut: String = trimmed.chars().take(64).collect();
    if cut.is_empty() {
        "op".into()
    } else {
        cut
    }
}

struct Parts {
    words: Vec<String>,
    verb: Option<&'static str>,
    from_route: bool,
}

/// Words of a name: breaks at lower-to-upper, at an acronym end, and at spaces, `_`, `.`, `-`.
fn split_words(raw: &str) -> Vec<String> {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 {
            let prev = chars[i - 1];
            let lower_upper = (prev.is_ascii_lowercase() || prev.is_ascii_digit()) && c.is_ascii_uppercase();
            let acronym_end = prev.is_ascii_uppercase()
                && c.is_ascii_uppercase()
                && chars.get(i + 1).is_some_and(|n| n.is_ascii_lowercase());
            if lower_upper || acronym_end {
                out.push(' ');
            }
        }
        out.push(c);
    }
    out.split(|c: char| c.is_whitespace() || matches!(c, '_' | '.' | '-'))
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn named_from_route(tool: &Tool) -> bool {
    let Some(invoke) = &tool.invoke else { return false };
    let generated = sanitize_tool_name(&format!("{}{}", invoke.method.to_lowercase(), invoke.path));
    if tool.name == generated {
        return true;
    }
    tool.name
        .strip_prefix(&generated)
        .and_then(|rest| rest.strip_prefix('_'))
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

fn parts(tool: &Tool) -> Parts {
    if let Some(invoke) = tool.invoke.as_ref().filter(|_| named_from_route(tool)) {
        let words = invoke
            .path
            .split('/')
            .filter(|s| !s.is_empty() && !(s.starts_with('{') && s.ends_with('}')))
            .flat_map(split_words)
            .collect();
        return Parts { words, verb: method_verb(&invoke.method.to_uppercase()), from_route: true };
    }
    let local = match tool.name.rfind("__") {
        Some(at) if at > 0 => &tool.name[at + 2..],
        _ => tool.name.as_str(),
    };
    let source = if local.is_empty() { tool.name.as_str() } else { local };
    Parts { words: split_words(source), verb: None, from_route: false }
}

fn leading(p: &Parts) -> Option<String> {
    (p.words.len() > 1).then(|| p.words[0].to_lowercase())
}

fn drop_common_prefix(set: &mut [&mut Parts], keep_verbs: bool) {
    if set.len() < 2 {
        return;
    }
    loop {
        let Some(first) = leading(set[0]) else { return };
        if !set.iter().all(|p| leading(p).as_deref() == Some(first.as_str())) {
            return;
        }
        if keep_verbs && is_verb(&first) {
            return;
        }
        for p in set.iter_mut() {
            p.words.remove(0);
        }
    }
}

fn drop_glued_prefix(set: &mut [&mut Parts]) {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for p in set.iter() {
        if let Some(first) = leading(p).filter(|f| !is_verb(f)) {
            match counts.iter_mut().find(|(w, _)| *w == first) {
                Some(entry) => entry.1 += 1,
                None => counts.push((first, 1)),
            }
        }
    }
    let mut best: Option<&(String, usize)> = None;
    for entry in &counts {
        if best.is_none_or(|b| entry.1 > b.1) {
            best = Some(entry);
        }
    }
    let Some((word, count)) = best else { return };
    if *count < 2 || (*count as f64) < set.len() as f64 * GLUED_PREFIX_SHARE {
        return;
    }
    let word = word.clone();
    for p in set.iter_mut() {
        if leading(p).as_deref() == Some(word.as_str()) {
            p.words.remove(0);
        }
    }
}

fn sentence_case(words: &[String]) -> String {
    let text = words.join(" ").to_lowercase();
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Readable names for every tool on one connection, keyed by raw tool name.
pub fn readable_tool_names(tools: &[Tool]) -> BTreeMap<String, String> {
    let mut all: Vec<Parts> = tools.iter().map(parts).collect();
    {
        let mut routes: Vec<&mut Parts> = all.iter_mut().filter(|p| p.from_route).collect();
        drop_common_prefix(&mut routes, false);
    }
    {
        let mut named: Vec<&mut Parts> = all.iter_mut().filter(|p| !p.from_route).collect();
        drop_common_prefix(&mut named, true);
        drop_glued_prefix(&mut named);
    }
    let mut out = BTreeMap::new();
    for (tool, p) in tools.iter().zip(&all) {
        let body = sentence_case(&p.words);
        let name = match p.verb {
            Some(verb) if body.is_empty() => verb.to_owned(),
            Some(verb) => format!("{verb} {}", body.to_lowercase()),
            None => body,
        };
        let name = if name.is_empty() { tool.name.clone() } else { name };
        out.insert(tool.name.clone(), js::slice(&name, MAX_CHARS));
    }
    out
}
