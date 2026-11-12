//! Text of a private meeting copy. Untrusted fields become plain text, never active Markdown,
//! HTML or remote images. The copy holds no source excerpts, only reviewed summary content and
//! exact revision and range references.
use crate::js::utf16_len;
use serde_json::Value;

/// Escapes one untrusted value.
fn plain(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '(' | ')' | '#' | '+' | '.' | '!' | '|' | '~' | '-' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// A speaker with no name shows its trailing number, for example S2 becomes "Speaker 2".
fn fallback(id: &str) -> String {
    let digits: String = id.chars().rev().take_while(char::is_ascii_digit).collect::<Vec<_>>().into_iter().rev().collect();
    if digits.is_empty() {
        return format!("Speaker ({id})");
    }
    let trimmed = digits.trim_start_matches('0');
    let number = if trimmed.is_empty() { "0".to_owned() } else { trimmed.to_owned() };
    if number.len() <= 15 {
        return format!("Speaker {number}");
    }
    // Longer numbers print the way a JavaScript number does.
    let value: f64 = number.parse().unwrap_or(f64::INFINITY);
    if value < 1e21 {
        format!("Speaker {value}")
    } else {
        format!("Speaker {}", format!("{value:e}").replace('e', "e+"))
    }
}

/// Replaces `{{speaker:<id>}}` tokens. An inferred name is marked as a guess.
fn resolve(text: &str, speakers: &Value) -> String {
    const OPEN: &str = "{{speaker:";
    if !text.contains(OPEN) {
        return text.to_owned();
    }
    let chars: Vec<char> = text.chars().collect();
    let open: Vec<char> = OPEN.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i..].starts_with(&open) {
            let start = i + open.len();
            let mut end = start;
            while end < chars.len() && !matches!(chars[end], '{' | '}') && !js_space(chars[end]) {
                end += 1;
            }
            let id: String = chars[start..end].iter().collect();
            let closed = chars.get(end) == Some(&'}') && chars.get(end + 1) == Some(&'}');
            if closed && (1..=100).contains(&utf16_len(&id)) {
                let guess = speakers
                    .as_array()
                    .and_then(|list| list.iter().find(|s| s["speakerId"].as_str() == Some(id.as_str())))
                    .and_then(|s| s["name"].as_str())
                    .filter(|name| !name.is_empty());
                match guess {
                    Some(name) => out.push_str(&format!("{name} (guess)")),
                    None => out.push_str(&fallback(&id)),
                }
                i = end + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn number(value: &Value) -> String {
    value.as_i64().map_or_else(|| value.to_string(), |n| n.to_string())
}

fn citation(evidence: &Value) -> String {
    let meeting = evidence["meetingId"].as_str().unwrap_or_default();
    let range = format!("{}-{}", number(&evidence["startCharacter"]), number(&evidence["endCharacter"]));
    if evidence["kind"] == "transcript" {
        format!(
            "transcript:{meeting}/{}@{}:{range}",
            evidence["segmentId"].as_str().unwrap_or_default(),
            number(&evidence["segmentRevision"])
        )
    } else {
        format!("personal-note:{meeting}@{}:{range}", number(&evidence["notesRevision"]))
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// Renders one stored summary version as the Markdown a private copy holds.
pub fn render(artifact: &Value) -> String {
    let content = &artifact["content"];
    let speakers = &content["speakers"];
    let said = |value: &Value| plain(&resolve(text(value), speakers));
    let items = |key: &str| content[key].as_array().cloned().unwrap_or_default();
    let claim = |item: &Value| {
        let evidence: Vec<String> =
            item["evidence"].as_array().into_iter().flatten().map(citation).collect();
        format!("- {}\n  Evidence: {}", said(&item["text"]), evidence.join("; ")).trim_end().to_owned()
    };
    let phrase = |value: &Value| plain(value.as_str().unwrap_or("Unspecified"));
    let mut blocks: Vec<String> = vec![
        format!("# Meeting {}", plain(text(&artifact["meetingId"]))),
        format!("Artifact: {} version {}", plain(text(&artifact["id"])), number(&artifact["version"])),
        format!("Created: {}", plain(text(&artifact["createdAt"]))),
        format!(
            "Origin: {}; template: {}@{}",
            text(&artifact["origin"]),
            plain(text(&artifact["templateId"])),
            number(&artifact["templateVersion"])
        ),
        format!(
            "Inputs: transcript revision {}; personal notes revision {}",
            artifact["inputs"]["transcript"]["transcriptRevision"].as_i64().unwrap_or(0),
            number(&artifact["inputs"]["notesRevision"])
        ),
        "Private independent copy. Source evidence may become unavailable after meeting deletion.".into(),
        "## Overview".into(),
        said(&content["overview"]),
        "## Decisions".into(),
    ];
    blocks.extend(items("decisions").iter().map(claim));
    blocks.push("## Open questions".into());
    blocks.extend(items("openQuestions").iter().map(|t| format!("- {}", said(t))));
    blocks.push("## Suggested actions (not accepted Tasks)".into());
    blocks.extend(items("actions").iter().map(|a| {
        format!("{}\n  Owner phrase: {}; date phrase: {}", claim(a), phrase(&a["ownerPhrase"]), phrase(&a["duePhrase"]))
    }));
    blocks.push("## Warnings".into());
    blocks.extend(items("warnings").iter().map(|t| format!("- {}", said(t))));
    blocks.join("\n\n") + "\n"
}
