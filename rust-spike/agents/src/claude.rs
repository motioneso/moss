//! Claude Code, driven through its own stream mode.
//!
//! `claude -p --input-format stream-json --output-format stream-json` keeps one process open
//! for many turns. Each tool ask arrives as a `can_use_tool` control request on stdout and is
//! answered on stdin, because `--permission-prompt-tool stdio` routes asks to us. This is the
//! same wire the Node Agent SDK speaks, so no Node adapter is needed.

use std::time::Duration;

use serde_json::{json, Value};

use crate::driver::*;
use crate::transport::JsonLines;

const TURN_QUIET: Duration = Duration::from_secs(180);

pub struct ClaudeSession {
    lines: JsonLines,
    approver: Approver,
    pub model: String,
    next_control: u64,
}

impl ClaudeSession {
    pub async fn start(spec: &LaunchSpec, approver: Approver) -> Result<Self, AgentError> {
        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-prompt-tool",
            "stdio",
            "--permission-mode",
            "default",
            // No user or project settings, hooks or memory files: the chat persona comes from
            // Moss, and another program's settings must not widen what the agent may do.
            "--setting-sources",
            "",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // With no model named, Claude uses the person's own default.
        if let Some(m) = &spec.model {
            args.extend(["--model".into(), m.clone()]);
        }
        let model = spec.model.clone().unwrap_or_else(|| "default".into());
        if let Some(tools) = &spec.tools {
            let env: serde_json::Map<String, Value> = tools
                .env
                .iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect();
            let config = json!({"mcpServers": {"moss": {
                "type": "stdio",
                "command": tools.command,
                "args": tools.args,
                "env": env,
            }}});
            args.push("--mcp-config".into());
            args.push(config.to_string());
            args.push("--strict-mcp-config".into());
        }

        let lines = JsonLines::spawn(spec, &args)?;
        let mut s = Self {
            lines,
            approver,
            model,
            next_control: 1,
        };
        s.control("initialize", json!({})).await?;
        Ok(s)
    }

    async fn control(&mut self, subtype: &str, extra: Value) -> Result<(), AgentError> {
        let id = format!("moss-{}", self.next_control);
        self.next_control += 1;
        let mut request = json!({"subtype": subtype});
        if let (Some(r), Some(e)) = (request.as_object_mut(), extra.as_object()) {
            r.extend(e.clone());
        }
        self.lines
            .send(&json!({"type": "control_request", "request_id": id, "request": request}))
            .await?;
        loop {
            let v = self.lines.recv(Duration::from_secs(60)).await?;
            if v["type"] == "control_response" && v["response"]["request_id"] == id.as_str() {
                if v["response"]["subtype"] == "error" {
                    return Err(AgentError::Rpc(format!("{subtype}: {}", v["response"]["error"])));
                }
                return Ok(());
            }
        }
    }

    pub async fn prompt(&mut self, text: &str, events: &EventSink) -> Result<TurnOutcome, AgentError> {
        self.lines
            .send(&json!({
                "type": "user",
                "message": {"role": "user", "content": [{"type": "text", "text": text}]},
                "parent_tool_use_id": null,
                "session_id": "",
            }))
            .await?;

        let mut tools_used = Vec::new();
        let mut text_out = String::new();
        loop {
            let v = self.lines.recv(TURN_QUIET).await?;
            match v["type"].as_str() {
                Some("assistant") => {
                    for block in v["message"]["content"].as_array().into_iter().flatten() {
                        match block["type"].as_str() {
                            Some("text") => {
                                let t = block["text"].as_str().unwrap_or_default();
                                events(AgentEvent::Text { delta: t.to_string() });
                                text_out.push_str(t);
                            }
                            Some("tool_use") => {
                                let name = block["name"].as_str().unwrap_or_default().to_string();
                                events(AgentEvent::ToolStarted {
                                    id: block["id"].as_str().unwrap_or_default().into(),
                                    name: name.clone(),
                                });
                                tools_used.push(name);
                            }
                            _ => {}
                        }
                    }
                }
                Some("user") => {
                    for block in v["message"]["content"].as_array().into_iter().flatten() {
                        if block["type"] == "tool_result" {
                            events(AgentEvent::ToolFinished {
                                id: block["tool_use_id"].as_str().unwrap_or_default().into(),
                                ok: block["is_error"] != true,
                            });
                        }
                    }
                }
                Some("control_request") => self.answer_control(&v).await?,
                Some("result") => {
                    if v["is_error"] == true {
                        let msg = v["result"].as_str().unwrap_or("turn failed").to_string();
                        if msg.contains("login") || msg.contains("auth") || msg.contains("401") {
                            return Err(AgentError::NotSignedIn(msg));
                        }
                        return Err(AgentError::Rpc(msg));
                    }
                    let final_text = v["result"].as_str().map(str::to_string).unwrap_or(text_out);
                    return Ok(TurnOutcome {
                        text: final_text,
                        tools_used,
                    });
                }
                _ => {}
            }
        }
    }

    async fn answer_control(&mut self, v: &Value) -> Result<(), AgentError> {
        let request_id = v["request_id"].clone();
        let req = &v["request"];
        let response = if req["subtype"] == "can_use_tool" {
            let input = req["input"].clone();
            let ask = PermissionAsk {
                tool_name: req["tool_name"].as_str().map(str::to_string),
                tool_call_id: req["tool_use_id"].as_str().unwrap_or_default().into(),
                title: req["tool_name"].as_str().unwrap_or_default().into(),
                paths: crate::policy::paths_in(&input),
                raw_input: input.clone(),
            };
            match (self.approver)(ask).await {
                Answer::Allow => json!({"behavior": "allow", "updatedInput": input}),
                Answer::Deny => json!({"behavior": "deny", "message": "Moss did not allow this tool here."}),
            }
        } else {
            // Unknown control asks (hooks, dialogs) are refused; we registered none.
            return self
                .lines
                .send(&json!({"type": "control_response", "response": {
                    "subtype": "error", "request_id": request_id, "error": "not supported"}}))
                .await;
        };
        self.lines
            .send(&json!({"type": "control_response", "response": {
                "subtype": "success", "request_id": request_id, "response": response}}))
            .await
    }

    pub fn pid(&self) -> Option<u32> {
        self.lines.pid()
    }

    pub async fn shutdown(self) {
        self.lines.shutdown().await
    }
}
