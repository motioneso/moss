//! A fixed fake embedding model for tests. It is a small local HTTP server that answers the
//! OpenAI-style embeddings request with repeatable 768-number vectors taken from a hash of the
//! received text, plus a few hand-made vectors so the nearest one is predictable. It records the
//! exact text and bearer token it receives so a test can check them. It ships nowhere.
#![allow(dead_code)]
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};

/// What the next answers look like. Anything but `Normal` is a deliberately bad answer.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    WrongSize,
    Empty,
    NullValue,
    Oversize,
    ServerError,
}

pub struct FakeEmbeddingModel {
    pub url: String,
    /// Exact `input` text of every request, prefix included.
    pub received: Arc<Mutex<Vec<String>>>,
    /// Authorization header value of every request.
    pub tokens: Arc<Mutex<Vec<String>>>,
    pub mode: Arc<Mutex<Mode>>,
}

/// A unit vector along one axis.
pub fn axis(slot: usize) -> Vec<f64> {
    let mut v = vec![0.0; 768];
    v[slot] = 1.0;
    v
}

/// Vector from a hash of the text. The same text always gives the same vector.
pub fn hashed(text: &str) -> Vec<f64> {
    let mut v = Vec::with_capacity(768);
    let mut block = 0u32;
    while v.len() < 768 {
        let digest = Sha256::digest([text.as_bytes(), &block.to_le_bytes()].concat());
        for pair in digest.chunks(2) {
            if v.len() < 768 {
                v.push((u16::from_le_bytes([pair[0], pair[1]]) as f64 / 32767.5) - 1.0);
            }
        }
        block += 1;
    }
    let norm = v.iter().map(|n| n * n).sum::<f64>().sqrt();
    v.iter().map(|n| n / norm).collect()
}

impl FakeEmbeddingModel {
    /// `handmade` maps a text, without its prefix, to the vector to answer for it.
    pub fn start(handmade: BTreeMap<String, Vec<f64>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/embeddings", listener.local_addr().unwrap());
        let received = Arc::new(Mutex::new(Vec::new()));
        let tokens = Arc::new(Mutex::new(Vec::new()));
        let mode = Arc::new(Mutex::new(Mode::Normal));
        let (r, t, m) = (received.clone(), tokens.clone(), mode.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (r, t, m, handmade) = (r.clone(), t.clone(), m.clone(), handmade.clone());
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut data = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let (head, body) = loop {
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
                                break (
                                    text[..at].to_owned(),
                                    data[at + 4..at + 4 + length].to_vec(),
                                );
                            }
                        }
                    };
                    let input: Value = serde_json::from_slice(&body).unwrap();
                    let text = input["input"].as_str().unwrap_or_default().to_owned();
                    r.lock().unwrap().push(text.clone());
                    t.lock().unwrap().push(
                        head.lines()
                            .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                            .unwrap_or_default()
                            .to_owned(),
                    );
                    let bare = text
                        .strip_prefix("search_document: ")
                        .or_else(|| text.strip_prefix("search_query: "))
                        .unwrap_or(&text);
                    let vector = handmade
                        .get(bare)
                        .cloned()
                        .unwrap_or_else(|| hashed(bare));
                    let (status, reply) = match *m.lock().unwrap() {
                        Mode::Normal => (200, json!({"data":[{"embedding":vector}]})),
                        Mode::WrongSize => (200, json!({"data":[{"embedding":&vector[..767]}]})),
                        Mode::Empty => (200, json!({"data":[{"embedding":[]}]})),
                        Mode::NullValue => {
                            let mut v: Vec<Value> = vector.iter().map(|n| json!(n)).collect();
                            v[5] = Value::Null;
                            (200, json!({"data":[{"embedding":v}]}))
                        }
                        Mode::Oversize => (
                            200,
                            json!({"data":[{"embedding":vector}],"padding":"x".repeat(2 * 1024 * 1024)}),
                        ),
                        Mode::ServerError => (500, json!({"error":"broken"})),
                    };
                    let reply = reply.to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        reply.len(),
                        reply
                    );
                });
            }
        });
        Self {
            url,
            received,
            tokens,
            mode,
        }
    }
    pub fn set_mode(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }
}
