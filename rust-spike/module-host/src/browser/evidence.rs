//! What a render returns: bounded text and a few link candidates, never a live page.
//!
//! The page script runs in an isolated world, so page code cannot change the functions it uses,
//! but the page still controls what it returns. Everything here is checked again in Rust.
use super::{MAX_CANDIDATES, TEXT_LIMIT};
use serde_json::{json, Value};
use url::Url;

/// Runs in the page. A fixed text, never built from page or package input.
pub const SCRIPT: &str = r#"(() => {
  const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    const text = clip(a.textContent, 200);
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (u.protocol !== "https:" || text.length < 15 || seen.has(u.href)) continue;
    seen.add(u.href);
    links.push({ url: u.href, text });
    if (links.length >= 60) break;
  }
  return JSON.stringify({
    title: clip(document.title, 200),
    text: clip(document.body ? document.body.innerText : "", 20000),
    links
  });
})()"#;

/// Most the page script's answer may be before it is refused.
pub const RAW_LIMIT: usize = 256 * 1024;

#[derive(Debug, PartialEq)]
pub struct Evidence {
    pub title: String,
    pub text: String,
    pub candidates: Vec<(String, String)>,
}

impl Evidence {
    pub fn to_json(&self, final_url: &str, request_id: &str, requests: usize) -> Value {
        json!({
            "ok": true,
            "requestId": request_id,
            "finalUrl": final_url,
            "title": self.title,
            "text": self.text,
            "candidates": self.candidates.iter()
                .map(|(url, text)| json!({"url":url,"text":text}))
                .collect::<Vec<_>>(),
            "requests": requests,
        })
    }
}

fn clip(text: &str, chars: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(chars).collect()
}

/// Parses the page script's answer. Keeps only links to approved hosts over HTTPS, at most five.
pub fn parse(raw: &str, allowed_hosts: &[String]) -> Option<Evidence> {
    if raw.len() > RAW_LIMIT {
        return None;
    }
    let value: Value = serde_json::from_str(raw).ok()?;
    let title = clip(value.get("title")?.as_str()?, 200);
    let text = clip(value.get("text")?.as_str()?, TEXT_LIMIT);
    let mut candidates = vec![];
    for link in value.get("links")?.as_array()? {
        if candidates.len() >= MAX_CANDIDATES {
            break;
        }
        let (Some(url), Some(label)) = (
            link.get("url").and_then(Value::as_str),
            link.get("text").and_then(Value::as_str),
        ) else {
            continue;
        };
        let Ok(parsed) = Url::parse(url) else { continue };
        let host = parsed.host_str().map(str::to_ascii_lowercase);
        if url.len() <= 2048
            && parsed.scheme() == "https"
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && host.is_some_and(|h| allowed_hosts.iter().any(|a| *a == h))
        {
            candidates.push((parsed.to_string(), clip(label, 200)));
        }
    }
    Some(Evidence {
        title,
        text,
        candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed() -> Vec<String> {
        vec!["ok.test".into()]
    }

    #[test]
    fn candidates_are_limited_to_five_approved_https_links() {
        let mut links = vec![
            json!({"url":"https://evil.test/a","text":"A headline from another host"}),
            json!({"url":"http://ok.test/a","text":"A headline over plain http"}),
            json!({"url":"https://user:pw@ok.test/a","text":"A headline with a password"}),
        ];
        for n in 0..9 {
            links.push(json!({"url":format!("https://ok.test/{n}"),"text":format!("Headline number {n} here")}));
        }
        let raw = json!({"title":"T","text":"body","links":links}).to_string();
        let evidence = parse(&raw, &allowed()).unwrap();
        assert_eq!(evidence.candidates.len(), 5);
        assert!(evidence.candidates.iter().all(|(u, _)| u.starts_with("https://ok.test/")));
    }

    #[test]
    fn text_is_clipped_and_controls_removed() {
        let raw = json!({"title":"a\u{0}b","text":"x".repeat(TEXT_LIMIT + 50),"links":[]}).to_string();
        let evidence = parse(&raw, &allowed()).unwrap();
        assert_eq!(evidence.title, "ab");
        assert_eq!(evidence.text.chars().count(), TEXT_LIMIT);
    }

    #[test]
    fn malformed_or_oversized_answers_are_refused() {
        assert!(parse("not json", &allowed()).is_none());
        assert!(parse(r#"{"title":1,"text":"","links":[]}"#, &allowed()).is_none());
        assert!(parse(&"x".repeat(RAW_LIMIT + 1), &allowed()).is_none());
    }
}
