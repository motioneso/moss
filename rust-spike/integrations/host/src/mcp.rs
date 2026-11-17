//! Tool discovery over MCP's streamable HTTP transport: initialize, then list the tools.
use crate::ports::{DiscoverRequest, Discoverer, Discovery};
use async_trait::async_trait;
use moss_integrations::tool::Tool;
use serde_json::{json, Value};
use std::time::Duration;

const UNREACHABLE: &str = "Could not reach an MCP server at that URL.";

pub struct McpDiscoverer {
    client: reqwest::Client,
}

impl Default for McpDiscoverer {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client");
        Self { client }
    }
}

/// Puts the credential where the person said it goes.
fn apply(secret: Option<&str>, placement: Option<&Value>, url: &mut url::Url, headers: &mut reqwest::header::HeaderMap) {
    let Some(secret) = secret.filter(|s| !s.is_empty()) else { return };
    let kind = placement.and_then(|p| p.get("kind")).and_then(Value::as_str).unwrap_or("bearer");
    let name = placement.and_then(|p| p.get("name")).and_then(Value::as_str);
    match kind {
        "header" => {
            if let (Ok(n), Ok(v)) = (
                reqwest::header::HeaderName::from_bytes(name.unwrap_or("X-Api-Key").as_bytes()),
                reqwest::header::HeaderValue::from_str(secret),
            ) {
                headers.insert(n, v);
            }
        }
        "query" => {
            url.query_pairs_mut().append_pair(name.unwrap_or("apikey"), secret);
        }
        _ => {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {secret}")) {
                headers.insert(reqwest::header::AUTHORIZATION, v);
            }
        }
    }
}

/// A reply is plain JSON or an event stream whose last `data:` line holds the JSON.
fn reply_json(content_type: &str, body: &str) -> Option<Value> {
    if content_type.contains("text/event-stream") {
        body.lines()
            .filter_map(|l| l.strip_prefix("data:"))
            .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
            .find(|v| v.get("result").is_some() || v.get("error").is_some())
    } else {
        serde_json::from_str(body).ok()
    }
}

pub fn map_tool(t: &Value) -> Option<Tool> {
    let name = t.get("name")?.as_str()?.to_owned();
    let hint = |key: &str| t.get("annotations").and_then(|a| a.get(key)).and_then(Value::as_bool);
    Some(Tool {
        description: t.get("description").and_then(Value::as_str).unwrap_or(&name).to_owned(),
        name,
        group: String::new(),
        input_schema: t.get("inputSchema").filter(|s| s.is_object()).cloned(),
        read_only: hint("readOnlyHint"),
        idempotent: hint("idempotentHint"),
        destructive: hint("destructiveHint"),
        invoke: None,
    })
}

impl McpDiscoverer {
    async fn rpc(&self, url: &url::Url, headers: &reqwest::header::HeaderMap, session: Option<&str>, body: Value) -> Result<(Option<Value>, Option<String>), ()> {
        let mut request = self
            .client
            .post(url.clone())
            .headers(headers.clone())
            .header("accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(id) = session {
            request = request.header("mcp-session-id", id);
        }
        let response = request.send().await.map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let session = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_owned);
        let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        let text = response.text().await.map_err(|_| ())?;
        Ok((reply_json(&content_type, &text), session))
    }
}

#[async_trait]
impl Discoverer for McpDiscoverer {
    async fn discover(&self, request: &DiscoverRequest<'_>) -> Result<Discovery, String> {
        if request.kind != "mcp" {
            return Err("OpenAPI connections are not available yet.".into());
        }
        let mut url = url::Url::parse(request.url).map_err(|_| UNREACHABLE.to_owned())?;
        let mut headers = reqwest::header::HeaderMap::new();
        apply(request.secret, request.placement, &mut url, &mut headers);
        let fail = |_: ()| UNREACHABLE.to_owned();
        let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "moss-integrations", "version": "1.0.0"}}});
        let (_, session) = self.rpc(&url, &headers, None, init).await.map_err(fail)?;
        let _ = self
            .rpc(&url, &headers, session.as_deref(), json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await;
        let list = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}});
        let (reply, _) = self.rpc(&url, &headers, session.as_deref(), list).await.map_err(fail)?;
        let tools = reply
            .and_then(|r| r.get("result").and_then(|r| r.get("tools")).cloned())
            .and_then(|t| t.as_array().cloned())
            .ok_or_else(|| UNREACHABLE.to_owned())?;
        Ok(Discovery { tools: tools.iter().filter_map(map_tool).collect(), base_url: None, spec_pasted: false })
    }
}
