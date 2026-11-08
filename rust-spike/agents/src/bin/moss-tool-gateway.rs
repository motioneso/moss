//! The Moss tool server an agent loads (Model Context Protocol over stdio).
//!
//! It holds no tools, data or secrets of its own. Its launch environment names the runner's
//! socket (MOSS_TOOL_SOCKET) and an owner-only file holding the lease (MOSS_TOOL_LEASE_FILE).
//! It connects back, proves the lease, and forwards each tool list and call. The runner decides
//! whether a call runs.

use std::io::{BufRead, BufReader, Write};

use serde_json::{json, Value};

fn main() {
    let socket = std::env::var("MOSS_TOOL_SOCKET").unwrap_or_else(|_| die("MOSS_TOOL_SOCKET is not set"));
    let lease_file = std::env::var("MOSS_TOOL_LEASE_FILE").unwrap_or_else(|_| die("MOSS_TOOL_LEASE_FILE is not set"));
    let lease = std::fs::read_to_string(&lease_file).unwrap_or_else(|e| die(&format!("cannot read the lease: {e}")));
    let lease = lease.trim();
    let mut host = Host::connect(&socket, lease);

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue }; // notifications need no answer
        let method = msg["method"].as_str().unwrap_or_default();
        let result = match method {
            "initialize" => json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "moss", "version": env!("CARGO_PKG_VERSION")},
            }),
            "ping" => json!({}),
            "tools/list" => {
                let listed = host.ask(&json!({"op": "list"}));
                let tools: Vec<Value> = listed["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|t| json!({"name": t["name"], "description": t["description"], "inputSchema": t["input_schema"]}))
                    .collect();
                json!({"tools": tools})
            }
            "tools/call" => {
                let reply = host.ask(&json!({
                    "op": "call",
                    "name": msg["params"]["name"],
                    "arguments": msg["params"].get("arguments").cloned().unwrap_or(json!({})),
                }));
                json!({
                    "content": [{"type": "text", "text": reply["text"].as_str().unwrap_or("No answer from Moss.")}],
                    "isError": reply["isError"] != false,
                })
            }
            _ => {
                send(&mut stdout, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}}));
                continue;
            }
        };
        send(&mut stdout, &json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }
}

fn send(out: &mut std::io::Stdout, v: &Value) {
    let mut line = serde_json::to_vec(v).expect("json");
    line.push(b'\n');
    let _ = out.write_all(&line);
    let _ = out.flush();
}

struct Host {
    #[cfg(unix)]
    reader: BufReader<std::os::unix::net::UnixStream>,
    #[cfg(unix)]
    writer: std::os::unix::net::UnixStream,
}

impl Host {
    #[cfg(unix)]
    fn connect(socket: &str, lease: &str) -> Self {
        let stream = std::os::unix::net::UnixStream::connect(socket)
            .unwrap_or_else(|e| die(&format!("cannot reach Moss: {e}")));
        let writer = stream.try_clone().expect("clone socket");
        let mut host = Self {
            reader: BufReader::new(stream),
            writer,
        };
        let ok = host.ask(&json!({"op": "hello", "lease": lease}));
        if ok["ok"] != true {
            die("Moss refused this tool server");
        }
        host
    }

    #[cfg(not(unix))]
    fn connect(_: &str, _: &str) -> Self {
        die("the tool gateway is not built for this system yet")
    }

    #[cfg(unix)]
    fn ask(&mut self, v: &Value) -> Value {
        let mut line = serde_json::to_vec(v).expect("json");
        line.push(b'\n');
        if self.writer.write_all(&line).is_err() {
            die("lost the connection to Moss");
        }
        let mut reply = String::new();
        match self.reader.read_line(&mut reply) {
            Ok(n) if n > 0 => serde_json::from_str(&reply).unwrap_or(Value::Null),
            _ => die("lost the connection to Moss"),
        }
    }

    #[cfg(not(unix))]
    fn ask(&mut self, _: &Value) -> Value {
        Value::Null
    }
}

fn die(msg: &str) -> ! {
    eprintln!("moss-tool-gateway: {msg}");
    std::process::exit(1);
}
