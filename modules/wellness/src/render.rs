//! Printable HTML for the selective export. Every value that came from a person goes through
//! `escape` before it reaches the page, and a section appears only for a chosen category.
use serde_json::Value;

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

const STYLE: &str = r#"
  :root { --print-ink: #1a1a1a; --print-muted: #444; --print-rule: #ccc; --print-paper: #fff; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--print-ink); background: var(--print-paper); margin: 2em; font-size: 12pt; line-height: 1.5; }
  h1 { font-size: 24pt; font-weight: 900; border-bottom: 2px solid var(--print-ink); padding-bottom: .4em; line-height: 1.15; }
  h2 { font-size: 18pt; font-weight: 900; margin-top: 1.8em; border-top: 1px solid var(--print-rule); padding-top: .6em; break-after: avoid; }
  .section-number { margin-right: .7em; font-size: 11pt; font-weight: 700; }
  .header-meta { color: var(--print-muted); font-size: 11pt; margin-bottom: 2em; }
  .timeline { list-style: none; padding-left: 0; }
  .timeline li { border-top: 1px solid var(--print-rule); padding: .7em 0; break-inside: avoid; }
  .timestamp { font-weight: 600; margin: 0 0 .2em; font-size: 11pt; }
  .feeling { margin: 0 0 .2em; }
  .note, .sensations { margin: .2em 0; color: var(--print-muted); font-size: 11pt; white-space: pre-wrap; overflow-wrap: anywhere; }
  .therapy-note { margin-bottom: 1em; }
  .body { margin: .2em 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { color: var(--print-muted); font-style: italic; }
  footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid var(--print-rule); color: var(--print-muted); font-size: 11pt; }
  @page { margin: 18mm; }
  @media print { body { margin: 0; } }
"#;

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or("")
}

fn empty(label: &str) -> String {
    format!("    <p class=\"empty\">No {} in this range.</p>\n", escape(label))
}

fn checkins(rows: &[Value]) -> String {
    if rows.is_empty() {
        return empty("Mood check-ins");
    }
    let items: Vec<String> = rows
        .iter()
        .map(|c| {
            let secondary = c["feelingSecondary"].as_str().map_or(String::new(), |s| format!(" \u{2014} {}", escape(s)));
            let intensity = c["intensity"].as_i64().map_or(String::new(), |n| format!(" \u{b7} intensity {n}/5"));
            let energy = c["energy"].as_i64().map_or(String::new(), |n| format!(" \u{b7} energy {n}/5"));
            let sensations: Vec<String> =
                c["sensations"].as_array().into_iter().flatten().filter_map(Value::as_str).map(escape).collect();
            let sensations = if sensations.is_empty() {
                String::new()
            } else {
                format!("    <p class=\"sensations\">Sensations: {}</p>\n", sensations.join(", "))
            };
            let note = c["note"]
                .as_str()
                .filter(|n| !n.is_empty())
                .map_or(String::new(), |n| format!("    <p class=\"note\">{}</p>\n", escape(n)));
            format!(
                "  <li>\n    <p class=\"timestamp\">{}</p>\n    <p class=\"feeling\">{}{}{}{}</p>\n{}{}  </li>",
                escape(c["checkedInAt"].as_str().unwrap_or("\u{2014}")),
                escape(text(c, "feelingCore")),
                secondary,
                intensity,
                energy,
                sensations,
                note
            )
        })
        .collect();
    format!("  <ul class=\"timeline\">\n{}\n  </ul>\n", items.join("\n"))
}

fn therapy_notes(rows: &[Value]) -> String {
    if rows.is_empty() {
        return empty("Therapy notes");
    }
    let items: Vec<String> = rows
        .iter()
        .map(|n| {
            let emotion = n["linkedEmotion"].as_str().filter(|e| !e.is_empty()).map_or(String::new(), |e| format!(" <em>({})</em>", escape(e)));
            format!(
                "  <div class=\"therapy-note\">\n    <p class=\"timestamp\">{}{}</p>\n    <p class=\"body\">{}</p>\n  </div>",
                escape(n["createdAt"].as_str().unwrap_or("\u{2014}")),
                emotion,
                escape(text(n, "body"))
            )
        })
        .collect();
    format!("{}\n", items.join("\n"))
}

/// What the page shows. A `None` category was not chosen and gets no section at all.
pub struct Page<'a> {
    pub owner: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub generated_at: &'a str,
    pub checkins: Option<&'a [Value]>,
    pub therapy_notes: Option<&'a [Value]>,
}

pub fn html(page: &Page) -> String {
    let mut sections = Vec::new();
    let mut add = |key: &str, label: &str, body: String| {
        let number = format!("{:02}", sections.len() + 1);
        sections.push(format!(
            "  <section id=\"{}\">\n    <h2><span class=\"section-number\">{}</span>{}</h2>\n{}  </section>",
            escape(key),
            number,
            escape(label),
            body
        ));
    };
    if let Some(rows) = page.checkins {
        add("checkins", "Mood check-ins", checkins(rows));
    }
    if let Some(rows) = page.therapy_notes {
        add("therapyNotes", "Therapy notes", therapy_notes(rows));
    }
    let owner = escape(page.owner);
    let generated = escape(page.generated_at);
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>Wellness export \u{2014} {owner}</title>\n  <style>{STYLE}</style>\n</head>\n<body>\n  <h1>Wellness export \u{2014} {owner}</h1>\n  <div class=\"header-meta\">\n    <p>Date range: {} to {}</p>\n    <p>Generated: {generated}</p>\n    <p>Generated by Moss.</p>\n  </div>\n\n{}\n\n  <footer>\n    <p>Generated by Moss on {generated}.</p>\n    <p><strong>This document contains sensitive health information.</strong> Share it only with people you trust, such as your doctor or therapist.</p>\n  </footer>\n</body>\n</html>",
        escape(page.from),
        escape(page.to),
        sections.join("\n\n")
    )
}
