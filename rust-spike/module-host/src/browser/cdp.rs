//! A small client for the Chromium debugging protocol over `--remote-debugging-pipe`.
//!
//! Messages are JSON objects, each ended by one NUL byte, in both directions. A reader thread
//! turns the browser's output into messages on a channel. Writers share one lock, so several
//! worker threads can answer paused requests while the render loop keeps reading.
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// Larger than any message the render path expects. A longer one ends the connection.
const MESSAGE_LIMIT: usize = 8 * 1024 * 1024;

/// The writing half. Cheap to clone.
#[derive(Clone)]
pub struct Writer {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
    next: Arc<AtomicU64>,
}

impl Writer {
    /// Sends one command and returns its id. Does not wait for the answer.
    pub fn send(&self, method: &str, params: Value, session: Option<&str>) -> Result<u64> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let mut message = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        let mut bytes = serde_json::to_vec(&message)?;
        bytes.push(0);
        let mut out = self.out.lock().map_err(|_| anyhow::anyhow!("pipe busy"))?;
        out.write_all(&bytes).context("The browser pipe closed")?;
        out.flush().context("The browser pipe closed")?;
        Ok(id)
    }
}

/// The reading half plus a way to wait for one answer while keeping other messages in order.
pub struct Connection {
    pub writer: Writer,
    messages: mpsc::Receiver<Value>,
    held: VecDeque<Value>,
}

impl Connection {
    pub fn new(
        to_browser: impl Write + Send + 'static,
        from_browser: impl Read + Send + 'static,
    ) -> Self {
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(from_browser);
            loop {
                let mut buffer = Vec::new();
                // Cap the read so a flood without a terminator cannot fill memory.
                let mut limited = (&mut reader).take(MESSAGE_LIMIT as u64 + 1);
                match limited.read_until(0, &mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if buffer.last() == Some(&0) {
                    buffer.pop();
                } else {
                    break;
                }
                if buffer.len() > MESSAGE_LIMIT {
                    break;
                }
                match serde_json::from_slice::<Value>(&buffer) {
                    Ok(value) => {
                        if send.send(value).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            writer: Writer {
                out: Arc::new(Mutex::new(Box::new(to_browser))),
                next: Arc::new(AtomicU64::new(1)),
            },
            messages: receive,
            held: VecDeque::new(),
        }
    }

    /// Sends a command and waits for its answer. Events that arrive meanwhile are kept for
    /// `next_event`, in order.
    pub fn call(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
        deadline: Instant,
    ) -> Result<Value> {
        let id = self.writer.send(method, params, session)?;
        loop {
            let message = self.receive(deadline)?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if message.get("error").is_some() {
                    bail!("The browser refused a command");
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if message.get("method").is_some() {
                self.held.push_back(message);
            }
        }
    }

    /// The next event, or `None` when `wait` passes with nothing. Answers to commands sent by
    /// worker threads are dropped here.
    pub fn next_event(&mut self, wait: Duration) -> Result<Option<Value>> {
        if let Some(event) = self.held.pop_front() {
            return Ok(Some(event));
        }
        let until = Instant::now() + wait;
        loop {
            match self.receive(until) {
                Ok(message) if message.get("method").is_some() => return Ok(Some(message)),
                Ok(_) => continue,
                Err(_) if Instant::now() >= until => return Ok(None),
                Err(e) => return Err(e),
            }
        }
    }

    fn receive(&mut self, deadline: Instant) -> Result<Value> {
        let wait = deadline.saturating_duration_since(Instant::now());
        ensure!(!wait.is_zero(), "timeout");
        match self.messages.recv_timeout(wait) {
            Ok(message) => Ok(message),
            Err(mpsc::RecvTimeoutError::Timeout) => bail!("timeout"),
            Err(mpsc::RecvTimeoutError::Disconnected) => bail!("The browser closed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn messages_are_nul_terminated_json_and_events_keep_their_order() {
        let incoming = b"{\"method\":\"A\",\"params\":{}}\0{\"id\":1,\"result\":{\"x\":2}}\0{\"method\":\"B\",\"params\":{}}\0";
        let sink = Arc::new(Mutex::new(Vec::new()));
        struct Shared(Arc<Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut c = Connection::new(Shared(sink.clone()), Cursor::new(incoming.to_vec()));
        let answer = c
            .call("X.y", json!({"a":1}), Some("s1"), Instant::now() + Duration::from_secs(2))
            .unwrap();
        assert_eq!(answer, json!({"x":2}));
        let sent = sink.lock().unwrap().clone();
        assert_eq!(sent.last(), Some(&0));
        let sent: Value = serde_json::from_slice(&sent[..sent.len() - 1]).unwrap();
        assert_eq!(sent["method"], "X.y");
        assert_eq!(sent["sessionId"], "s1");
        assert_eq!(c.next_event(Duration::from_secs(1)).unwrap().unwrap()["method"], "A");
        assert_eq!(c.next_event(Duration::from_secs(1)).unwrap().unwrap()["method"], "B");
    }

    #[test]
    fn a_message_without_a_terminator_or_over_the_limit_ends_the_connection() {
        let mut c = Connection::new(std::io::sink(), Cursor::new(b"{\"method\":\"A\"}".to_vec()));
        assert!(c.next_event(Duration::from_secs(1)).is_err());
        let mut long = vec![b'['; MESSAGE_LIMIT + 10];
        long.push(0);
        let mut c = Connection::new(std::io::sink(), Cursor::new(long));
        assert!(c.next_event(Duration::from_secs(1)).is_err());
    }
}
