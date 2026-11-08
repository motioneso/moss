//! OpenCode, driven through `opencode acp` (Agent Client Protocol, JSON-RPC 2.0).
//!
//! OpenCode ships as a native program with the protocol server built in, so this is a plain ACP
//! client. The same client would drive any other ACP agent.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use crate::driver::*;
use crate::transport::{Inbound, JsonLines, JsonRpc};

const TURN_QUIET: Duration = Duration::from_secs(180);

pub struct AcpSession {
    rpc: JsonRpc,
    approver: Approver,
    session_id: String,
    pub model: String,
    /// Real tool names announced by `tool_call` updates, keyed by tool call id. Permission asks
    /// are matched to these, never to their model-written titles.
    announced: HashMap<String, String>,
}

impl AcpSession {
    pub async fn start(spec: &LaunchSpec, approver: Approver) -> Result<Self, AgentError> {
        let lines = JsonLines::spawn(spec, &["acp".to_string()])?;
        let mut rpc = JsonRpc::new(lines);
        let setup = Duration::from_secs(60);
        rpc.call(
            "initialize",
            json!({
                "protocolVersion": 1,
                // Moss offers no file or terminal access of its own: the agent uses its tools,
                // and each use comes back here as a permission ask.
                "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
                "clientInfo": {"name": "moss", "version": env!("CARGO_PKG_VERSION")},
            }),
            setup,
        )
        .await?;

        let mcp: Vec<Value> = spec
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": "moss",
                    "command": t.command,
                    "args": t.args,
                    "env": t.env.iter().map(|(k, v)| json!({"name": k, "value": v})).collect::<Vec<_>>(),
                })
            })
            .collect();
        let created = rpc
            .call("session/new", json!({"cwd": spec.cwd, "mcpServers": mcp}), setup)
            .await?;
        let session_id = created["sessionId"]
            .as_str()
            .ok_or_else(|| AgentError::Protocol(format!("session/new gave no id: {created}")))?
            .to_string();

        // OpenCode 2 reports the model as a session setting; older agents use `models`.
        let current = created["configOptions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|o| o["id"] == "model")
            .and_then(|o| o["currentValue"].as_str())
            .or(created["models"]["currentModelId"].as_str())
            .map(str::to_string);
        // With no model named, the agent keeps the person's own default.
        let model = match &spec.model {
            Some(m) if Some(m) != current.as_ref() => {
                let set = rpc
                    .call(
                        "session/set_config_option",
                        json!({"sessionId": session_id, "configId": "model", "value": m}),
                        setup,
                    )
                    .await;
                if set.is_err() {
                    rpc.call(
                        "session/set_model",
                        json!({"sessionId": session_id, "modelId": m}),
                        setup,
                    )
                    .await?;
                }
                m.clone()
            }
            Some(m) => m.clone(),
            None => current.unwrap_or_else(|| "default".into()),
        };
        Ok(Self {
            rpc,
            approver,
            session_id,
            model,
            announced: HashMap::new(),
        })
    }

    pub async fn prompt(&mut self, text: &str, events: &EventSink) -> Result<TurnOutcome, AgentError> {
        let req = self
            .rpc
            .start_request(
                "session/prompt",
                json!({"sessionId": self.session_id, "prompt": [{"type": "text", "text": text}]}),
            )
            .await?;
        let mut tools_used = Vec::new();
        let mut text_out = String::new();
        loop {
            match self.rpc.next(TURN_QUIET).await? {
                Inbound::Response { id, result } if id == req => {
                    return match result {
                        Ok(r) if r["stopReason"] == "refusal" => {
                            Err(AgentError::Rpc("the model refused".into()))
                        }
                        Ok(_) => Ok(TurnOutcome {
                            text: text_out,
                            tools_used,
                        }),
                        Err(e) => Err(AgentError::Rpc(e.to_string())),
                    };
                }
                Inbound::Response { .. } => {}
                Inbound::Notification { method, params } if method == "session/update" => {
                    let u = &params["update"];
                    match u["sessionUpdate"].as_str() {
                        Some("agent_message_chunk") => {
                            if let Some(t) = u["content"]["text"].as_str() {
                                events(AgentEvent::Text { delta: t.into() });
                                text_out.push_str(t);
                            }
                        }
                        Some("tool_call") => {
                            let id = u["toolCallId"].as_str().unwrap_or_default().to_string();
                            let real = real_tool_name(u);
                            let name = real.clone().unwrap_or_else(|| {
                                u["title"].as_str().unwrap_or("tool").to_string()
                            });
                            events(AgentEvent::ToolStarted { id: id.clone(), name: name.clone() });
                            if let Some(n) = real {
                                self.announced.insert(id, n.clone());
                                tools_used.push(n);
                            }
                        }
                        Some("tool_call_update") => {
                            let status = u["status"].as_str();
                            if matches!(status, Some("completed") | Some("failed")) {
                                // A code-running tool reports the tools it called inside it.
                                for inner in u["rawOutput"]["metadata"]["toolCalls"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                {
                                    if let Some(t) = inner["tool"].as_str() {
                                        tools_used.push(t.replace('.', "_"));
                                    }
                                }
                                events(AgentEvent::ToolFinished {
                                    id: u["toolCallId"].as_str().unwrap_or_default().into(),
                                    ok: status == Some("completed"),
                                });
                            }
                        }
                        _ => {}
                    }
                }
                Inbound::Notification { .. } => {}
                Inbound::Request { id, method, params } => {
                    if method == "session/request_permission" {
                        self.answer_permission(id, &params).await?;
                    } else {
                        self.rpc.respond_error(id, -32601, "not offered by Moss").await?;
                    }
                }
            }
        }
    }

    async fn answer_permission(&mut self, id: Value, params: &Value) -> Result<(), AgentError> {
        let call = &params["toolCall"];
        let call_id = call["toolCallId"].as_str().unwrap_or_default().to_string();
        let tool_name = self.announced.get(&call_id).cloned().or_else(|| real_tool_name(call));
        let input = call["rawInput"].clone();
        let mut paths = crate::policy::paths_in(&input);
        for loc in call["locations"].as_array().into_iter().flatten() {
            if let Some(p) = loc["path"].as_str() {
                paths.push(p.into());
            }
        }
        let ask = PermissionAsk {
            tool_name,
            tool_call_id: call_id,
            title: call["title"].as_str().unwrap_or_default().into(),
            raw_input: input,
            paths,
        };
        let options = params["options"].as_array().cloned().unwrap_or_default();
        let outcome = match (self.approver)(ask).await {
            Answer::Allow => match pick_option(&options, true) {
                Some(o) => json!({"outcome": "selected", "optionId": o}),
                None => json!({"outcome": "cancelled"}),
            },
            Answer::Deny => match pick_option(&options, false) {
                Some(o) => json!({"outcome": "selected", "optionId": o}),
                None => json!({"outcome": "cancelled"}),
            },
        };
        self.rpc.respond(id, json!({"outcome": outcome})).await
    }

    pub fn pid(&self) -> Option<u32> {
        self.rpc.lines.pid()
    }

    pub async fn shutdown(self) {
        self.rpc.lines.shutdown().await
    }
}

/// The tool's real name from the agent's own metadata. OpenCode puts it in `_meta`; titles are
/// written by the model and never used.
fn real_tool_name(call: &Value) -> Option<String> {
    for key in ["toolName", "tool_name", "tool"] {
        if let Some(n) = call["_meta"][key].as_str() {
            return Some(n.into());
        }
        if let Some(n) = call["_meta"]["opencode"][key].as_str() {
            return Some(n.into());
        }
    }
    None
}

/// Least privilege: allow once, never a standing grant; reject once on deny.
fn pick_option(options: &[Value], allow: bool) -> Option<String> {
    let wanted: &[&str] = if allow {
        &["allow_once", "allow_always"]
    } else {
        &["reject_once", "reject_always"]
    };
    wanted.iter().find_map(|kind| {
        options
            .iter()
            .find(|o| o["kind"] == *kind)
            .and_then(|o| o["optionId"].as_str().map(str::to_string))
    })
}
