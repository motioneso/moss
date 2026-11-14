//! Opt-in route templates. Literal Phase 4b dispatch remains available unchanged.
use crate::manifest::{relative_path, Route};
use anyhow::{ensure, Context, Result};
use moss_module_sdk::RouteRequest;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub fn template_path(path: &str) -> bool {
    if path.len() > 240 || !path.starts_with('/') {
        return false;
    }
    let mut names = BTreeSet::new();
    let mut has_parameter = false;
    for segment in path[1..].split('/') {
        if let Some(name) = segment.strip_prefix(':') {
            has_parameter = true;
            if name.is_empty()
                || !name.as_bytes()[0].is_ascii_lowercase()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                || !names.insert(name)
            {
                return false;
            }
        } else if !relative_path(segment) {
            return false;
        }
    }
    has_parameter
}
fn decode(segment: &str) -> Result<String> {
    let mut out = Vec::new();
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            ensure!(i + 2 < bytes.len(), "Invalid route encoding");
            let digit = |b: u8| (b as char).to_digit(16).context("Invalid route encoding");
            out.push((digit(bytes[i + 1])? * 16 + digit(bytes[i + 2])?) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let s = String::from_utf8(out)?;
    ensure!(
        !s.is_empty()
            && s != "."
            && s != ".."
            && !s
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | '#' | '?')),
        "Unsafe route segment"
    );
    Ok(s)
}
/// The context resource that asks the host to pass the caller's address on a route request.
pub const CLIENT_ADDRESS: &str = "client-address";
pub fn resolve(routes: &[Route], method: &str, target: &str) -> Result<RouteRequest> {
    ensure!(
        target.len() <= 16_384 && !target.contains('#'),
        "Invalid module target"
    );
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    ensure!(path.starts_with('/'), "Invalid module path");
    let segments = path[1..]
        .split('/')
        .map(decode)
        .collect::<Result<Vec<_>>>()?;
    let mut matches = vec![];
    for route in routes.iter().filter(|r| r.sign_in && r.method == method) {
        if route.path == path {
            matches = vec![(route, BTreeMap::new())];
            break;
        }
        if !template_path(&route.path) {
            continue;
        }
        let parts: Vec<_> = route.path[1..].split('/').collect();
        if parts.len() != segments.len() {
            continue;
        }
        let mut params = BTreeMap::new();
        if parts.iter().zip(&segments).all(|(part, value)| {
            if let Some(name) = part.strip_prefix(':') {
                params.insert(name.to_string(), value.clone());
                true
            } else {
                *part == value
            }
        }) {
            matches.push((route, params));
        }
    }
    ensure!(matches.len() == 1, "Module route is missing or ambiguous");
    let (route, params) = matches.pop().unwrap();
    let mut values: BTreeMap<String, Value> = BTreeMap::new();
    for (i, (key, value)) in url::form_urlencoded::parse(query.as_bytes()).enumerate() {
        ensure!(i < 64, "Too many query parameters");
        let key = key.into_owned();
        let value = Value::String(value.into_owned());
        match values.get_mut(&key) {
            Some(Value::Array(v)) => v.push(value),
            Some(old) => *old = json!([old.clone(), value]),
            None => {
                values.insert(key, value);
            }
        }
    }
    Ok(RouteRequest {
        method: method.into(),
        path: route.path.clone(),
        params,
        query: values,
        body: Value::Null,
    })
}
impl crate::store::Installer {
    /// Explicit opt-in for parameterized paths and query strings. Actor comes from sign-in.
    pub fn dispatch_extended(
        &self,
        access: access_context::AccessContext,
        method: &str,
        target: &str,
        body: &str,
    ) -> Result<String> {
        self.dispatch_extended_from(access, method, target, body, None)
    }
    /// As `dispatch_extended`, also telling a package that asks for it where the call came from.
    /// A package declares the `client-address` resource on its context capability to get a
    /// `client` member on the route request. Every other package's request is unchanged.
    pub fn dispatch_extended_from(
        &self,
        access: access_context::AccessContext,
        method: &str,
        target: &str,
        body: &str,
        client: Option<std::net::IpAddr>,
    ) -> Result<String> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let (id, target) = target
            .strip_prefix("/api/m/")
            .and_then(|s| s.split_once('/'))
            .context("Unknown module route")?;
        let state = self.catalog.load()?;
        let module = state.installed.get(id).context("Module is not installed")?;
        let mut request = resolve(&module.manifest.routes, method, &format!("/{target}"))?;
        request.body = serde_json::from_str(body)?;
        let mut envelope = serde_json::to_value(&request)?;
        let wants_client = module.manifest.capabilities.iter().any(|c| {
            c.port == "context" && c.resources.contains(CLIENT_ADDRESS)
        });
        if let (true, Some(address)) = (wants_client, client) {
            envelope["client"] = json!(address.to_string());
        }
        self.call_unfenced(id, access, "route", &envelope.to_string())
    }
}
