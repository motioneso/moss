//! The stored sort map: one entry per tool, tied to the tool's risk-inputs fingerprint.
use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::{
    js,
    tool::{higher_risk, sort_fingerprint, Risk, Tool},
};

pub const VERSION: i64 = 1;
pub const MAX_ENTRIES: usize = 1000;
pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_IDENTIFIER_CHARS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortFailure {
    Error,
    Unsafe,
    NoModel,
    Interrupted,
}

impl SortFailure {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "error" => Self::Error,
            "unsafe" => Self::Unsafe,
            "no_model" => Self::NoModel,
            "interrupted" => Self::Interrupted,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Unsafe => "unsafe",
            Self::NoModel => "no_model",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortMethod {
    Model,
    Local,
}

impl SortMethod {
    fn parse(value: Option<&Value>) -> Option<Self> {
        match value.and_then(Value::as_str) {
            Some("model") => Some(Self::Model),
            Some("local") => Some(Self::Local),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Local => "local",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SortedBy {
    pub model: String,
    pub provider: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Current,
    Failed,
    NeverTried,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub status: Status,
    pub risk: Option<Risk>,
    pub readable_name: Option<String>,
    pub sorted_by: Option<SortedBy>,
    pub sort_method: Option<SortMethod>,
    pub fingerprint: Option<String>,
    pub sorted_at: Option<String>,
    pub failure: Option<SortFailure>,
    pub send_without_asking: bool,
    pub legacy_risk_floor: Option<Risk>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SortMap {
    pub entries: BTreeMap<String, Entry>,
}

/// A tool's sort read against its current risk inputs. Anything but Current asks.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolSort {
    Current {
        risk: Risk,
        readable_name: String,
        sorted_at: String,
        sorted_by: Option<SortedBy>,
        sort_method: Option<SortMethod>,
        send_without_asking: bool,
    },
    Stale,
    Failed { failure: SortFailure, failed_at: String },
    NeverTried,
}

/// One sorting result to store.
#[derive(Clone, Debug, PartialEq)]
pub enum SortResult {
    Current {
        risk: Risk,
        readable_name: String,
        fingerprint: String,
        sorted_at: String,
        sorted_by: Option<SortedBy>,
        method: Option<SortMethod>,
    },
    Failed { failure: SortFailure, fingerprint: String, sorted_at: String },
}

impl SortResult {
    fn fingerprint(&self) -> &str {
        match self {
            Self::Current { fingerprint, .. } | Self::Failed { fingerprint, .. } => fingerprint,
        }
    }
}

/// A display name is one line of bounded plain text with no control characters.
pub fn is_readable_name(value: &str) -> bool {
    !js::trim(value).is_empty()
        && js::len(value) <= MAX_NAME_CHARS
        && !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn is_identifier(value: &str) -> bool {
    !value.is_empty() && js::len(value) <= MAX_IDENTIFIER_CHARS
}

fn parse_sorted_by(value: Option<&Value>) -> Option<SortedBy> {
    let map = value?.as_object()?;
    let model = map.get("model")?.as_str()?;
    let provider = map.get("provider")?.as_str()?;
    (is_readable_name(model) && is_readable_name(provider))
        .then(|| SortedBy { model: model.into(), provider: provider.into() })
}

/// `None` is an invalid stored risk. `Some(None)` is no risk.
fn stored_risk(value: Option<&Value>) -> Option<Option<Risk>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Risk::parse(s).map(Some),
        _ => None,
    }
}

fn blank(status: Status, floor: Option<Risk>) -> Entry {
    Entry {
        status,
        risk: None,
        readable_name: None,
        sorted_by: None,
        sort_method: None,
        fingerprint: None,
        sorted_at: None,
        failure: None,
        send_without_asking: false,
        legacy_risk_floor: floor,
    }
}

fn parse_entry(raw: &Value) -> Option<Entry> {
    let map = raw.as_object()?;
    let floor = stored_risk(map.get("legacyRiskFloor"))?;
    let status = map.get("status").and_then(Value::as_str);
    if status == Some("never_tried") {
        return Some(blank(Status::NeverTried, floor));
    }
    let fingerprint = map.get("sortFingerprint").and_then(Value::as_str).filter(|s| is_identifier(s))?;
    let sorted_at = map.get("sortedAt").and_then(Value::as_str).filter(|s| is_identifier(s))?;
    let mut entry = blank(Status::Failed, floor);
    entry.fingerprint = Some(fingerprint.into());
    entry.sorted_at = Some(sorted_at.into());
    match status {
        Some("failed") => {
            entry.failure = Some(SortFailure::parse(map.get("failure")?.as_str()?)?);
            Some(entry)
        }
        Some("current") => {
            let risk = stored_risk(map.get("risk"))??;
            let name = map.get("readableName").and_then(Value::as_str).filter(|n| is_readable_name(n))?;
            entry.status = Status::Current;
            entry.risk = Some(risk);
            entry.readable_name = Some(name.into());
            entry.sorted_by = parse_sorted_by(map.get("sortedBy"));
            entry.sort_method = SortMethod::parse(map.get("sortMethod"));
            entry.send_without_asking =
                map.get("sendWithoutAsking") == Some(&Value::Bool(true)) && higher_risk(risk, floor) == Risk::Outbound;
            Some(entry)
        }
        _ => None,
    }
}

/// A malformed map reads as empty and a malformed entry is dropped, so a tool asks.
pub fn parse_sort_map(raw: &Value) -> SortMap {
    let mut map = SortMap::default();
    let Some(object) = raw.as_object() else { return map };
    if object.get("version").and_then(Value::as_i64) != Some(VERSION) {
        return map;
    }
    let Some(entries) = object.get("entries").and_then(Value::as_object) else { return map };
    for (name, value) in entries {
        if !is_identifier(name) {
            continue;
        }
        if let Some(entry) = parse_entry(value) {
            map.entries.insert(name.clone(), entry);
        }
    }
    map
}

pub fn sort_map_json(map: &SortMap) -> Value {
    let mut entries = Map::new();
    for (name, e) in &map.entries {
        let status = match e.status {
            Status::Current => "current",
            Status::Failed => "failed",
            Status::NeverTried => "never_tried",
        };
        let mut out = json!({"status": status});
        let o = out.as_object_mut().unwrap();
        if e.status != Status::NeverTried {
            o.insert("sortFingerprint".into(), json!(e.fingerprint));
            o.insert("sortedAt".into(), json!(e.sorted_at));
        }
        if let Some(r) = e.risk {
            o.insert("risk".into(), json!(r.name()));
        }
        if let Some(n) = &e.readable_name {
            o.insert("readableName".into(), json!(n));
        }
        if let Some(b) = &e.sorted_by {
            o.insert("sortedBy".into(), json!({"model": b.model, "provider": b.provider}));
        }
        if let Some(m) = e.sort_method {
            o.insert("sortMethod".into(), json!(m.name()));
        }
        if let Some(f) = e.failure {
            o.insert("failure".into(), json!(f.name()));
        }
        if e.send_without_asking {
            o.insert("sendWithoutAsking".into(), json!(true));
        }
        if let Some(f) = e.legacy_risk_floor {
            o.insert("legacyRiskFloor".into(), json!(f.name()));
        }
        entries.insert(name.clone(), out);
    }
    json!({"version": VERSION, "entries": entries})
}

pub fn tool_sort_state(map: &SortMap, tool: &Tool) -> ToolSort {
    let Some(entry) = map.entries.get(&tool.name).filter(|e| e.status != Status::NeverTried) else {
        return ToolSort::NeverTried;
    };
    if entry.fingerprint.as_deref() != Some(sort_fingerprint(tool).as_str()) {
        return ToolSort::Stale;
    }
    if entry.status == Status::Failed {
        return ToolSort::Failed {
            failure: entry.failure.unwrap_or(SortFailure::Error),
            failed_at: entry.sorted_at.clone().unwrap_or_default(),
        };
    }
    let risk = higher_risk(entry.risk.unwrap_or(Risk::Destructive), entry.legacy_risk_floor);
    ToolSort::Current {
        risk,
        readable_name: entry.readable_name.clone().unwrap_or_default(),
        sorted_at: entry.sorted_at.clone().unwrap_or_default(),
        sorted_by: entry.sorted_by.clone(),
        sort_method: entry.sort_method,
        send_without_asking: entry.send_without_asking && risk == Risk::Outbound,
    }
}

/// Store sorting results against the connection's current tools. A result for a tool no longer
/// discovered, or made for a definition that has since changed, is skipped.
pub fn with_tool_sort_results(map: &SortMap, tools: &[Tool], results: &[(String, SortResult)]) -> SortMap {
    let current: BTreeMap<&str, String> = tools.iter().map(|t| (t.name.as_str(), sort_fingerprint(t))).collect();
    let mut sort = map.clone();
    for (name, result) in results {
        if current.get(name.as_str()).map(String::as_str) != Some(result.fingerprint()) {
            continue;
        }
        if let Some(next) = with_sort_result(&sort, name, result) {
            sort = next;
        }
    }
    sort
}

/// Store one result. The old floor survives. A send choice survives only a result for the same
/// inputs as the current sort it was set on. A no_model failure never overwrites a reached model.
pub fn with_sort_result(map: &SortMap, tool_name: &str, result: &SortResult) -> Option<SortMap> {
    if !is_identifier(tool_name) || !is_identifier(result.fingerprint()) {
        return None;
    }
    let at = match result {
        SortResult::Current { sorted_at, .. } | SortResult::Failed { sorted_at, .. } => sorted_at,
    };
    if !is_identifier(at) {
        return None;
    }
    let previous = map.entries.get(tool_name);
    if let SortResult::Failed { failure: SortFailure::NoModel, fingerprint, .. } = result {
        if let Some(p) = previous {
            let was_no_model = p.status == Status::Failed && p.failure == Some(SortFailure::NoModel);
            if p.fingerprint.as_deref() == Some(fingerprint.as_str()) && !was_no_model {
                return Some(map.clone());
            }
        }
    }
    if previous.is_none() && map.entries.len() >= MAX_ENTRIES {
        return None;
    }
    let floor = previous.and_then(|p| p.legacy_risk_floor);
    let entry = match result {
        SortResult::Current { risk, readable_name, fingerprint, sorted_at, sorted_by, method } => {
            if !is_readable_name(readable_name) {
                return None;
            }
            let keeps = previous.is_some_and(|p| {
                p.status == Status::Current
                    && p.fingerprint.as_deref() == Some(fingerprint.as_str())
                    && higher_risk(*risk, floor) == Risk::Outbound
            });
            let by = if *method == Some(SortMethod::Local) {
                None
            } else {
                sorted_by.clone().filter(|b| is_readable_name(&b.model) && is_readable_name(&b.provider))
            };
            Entry {
                status: Status::Current,
                risk: Some(*risk),
                readable_name: Some(readable_name.clone()),
                sorted_by: by,
                sort_method: *method,
                fingerprint: Some(fingerprint.clone()),
                sorted_at: Some(sorted_at.clone()),
                failure: None,
                send_without_asking: keeps && previous.is_some_and(|p| p.send_without_asking),
                legacy_risk_floor: floor,
            }
        }
        SortResult::Failed { failure, fingerprint, sorted_at } => {
            let mut e = blank(Status::Failed, floor);
            e.fingerprint = Some(fingerprint.clone());
            e.sorted_at = Some(sorted_at.clone());
            e.failure = Some(*failure);
            e
        }
    };
    let mut next = map.clone();
    next.entries.insert(tool_name.into(), entry);
    Some(next)
}

/// Set or clear the send-without-asking choice. Clearing always succeeds. Setting needs a
/// current sort of Sends things out.
pub fn with_send_without_asking(map: &SortMap, tool: &Tool, allow: bool) -> Option<SortMap> {
    let entry = map.entries.get(&tool.name);
    if !allow {
        match entry {
            Some(e) if e.send_without_asking => {}
            _ => return Some(map.clone()),
        }
    } else {
        match (tool_sort_state(map, tool), entry) {
            (ToolSort::Current { risk: Risk::Outbound, .. }, Some(_)) => {}
            _ => return None,
        }
    }
    let mut next = map.clone();
    next.entries.get_mut(&tool.name)?.send_without_asking = allow;
    Some(next)
}

/// Clear every send choice whose sort went stale against the newly discovered tools.
pub fn without_stale_send_choices(map: &SortMap, tools: &[Tool]) -> SortMap {
    let mut next = map.clone();
    for (name, entry) in &mut next.entries {
        if !entry.send_without_asking {
            continue;
        }
        let same = tools
            .iter()
            .find(|t| &t.name == name)
            .is_some_and(|t| entry.fingerprint.as_deref() == Some(sort_fingerprint(t).as_str()));
        if !same {
            entry.send_without_asking = false;
        }
    }
    next
}

pub fn runs_without_asking(state: &ToolSort) -> bool {
    match state {
        ToolSort::Current { risk: Risk::Read | Risk::Write, .. } => true,
        ToolSort::Current { risk: Risk::Outbound, send_without_asking, .. } => *send_without_asking,
        _ => false,
    }
}

pub fn tool_runs_without_asking(map: &SortMap, tool: &Tool) -> bool {
    runs_without_asking(&tool_sort_state(map, tool))
}
