//! Codex, driven through `codex app-server` (JSON-RPC 2.0, protocol v2).
//!
//! The Node `codex-acp` adapter Moss ships today is itself a client of this same app server, so
//! Rust talks to it directly. Command and file-change approvals arrive as server requests and
//! are answered with `accept` or `decline`. Codex keeps its own OS sandbox underneath.

use std::time::Duration;

use serde_json::{json, Value};

use crate::driver::*;
use crate::transport::{Inbound, JsonLines, JsonRpc};

const TURN_QUIET: Duration = Duration::from_secs(180);

pub struct CodexSession {
    rpc: JsonRpc,
    approver: Approver,
    thread_id: String,
    pub model: String,
}

/// A TOML string literal. JSON string escapes are valid TOML basic-string escapes.
fn toml_str(s: &str) -> String {
    serde_json::to_string(s).expect("string")
}

impl CodexSession {
    pub async fn start(spec: &LaunchSpec, approver: Approver) -> Result<Self, AgentError> {
        let mut args = vec!["app-server".to_string()];
        if let Some(tools) = &spec.tools {
            let list = tools.args.iter().map(|a| toml_str(a)).collect::<Vec<_>>().join(",");
            let env = tools
                .env
                .iter()
                .map(|(k, v)| format!("{k}={}", toml_str(v)))
                .collect::<Vec<_>>()
                .join(",");
            args.extend([
                "-c".into(),
                format!("mcp_servers.moss.command={}", toml_str(&tools.command.to_string_lossy())),
                "-c".into(),
                format!("mcp_servers.moss.args=[{list}]"),
                "-c".into(),
                format!("mcp_servers.moss.env={{{env}}}"),
            ]);
        }
        let lines = JsonLines::spawn(spec, &args)?;
        let mut rpc = JsonRpc::new(lines);
        let setup = Duration::from_secs(60);
        rpc.call(
            "initialize",
            json!({"clientInfo": {"name": "moss", "title": "Moss", "version": env!("CARGO_PKG_VERSION")}}),
            setup,
        )
        .await?;
        rpc.notify("initialized", json!({})).await?;

        let model = match &spec.model {
            Some(m) => m.clone(),
            None => cheapest_model(&mut rpc).await?,
        };
        let started = rpc
            .call(
                "thread/start",
                json!({
                    "model": model,
                    "cwd": spec.cwd,
                    "approvalPolicy": "on-request",
                    "sandbox": "read-only",
                    "ephemeral": true,
                }),
                setup,
            )
            .await?;
        let thread_id = started["thread"]["id"]
            .as_str()
            .ok_or_else(|| AgentError::Protocol(format!("thread/start gave no id: {started}")))?
            .to_string();
        Ok(Self {
            rpc,
            approver,
            thread_id,
            model,
        })
    }

    pub async fn prompt(&mut self, text: &str, events: &EventSink) -> Result<TurnOutcome, AgentError> {
        let turn_req = self
            .rpc
            .start_request(
                "turn/start",
                json!({"threadId": self.thread_id, "input": [{"type": "text", "text": text}]}),
            )
            .await?;
        let mut tools_used = Vec::new();
        let mut text_out = String::new();
        loop {
            match self.rpc.next(TURN_QUIET).await? {
                Inbound::Response { id, result: Err(e) } if id == turn_req => {
                    return Err(classify_error(&e.to_string()));
                }
                Inbound::Response { .. } => {}
                Inbound::Notification { method, params } => match method.as_str() {
                    "item/agentMessage/delta" => {
                        let d = params["delta"].as_str().unwrap_or_default();
                        events(AgentEvent::Text { delta: d.into() });
                        text_out.push_str(d);
                    }
                    "item/started" => {
                        if let Some(name) = tool_name_of(&params["item"]) {
                            events(AgentEvent::ToolStarted {
                                id: params["item"]["id"].as_str().unwrap_or_default().into(),
                                name: name.clone(),
                            });
                            tools_used.push(name);
                        }
                    }
                    "item/completed" => {
                        let item = &params["item"];
                        if tool_name_of(item).is_some() {
                            events(AgentEvent::ToolFinished {
                                id: item["id"].as_str().unwrap_or_default().into(),
                                ok: item["status"] != "failed" && item["error"].is_null(),
                            });
                        }
                    }
                    "turn/completed" => {
                        let turn = &params["turn"];
                        if turn["status"] == "failed" {
                            return Err(classify_error(&turn["error"].to_string()));
                        }
                        return Ok(TurnOutcome {
                            text: text_out,
                            tools_used,
                        });
                    }
                    "error" => {
                        if params["willRetry"] != true {
                            return Err(classify_error(&params["error"].to_string()));
                        }
                    }
                    _ => {}
                },
                Inbound::Request { id, method, params } => self.answer(id, &method, &params).await?,
            }
        }
    }

    async fn answer(&mut self, id: Value, method: &str, params: &Value) -> Result<(), AgentError> {
        let (tool, input) = match method {
            "item/commandExecution/requestApproval" => ("Bash", json!({"command": params["command"]})),
            "item/fileChange/requestApproval" => ("Edit", json!({"path": params["grantRoot"]})),
            // Moss's own tools: the gateway decides the real call, so the agent may make it.
            "mcpServer/elicitation/request" if params["serverName"] == "moss" => {
                return self.rpc.respond(id, json!({"action": "accept", "content": null})).await;
            }
            _ => {
                // Anything else (other permissions, user input, auth refresh) is refused.
                return self.rpc.respond_error(id, -32601, "not supported by Moss").await;
            }
        };
        let ask = PermissionAsk {
            tool_name: Some(tool.into()),
            tool_call_id: params["itemId"].as_str().unwrap_or_default().into(),
            title: params["reason"].as_str().unwrap_or(tool).into(),
            paths: crate::policy::paths_in(&input),
            raw_input: input,
        };
        let decision = match (self.approver)(ask).await {
            Answer::Allow => "accept",
            Answer::Deny => "decline",
        };
        self.rpc.respond(id, json!({"decision": decision})).await
    }

    pub fn pid(&self) -> Option<u32> {
        self.rpc.lines.pid()
    }

    pub async fn shutdown(self) {
        self.rpc.lines.shutdown().await
    }
}

fn tool_name_of(item: &Value) -> Option<String> {
    match item["type"].as_str()? {
        "mcpToolCall" => Some(format!(
            "mcp__{}__{}",
            item["server"].as_str().unwrap_or_default(),
            item["tool"].as_str().unwrap_or_default()
        )),
        "commandExecution" => Some("Bash".into()),
        "fileChange" => Some("Edit".into()),
        "webSearch" => Some("WebSearch".into()),
        _ => None,
    }
}

fn classify_error(e: &str) -> AgentError {
    let lower = e.to_lowercase();
    if lower.contains("login") || lower.contains("unauthorized") || lower.contains("401") {
        AgentError::NotSignedIn(e.into())
    } else {
        AgentError::Rpc(e.into())
    }
}

/// The lowest-cost model the signed-in account offers, never a hard-coded name.
async fn cheapest_model(rpc: &mut JsonRpc) -> Result<String, AgentError> {
    let list = rpc.call("model/list", json!({}), Duration::from_secs(60)).await?;
    let models: Vec<&Value> = list["data"].as_array().into_iter().flatten().collect();
    let id = |m: &Value| m["id"].as_str().or(m["model"].as_str()).unwrap_or_default().to_string();
    crate::models::pick_cheapest(models.iter().map(|m| id(m)).collect())
        .ok_or_else(|| AgentError::Protocol(format!("no models offered: {list}")))
}
