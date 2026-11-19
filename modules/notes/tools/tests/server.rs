//! The installed Notes package served by the real HTTPS server executable, with the
//! server's own folder wiring. Real sign-up, real cookies, real Postgres, real files.
//! This is an HTTP check on this machine, not a native screen or second-device proof.
mod support;
use access_context::AccessContext;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Port(String);
impl Drop for Port {
    fn drop(&mut self) {
        let _ = Command::new("devports").args(["release", &self.0]).output();
    }
}
struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("AI is not connected in this check")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("Embeddings are not connected in this check")
    }
}
/// A real HTTP embeddings endpoint on this machine (OpenAI-style). It hashes words into a
/// 768-slot vector, so texts sharing words are close. It stands in for a hosted provider.
static SEEN_AUTHORIZATION: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn embedding_stub(port: &str) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind(format!("127.0.0.1:{port}")).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut data = Vec::new();
                let mut buffer = [0u8; 4096];
                let body = loop {
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buffer[..n]);
                    let text = String::from_utf8_lossy(&data).to_string();
                    if let Some(at) = text.find("\r\n\r\n") {
                        let length = text[..at]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if data.len() >= at + 4 + length {
                            break data[at + 4..at + 4 + length].to_vec();
                        }
                    }
                };
                let head = String::from_utf8_lossy(&data).to_string();
                for line in head.lines() {
                    if line.to_ascii_lowercase().starts_with("authorization:") {
                        SEEN_AUTHORIZATION
                            .lock()
                            .unwrap()
                            .push(line["authorization:".len()..].trim().to_owned());
                    }
                }
                let input: Value = serde_json::from_slice(&body).unwrap();
                let mut vector = vec![0f64; 768];
                for word in input["input"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|w| !w.is_empty())
                {
                    let slot = word.bytes().fold(7usize, |h, b| h * 31 + b as usize) % 768;
                    vector[slot] += 1.0;
                }
                let norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt().max(1.0);
                let vector: Vec<f64> = vector.iter().map(|v| v / norm).collect();
                let reply = json!({"data":[{"embedding":vector}]}).to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    reply.len(),
                    reply
                );
            });
        }
    });
}
fn private(path: &Path, value: &Value) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(value.to_string().as_bytes()).unwrap();
}

#[path = "server/installed.rs"]
mod installed;
