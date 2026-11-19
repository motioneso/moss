use super::*;
use crate::chat_tools::ChatTools;
use moss_agents::gateway::ToolDef;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
struct Tools(AtomicUsize);
fn read() -> ToolDef {
    let mut def = moss_agents::builtins::current_time();
    def.name = "scratchpad_read".into();
    def.module = Some("scratchpad".into());
    def
}
impl ChatTools for Tools {
    fn list(&self) -> Result<Vec<ToolDef>, String> {
        Ok(vec![read()])
    }
    fn run(&self, module: &str, tool: &str, args: Value) -> Result<String, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        assert_eq!(args, json!({}));
        Ok(format!("{module}:{tool}"))
    }
}
#[test]
fn forged_names_old_turns_and_repeated_ids_do_not_dispatch() {
    let tools = Tools(AtomicUsize::new(0));
    let mut turn = ToolTurn::new(vec![read()]).unwrap();
    let event = |id: String, name: &str| json!({"call_id":id,"name":name,"arguments":{}});
    assert!(turn
        .dispatch(
            &event(format!("{}:1", turn.id), "scratchpad_append"),
            &tools
        )
        .is_err());
    let old = ToolTurn::new(vec![read()]).unwrap();
    assert!(turn
        .dispatch(&event(format!("{}:2", old.id), "scratchpad_read"), &tools)
        .is_err());
    assert_eq!(tools.0.load(Ordering::SeqCst), 0);
    let call = event(format!("{}:3", turn.id), "scratchpad_read");
    assert_eq!(
        turn.dispatch(&call, &tools).unwrap(),
        "scratchpad:scratchpad.read"
    );
    assert!(turn.dispatch(&call, &tools).is_err());
    assert_eq!(tools.0.load(Ordering::SeqCst), 1);
}
#[test]
fn duplicate_wire_names_prevent_a_turn_from_opening() {
    assert!(ToolTurn::new(vec![read(), read()]).is_err());
}
#[cfg(unix)]
#[test]
fn socket_bridge_returns_real_executor_results_and_errors() {
    use std::os::unix::net::UnixListener;
    let root = std::env::temp_dir().join(format!("js368-socket-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("runner.secret"), "test-only-hello").unwrap();
    let listener = UnixListener::bind(root.join("runner.sock")).unwrap();
    let task = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut lines = BufReader::new(socket.try_clone().unwrap()).lines();
        let _hello = lines.next().unwrap().unwrap();
        let chat: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        assert_eq!(chat["account"], "signed-in-user");
        for (n, name, ok) in [
            (1, "scratchpad_read", true),
            (2, "scratchpad_append", false),
        ] {
            let call = json!({"event":"tool_call", "call_id":format!("{}:{n}",chat["turn_id"].as_str().unwrap()),"name":name,"arguments":{}});
            writeln!(socket, "{call}").unwrap();
            let reply: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            assert_eq!(reply["op"], "tool_result");
            assert_eq!(reply["call_id"], call["call_id"]);
            assert_eq!(reply["ok"], ok);
            if ok {
                assert_eq!(reply["text"], "scratchpad:scratchpad.read");
            }
        }
        writeln!(socket, "{}", json!({"event":"done","text":"read complete"})).unwrap();
    });
    let data = RunnerShellData::new(
        root.clone(),
        "signed-in-user".into(),
        Arc::new(Tools(AtomicUsize::new(0))),
    );
    assert_eq!(
        data.ask_runner("read my scratchpad").unwrap(),
        ("read complete".into(), 0)
    );
    task.join().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
