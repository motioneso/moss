//! MCP over stdio, multiplexed with runner replies and list-change pushes.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde_json::{json, Value};

type Output = Arc<Mutex<Box<dyn Write + Send>>>;
type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>;

fn main() {
    let socket =
        std::env::var("MOSS_TOOL_SOCKET").unwrap_or_else(|_| die("MOSS_TOOL_SOCKET is not set"));
    let lease_file = std::env::var("MOSS_TOOL_LEASE_FILE")
        .unwrap_or_else(|_| die("MOSS_TOOL_LEASE_FILE is not set"));
    let lease = std::fs::read_to_string(&lease_file)
        .unwrap_or_else(|e| die(&format!("cannot read the lease: {e}")));
    let output: Output = Arc::new(Mutex::new(Box::new(std::io::stdout())));
    let initialized = Arc::new(AtomicBool::new(false));
    let mut host = Host::connect(&socket, lease.trim(), output.clone(), initialized.clone());
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let method = msg["method"].as_str().unwrap_or_default();
        let result = match method {
            "initialize" => json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": {"tools": {"listChanged": true}},
                "serverInfo": {"name": "moss", "version": env!("CARGO_PKG_VERSION")},
            }),
            "ping" => json!({}),
            "tools/list" => {
                let listed = host.ask(json!({"op": "list"}));
                let tools: Vec<Value> = listed["tools"].as_array().into_iter().flatten()
                    .map(|t| json!({"name": t["name"], "description": t["description"], "inputSchema": t["input_schema"]}))
                    .collect();
                json!({"tools": tools})
            }
            "tools/call" => {
                let reply = host.ask(json!({
                    "op": "call", "name": msg["params"]["name"],
                    "arguments": msg["params"].get("arguments").cloned().unwrap_or(json!({})),
                }));
                json!({
                    "content": [{"type": "text", "text": reply["text"].as_str().unwrap_or("No answer from Moss.")}],
                    "isError": reply["isError"] != false,
                })
            }
            _ => {
                send(
                    &output,
                    &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}}),
                );
                continue;
            }
        };
        // Holding the output lock also orders initialize before any notification.
        let mut out = output.lock().unwrap();
        write_line(
            &mut **out,
            &json!({"jsonrpc": "2.0", "id": id, "result": result}),
        )
        .unwrap_or_else(|_| die("stdout closed"));
        if method == "initialize" {
            initialized.store(true, Ordering::Release);
        }
    }
}

fn write_line(out: &mut dyn Write, value: &Value) -> std::io::Result<()> {
    serde_json::to_writer(&mut *out, value)?;
    out.write_all(b"\n")?;
    out.flush()
}

fn send(output: &Output, value: &Value) {
    write_line(&mut **output.lock().unwrap(), value).unwrap_or_else(|_| die("stdout closed"));
}

/// One reader owns the socket. Only matching ids can settle a waiting request.
fn read_replies(
    reader: impl BufRead,
    pending: Pending,
    output: Output,
    initialized: Arc<AtomicBool>,
) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(reply) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(id) = reply["id"].as_u64() {
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let _ = tx.send(reply);
            }
        } else if reply["event"] == "list_changed" {
            let mut out = output.lock().unwrap();
            if initialized.load(Ordering::Acquire) {
                if write_line(
                    &mut **out,
                    &json!({"jsonrpc":"2.0", "method":"notifications/tools/list_changed"}),
                )
                .is_err()
                {
                    break;
                }
            }
        }
    }
    // Dropping the senders wakes every request on disconnect, including a pending tool call.
    pending.lock().unwrap().clear();
}

struct Host {
    #[cfg(unix)]
    writer: std::os::unix::net::UnixStream,
    pending: Pending,
    next: AtomicU64,
}

impl Host {
    #[cfg(unix)]
    fn connect(socket: &str, lease: &str, output: Output, initialized: Arc<AtomicBool>) -> Self {
        let mut stream = std::os::unix::net::UnixStream::connect(socket)
            .unwrap_or_else(|e| die(&format!("cannot reach Moss: {e}")));
        write_line(&mut stream, &json!({"op":"hello", "lease":lease}))
            .unwrap_or_else(|_| die("Moss disconnected"));
        let mut reader = BufReader::new(stream.try_clone().expect("clone socket"));
        let mut hello = String::new();
        reader
            .read_line(&mut hello)
            .unwrap_or_else(|_| die("Moss disconnected"));
        if serde_json::from_str::<Value>(&hello).unwrap_or(Value::Null)["ok"] != true {
            die("Moss refused this tool server");
        }
        let pending = Pending::default();
        let waiters = pending.clone();
        std::thread::spawn(move || read_replies(reader, waiters, output, initialized));
        Self {
            writer: stream,
            pending,
            next: AtomicU64::new(1),
        }
    }

    #[cfg(not(unix))]
    fn connect(_: &str, _: &str, _: Output, _: Arc<AtomicBool>) -> Self {
        die("the tool gateway is not built for this system yet")
    }

    #[cfg(unix)]
    fn ask(&mut self, mut value: Value) -> Value {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        value["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if write_line(&mut self.writer, &value).is_err() {
            die("lost the connection to Moss");
        }
        rx.recv()
            .unwrap_or_else(|_| die("lost the connection to Moss"))
    }

    #[cfg(not(unix))]
    fn ask(&mut self, _: Value) -> Value {
        Value::Null
    }
}

fn die(msg: &str) -> ! {
    eprintln!("moss-tool-gateway: {msg}");
    std::process::exit(1);
}

#[cfg(test)]
#[path = "../gateway_reader_tests.rs"]
mod tests;
