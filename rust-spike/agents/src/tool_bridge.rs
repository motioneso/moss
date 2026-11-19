//! One socket turn's module calls. The server owns module execution.
use crate::gateway::{ToolDef, ToolFuture, ToolHost};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

type Reply = Result<String, String>;
type SendEvent = Arc<dyn Fn(Value) -> bool + Send + Sync>;
struct State {
    next: u64,
    closed: bool,
    pending: HashMap<String, oneshot::Sender<Reply>>,
}
#[derive(Clone)]
pub struct ToolBridge {
    account: String,
    turn: String,
    send: SendEvent,
    state: Arc<Mutex<State>>,
    timeout: Duration,
}
impl ToolBridge {
    pub fn new(account: String, turn: String, send: SendEvent) -> Self {
        Self {
            account,
            turn,
            send,
            state: Arc::new(Mutex::new(State {
                next: 0,
                closed: false,
                pending: HashMap::new(),
            })),
            timeout: Duration::from_secs(300),
        }
    }
    pub fn result(&self, call_id: &str, ok: bool, text: String) -> bool {
        let tx = self.state.lock().unwrap().pending.remove(call_id);
        tx.is_some_and(|tx| tx.send(if ok { Ok(text) } else { Err(text) }).is_ok())
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.pending.clear();
    }
}
impl ToolHost for ToolBridge {
    fn tools(&self, _: &str) -> Vec<ToolDef> {
        vec![]
    }
    fn call(&self, account: &str, name: &str, args: Value) -> ToolFuture {
        if account != self.account {
            return Box::pin(async { Err("Wrong bridge account".into()) });
        }
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Box::pin(async { Err("The tool turn has ended".into()) });
        }
        state.next += 1;
        let id = format!("{}:{}", self.turn, state.next);
        let (tx, rx) = oneshot::channel();
        state.pending.insert(id.clone(), tx);
        if !(self.send)(json!({"event":"tool_call", "call_id":id, "name":name, "arguments":args})) {
            state.pending.remove(&id);
        }
        drop(state);
        let bridge = self.clone();
        Box::pin(async move {
            let result = match tokio::time::timeout(bridge.timeout, rx).await {
                Ok(Ok(reply)) => reply,
                _ => Err("The server did not return a tool result before the turn ended".into()),
            };
            bridge.state.lock().unwrap().pending.remove(&id);
            result
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn bridge() -> (ToolBridge, tokio::sync::mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            ToolBridge::new(
                "a".into(),
                "turn-a".into(),
                Arc::new(move |v| tx.send(v).is_ok()),
            ),
            rx,
        )
    }
    #[tokio::test]
    async fn results_are_bound_to_the_pending_call_and_consumed_once() {
        let (b, mut events) = bridge();
        let refused = b.call("other", "scratchpad_read", json!({}));
        assert!(events.try_recv().is_err(), "wrong account emitted a call");
        assert!(refused.await.is_err());
        let call = b.call("a", "scratchpad_read", json!({}));
        let event = events.recv().await.unwrap();
        assert_eq!(event["name"], "scratchpad_read");
        assert!(!b.result("turn-b:1", true, "other user's result".into()));
        assert!(b.result(event["call_id"].as_str().unwrap(), true, "real note".into()));
        assert_eq!(call.await.unwrap(), "real note");
        assert!(!b.result("turn-a:1", true, "replayed".into()));
    }
    #[tokio::test]
    async fn timeout_disconnect_and_late_calls_return_errors() {
        let (mut b, _events) = bridge();
        b.timeout = Duration::from_millis(1);
        assert!(b.call("a", "read", json!({})).await.is_err());
        let (b, _events) = bridge();
        let call = b.call("a", "read", json!({}));
        b.close();
        assert!(call.await.is_err());
        assert!(b.call("a", "read", json!({})).await.is_err());
    }
}
