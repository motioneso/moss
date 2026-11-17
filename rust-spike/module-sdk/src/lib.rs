//! Guest-safe contracts. This crate has no host, filesystem, network or runtime dependency.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[cfg(all(feature = "component", target_arch = "wasm32"))]
pub mod component;
pub mod query;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Error {
    pub message: String,
}
impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new("Invalid host response")
    }
}
pub type Result<T> = std::result::Result<T, Error>;

/// The only module-to-host edge. Actor identity and connections are never parameters.
pub trait Host {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value)
        -> Result<Value>;
}

pub struct Client<'a, H: Host + ?Sized>(pub &'a H);
impl<H: Host + ?Sized> Client<'_, H> {
    pub fn api(&self, module: &str, name: &str, parameters: Value) -> Result<Value> {
        self.0.call(
            "api",
            "call",
            module,
            json!({"name":name,"parameters":parameters}),
        )
    }
    pub fn query(&self, table: &str, query: &query::Query) -> Result<Vec<Value>> {
        let value = self
            .0
            .call("db", "query", table, serde_json::to_value(query)?)?;
        Ok(serde_json::from_value(value)?)
    }
    /// Renders one confirmed page in the host's sandboxed browser. Route handlers only. The
    /// answer holds `ok` plus either evidence (`title`, `text`, `candidates`) or a `reason`.
    pub fn render_page(&self, url: &str, allowed_hosts: &[&str]) -> Result<Value> {
        self.0.call(
            "browser",
            "render",
            "public-web",
            json!({"url":url,"allowedHosts":allowed_hosts}),
        )
    }
    /// Opt-in NULLS FIRST columns without adding required fields to legacy Order literals.
    pub fn query_with_nulls_first(
        &self,
        table: &str,
        query: &query::Query,
        columns: &[&str],
    ) -> Result<Vec<Value>> {
        if columns.is_empty() {
            return self.query(table, query);
        }
        let mut parameters = serde_json::to_value(query)?;
        parameters["nullsFirst"] = json!(columns);
        let value = self.0.call("db", "query", table, parameters)?;
        Ok(serde_json::from_value(value)?)
    }
}

/// Additive route-dispatch envelope. The old route envelope remains supported by the host.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    #[serde(default)]
    pub query: BTreeMap<String, Value>,
    #[serde(default)]
    pub body: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Response {
    pub status: u16,
    pub body: Value,
}
impl Response {
    pub fn new(status: u16, body: Value) -> Self {
        Self { status, body }
    }
}
