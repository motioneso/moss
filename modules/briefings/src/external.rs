//! Contributions from outside modules. An answer is untrusted JSON. It becomes a typed
//! contribution or is dropped, and every string that survives is cleaned and length capped.
use crate::trust::sanitize_text;
use serde_json::Value;

pub const MAX_ITEMS: usize = 20;
pub const MAX_HEADLINE: usize = 200;
pub const MAX_TITLE: usize = 200;
pub const MAX_DETAIL: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub href: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Contribution {
    pub module_id: String,
    pub headline: String,
    pub items: Vec<Item>,
}

/// What one module offers a briefing.
pub struct Offer {
    pub module_id: String,
    /// The read tool name the person must have selected for this module to be used.
    pub tool_name: String,
    pub sections: Vec<String>,
}

/// Where outside answers come from. No installed module offers one yet, so the app uses
/// `NoContributors` until the module format names a way to ask.
pub trait Contributors {
    fn offers(&self) -> Vec<Offer>;
    /// Asks one module. A module that cannot answer gives `None`.
    fn ask(&self, module_id: &str, section: &str) -> Option<Value>;
}

pub struct NoContributors;

impl Contributors for NoContributors {
    fn offers(&self) -> Vec<Offer> {
        vec![]
    }
    fn ask(&self, _module_id: &str, _section: &str) -> Option<Value> {
        None
    }
}

fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|t| !t.trim().is_empty())
}

/// An in-app link only. A scheme or a scheme-relative `//host` link could leave the app.
fn safe_href(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|h| h.starts_with('/') && !h.starts_with("//") && !h.chars().any(|c| c == '\\' || c.is_control()))
        .map(str::to_owned)
}

fn cut(value: String, max: usize) -> String {
    value.chars().take(max).collect()
}

fn item(raw: &Value) -> Option<Item> {
    let (id, title, detail) = (text(&raw["id"])?, text(&raw["title"])?, text(&raw["detail"])?);
    Some(Item {
        id: sanitize_text(id),
        title: cut(sanitize_text(title), MAX_TITLE),
        detail: cut(sanitize_text(detail), MAX_DETAIL),
        href: safe_href(&raw["href"]),
    })
}

/// A bad item is dropped alone. A bad headline drops the whole answer.
pub fn parse(module_id: &str, raw: &Value) -> Option<Contribution> {
    let headline = text(&raw["headline"])?;
    let items = raw["items"].as_array().into_iter().flatten().filter_map(item).take(MAX_ITEMS).collect();
    Some(Contribution {
        module_id: module_id.to_owned(),
        headline: cut(sanitize_text(headline), MAX_HEADLINE),
        items,
    })
}

/// Only modules whose tool the person selected and whose sections include this one are asked.
/// An unselected module is never called, not called and then filtered.
pub fn collect<C: Contributors + ?Sized>(from: &C, selected: &[String], section: &str) -> Vec<Contribution> {
    from.offers()
        .into_iter()
        .filter(|o| selected.contains(&o.tool_name) && o.sections.iter().any(|s| s == section))
        .filter_map(|o| parse(&o.module_id, &from.ask(&o.module_id, section)?))
        .collect()
}
