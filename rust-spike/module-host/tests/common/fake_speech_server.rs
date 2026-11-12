//! A fixed fake speech server for tests. It is a small local HTTP server that answers the
//! OpenAI-style transcription request with repeatable segments taken from a hash of the audio.
//! It records the exact bytes, hash, form fields and bearer token it receives, and can refuse,
//! send bad bodies, or change the configured route while a request is in flight. It ships nowhere.
#![allow(dead_code)]
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};

#[derive(Clone, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Status(u16),
    NotJson,
    NoSegments,
    BadSegment,
    BackwardsSegment,
    TooManySegments,
    Oversize,
    TooMuchText,
}

pub struct Received {
    pub path: String,
    pub audio: Vec<u8>,
    pub sha256: String,
    pub fields: BTreeMap<String, String>,
    pub authorization: String,
}

pub struct FakeSpeechServer {
    pub url: String,
    pub received: Arc<Mutex<Vec<Received>>>,
    pub mode: Arc<Mutex<Mode>>,
    /// Runs once the request has arrived and before the answer goes out.
    pub on_request: Arc<Mutex<Option<Box<dyn Fn() + Send>>>>,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The segments the fake answers for audio with this hash. Always the same for the same bytes.
pub fn segments_for(hash: &str) -> Vec<Value> {
    let a = u8::from_str_radix(&hash[0..2], 16).unwrap() as f64;
    vec![
        json!({"start":0.0,"end":1.5,"text":format!("first {}", &hash[..8])}),
        json!({"start":1.5,"end":1.5 + 1.0 + a / 100.0,"text":format!("second {}", &hash[8..16])}),
    ]
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

fn parse(head: &str, body: &[u8]) -> Received {
    let path = head.lines().next().unwrap_or_default().split(' ').nth(1).unwrap_or_default().to_owned();
    let boundary = head
        .lines()
        .find_map(|l| l.to_ascii_lowercase().contains("content-type:").then(|| l.split("boundary=").nth(1).map(str::to_owned)).flatten())
        .unwrap_or_default();
    let marker = format!("--{boundary}").into_bytes();
    let mut fields = BTreeMap::new();
    let mut audio = Vec::new();
    let mut at = 0;
    while let Some(start) = find(body, &marker, at) {
        let part_start = start + marker.len();
        let Some(end) = find(body, &marker, part_start) else { break };
        let part = &body[part_start..end];
        at = end;
        let Some(split) = find(part, b"\r\n\r\n", 0) else { continue };
        let headers = String::from_utf8_lossy(&part[..split]).to_string();
        let mut data = &part[split + 4..];
        data = data.strip_suffix(b"\r\n").unwrap_or(data);
        let name = headers.split("name=\"").nth(1).and_then(|n| n.split('"').next()).unwrap_or_default().to_owned();
        if name == "file" {
            fields.insert("file-name".into(), headers.split("filename=\"").nth(1).and_then(|n| n.split('"').next()).unwrap_or_default().to_owned());
            audio = data.to_vec();
        } else {
            fields.insert(name, String::from_utf8_lossy(data).to_string());
        }
    }
    let authorization = head.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")).unwrap_or_default().to_owned();
    Received { path, sha256: hex(&Sha256::digest(&audio)), audio, fields, authorization }
}

impl FakeSpeechServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let received = Arc::new(Mutex::new(Vec::new()));
        let mode = Arc::new(Mutex::new(Mode::Normal));
        let on_request: Arc<Mutex<Option<Box<dyn Fn() + Send>>>> = Arc::new(Mutex::new(None));
        let (r, m, hook) = (received.clone(), mode.clone(), on_request.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (r, m, hook) = (r.clone(), m.clone(), hook.clone());
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut data = Vec::new();
                    let mut buffer = [0u8; 65536];
                    let (head, body) = loop {
                        let n = stream.read(&mut buffer).unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        data.extend_from_slice(&buffer[..n]);
                        if let Some(at) = find(&data, b"\r\n\r\n", 0) {
                            let head = String::from_utf8_lossy(&data[..at]).to_string();
                            let length = head
                                .lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                                .unwrap_or(0);
                            if data.len() >= at + 4 + length {
                                break (head, data[at + 4..at + 4 + length].to_vec());
                            }
                        }
                    };
                    let got = parse(&head, &body);
                    let segments = segments_for(&got.sha256);
                    r.lock().unwrap().push(got);
                    if let Some(hook) = hook.lock().unwrap().as_ref() {
                        hook();
                    }
                    let mode = m.lock().unwrap().clone();
                    let (status, reply) = match mode {
                        Mode::Normal => (200, json!({"text":"ignored","segments":segments}).to_string()),
                        Mode::Status(code) => (code, json!({"error":"refused"}).to_string()),
                        Mode::NotJson => (200, "not json".to_owned()),
                        Mode::NoSegments => (200, json!({"text":"x"}).to_string()),
                        Mode::BadSegment => (200, json!({"segments":[{"start":"zero","end":1,"text":"x"}]}).to_string()),
                        Mode::BackwardsSegment => (200, json!({"segments":[{"start":2.0,"end":1.0,"text":"x"}]}).to_string()),
                        Mode::TooManySegments => (
                            200,
                            json!({"segments":(0..10_001).map(|i| json!({"start":0,"end":1,"text":i.to_string()})).collect::<Vec<_>>()}).to_string(),
                        ),
                        Mode::Oversize => (200, json!({"segments":[],"padding":"x".repeat(2 * 1024 * 1024 + 1)}).to_string()),
                        Mode::TooMuchText => (200, json!({"segments":[{"start":0,"end":1,"text":"y".repeat(1024 * 1024 + 1)}]}).to_string()),
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        reply.len(),
                        reply
                    );
                });
            }
        });
        Self { url, received, mode, on_request }
    }
    pub fn set_mode(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }
}
