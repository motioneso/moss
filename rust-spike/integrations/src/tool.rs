//! A discovered tool, its risk inputs and the fingerprint a sort is tied to.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::js;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: String,
    #[serde(rename = "in")]
    pub location: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoke {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub params: Vec<Param>,
    #[serde(default)]
    pub has_body: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub input_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoke: Option<Invoke>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Read,
    Write,
    Outbound,
    Destructive,
}

impl Risk {
    pub fn parse(text: &str) -> Option<Risk> {
        match text {
            "read" => Some(Risk::Read),
            "write" => Some(Risk::Write),
            "outbound" => Some(Risk::Outbound),
            "destructive" => Some(Risk::Destructive),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Risk::Read => "read",
            Risk::Write => "write",
            Risk::Outbound => "outbound",
            Risk::Destructive => "destructive",
        }
    }
}

/// The higher of two risks. `None` leaves the first unchanged.
pub fn higher_risk(a: Risk, b: Option<Risk>) -> Risk {
    match b {
        Some(b) if b > a => b,
        _ => a,
    }
}

/// Sorted-key copy of a value, as the old canonical form.
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| js::cmp(a, b));
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

pub fn sha256_of(value: &Value) -> String {
    let canonical = serde_json::to_string(&canonicalize(value)).unwrap_or_default();
    let digest = Sha256::digest(canonical.as_bytes());
    let mut out = String::from("sha256:");
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// What the stored risk depends on. Changing any of it makes a stored sort stale.
pub fn risk_inputs(tool: &Tool) -> Value {
    let method = tool
        .invoke
        .as_ref()
        .map(|i| i.method.as_str())
        .filter(|m| !m.is_empty())
        .map(|m| Value::String(m.to_uppercase()))
        .unwrap_or(Value::Null);
    json!({
        "name": tool.name,
        "description": tool.description,
        "group": tool.group,
        "inputSchema": tool.input_schema.clone().unwrap_or(Value::Null),
        "readOnly": tool.read_only,
        "idempotent": tool.idempotent,
        "destructive": tool.destructive,
        "httpMethod": method,
    })
}

pub fn sort_fingerprint(tool: &Tool) -> String {
    sha256_of(&risk_inputs(tool))
}

/// The tool's own signal that raises risk: a destructive hint or a DELETE.
pub fn code_risk_signal(tool: &Tool) -> Option<Risk> {
    let delete = tool.invoke.as_ref().is_some_and(|i| !i.method.is_empty() && i.method.to_uppercase() == "DELETE");
    (tool.destructive == Some(true) || delete).then_some(Risk::Destructive)
}
