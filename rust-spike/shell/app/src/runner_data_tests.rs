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
    let mut turn = ToolTurn::new(vec![read()], uuid::Uuid::new_v4().to_string()).unwrap();
    let event = |id: String, name: &str| json!({"call_id":id,"name":name,"arguments":{}});
    assert!(turn
        .dispatch(
            &event(format!("{}:1", turn.id), "scratchpad_append"),
            &tools
        )
        .is_err());
    let old = ToolTurn::new(vec![read()], uuid::Uuid::new_v4().to_string()).unwrap();
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
    assert!(ToolTurn::new(vec![read(), read()], "t".into()).is_err());
}
#[cfg(unix)]
mod socket {
    use super::*;
    use moss_shell_contract::ShellData;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::time::Duration;

    const ME: &str = "signed-in-user";

    struct Rig {
        root: std::path::PathBuf,
        listener: UnixListener,
    }
    impl Rig {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("js370-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("runner.secret"), "test-only-hello").unwrap();
            let listener = UnixListener::bind(root.join("runner.sock")).unwrap();
            Self { root, listener }
        }
        fn data(&self, limits: Limits) -> RunnerShellData {
            RunnerShellData::with_limits(
                self.root.clone(),
                ME.into(),
                Arc::new(Tools(AtomicUsize::new(0))),
                limits,
            )
        }
    }
    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// One accepted turn: the hello and chat lines are read, then `script` plays the runner.
    struct Runner {
        lines: std::io::Lines<BufReader<UnixStream>>,
        socket: UnixStream,
        chat: Value,
    }
    impl Runner {
        fn accept(listener: &UnixListener) -> Self {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut lines = BufReader::new(socket.try_clone().unwrap()).lines();
            let _hello = lines.next().unwrap().unwrap();
            let chat = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            Self { lines, socket, chat }
        }
        fn send(&mut self, v: Value) {
            writeln!(self.socket, "{v}").unwrap();
        }
        fn next(&mut self) -> Option<Value> {
            self.lines
                .next()
                .and_then(|l| l.ok())
                .and_then(|l| serde_json::from_str(&l).ok())
        }
    }

    fn wait_for(data: &RunnerShellData, what: &str, ok: impl Fn(&ChatThread) -> bool) -> ChatThread {
        for _ in 0..200 {
            let t = data.chat_thread();
            if ok(&t) {
                return t;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("timed out waiting for {what}: {:?}", data.chat_thread());
    }

    fn ask(id: u64) -> Value {
        json!({"event":"approval","id":id,
               "card":{"source":"agent","tool":"Bash","title":"agent supplied title","input":{"command":"ls /tmp"}}})
    }

    #[test]
    fn socket_bridge_forwards_results_and_explicit_conversation_boundary() {
        let rig = Rig::new();
        let listener = rig.listener.try_clone().unwrap();
        let task = std::thread::spawn(move || {
            for fresh in [false, true] {
                let mut runner = Runner::accept(&listener);
                assert_eq!(runner.chat["account"], ME);
                assert_eq!(runner.chat["fresh_conversation"], fresh);
                for (n, name, ok) in [
                    (1, "scratchpad_read", true),
                    (2, "scratchpad_append", false),
                ] {
                    let id = format!("{}:{n}", runner.chat["turn_id"].as_str().unwrap());
                    runner.send(json!({"event":"tool_call","call_id":id,"name":name,"arguments":{}}));
                    let reply = runner.next().unwrap();
                    assert_eq!(reply["op"], "tool_result");
                    assert_eq!(reply["call_id"], id);
                    assert_eq!(reply["ok"], ok);
                    if ok {
                        assert_eq!(reply["text"], "scratchpad:scratchpad.read");
                    }
                }
                runner.send(json!({"event":"done","text":"read complete"}));
            }
        });
        let data = rig.data(Limits::default());
        let continued: SendMessage =
            serde_json::from_value(json!({"text":"read my scratchpad"})).unwrap();
        assert!(!continued.fresh_conversation);
        // The call returns at once with the turn running; the reply arrives in the thread.
        assert!(data.send_message(&continued).unwrap().running);
        wait_for(&data, "first reply", |t| !t.running);
        let fresh: SendMessage =
            serde_json::from_value(json!({"text":"read it again", "fresh_conversation":true}))
                .unwrap();
        data.send_message(&fresh).unwrap();
        let t = wait_for(&data, "second reply", |t| !t.running);
        assert_eq!(t.messages.len(), 2);
        assert_eq!(t.messages[0].text, "read it again");
        assert_eq!(t.messages[1].text, "read complete");
        task.join().unwrap();
    }

    #[test]
    fn a_second_message_while_a_turn_runs_is_refused() {
        let rig = Rig::new();
        let listener = rig.listener.try_clone().unwrap();
        let (release, hold) = std::sync::mpsc::channel::<()>();
        let task = std::thread::spawn(move || {
            let _runner = Runner::accept(&listener);
            let _ = hold.recv();
        });
        let data = rig.data(Limits::default());
        let one = SendMessage {
            text: "one".into(),
            ..Default::default()
        };
        data.send_message(&one).unwrap();
        assert_eq!(data.send_message(&one).unwrap_err(), ChatError::Busy);
        assert_eq!(data.chat_thread().messages.len(), 1);
        release.send(()).unwrap();
        task.join().unwrap();
    }

    #[test]
    fn an_agent_permission_ask_is_answered_only_by_its_owner_through_the_record() {
        let rig = Rig::new();
        let listener = rig.listener.try_clone().unwrap();
        let task = std::thread::spawn(move || {
            let mut runner = Runner::accept(&listener);
            runner.send(ask(7));
            let answer = runner.next().unwrap();
            assert_eq!(answer, json!({"op":"answer","id":7,"allow":true}));
            runner.send(json!({"event":"done","text":"ok"}));
        });
        let data = rig.data(Limits::default());
        data.send_message(&SendMessage {
            text: "go".into(),
            ..Default::default()
        })
        .unwrap();
        let t = wait_for(&data, "pending card", |t| !t.approvals.is_empty());
        assert_eq!(t.status, "Waiting for your approval");
        let card = &t.approvals[0];
        assert_eq!(card.state, moss_shell_contract::ApprovalState::Pending);
        assert_eq!(card.title, "Permission request");
        assert!(card
            .fields
            .iter()
            .any(|f| f.label == "Command" && f.value == "ls /tmp"));
        let id = card.id.clone();
        assert_eq!(
            data.decide_approval("someone-else", &id, Decision::Approve)
                .unwrap_err(),
            ChatError::NotFound
        );
        assert!(data.chat_thread().approvals[0].state == moss_shell_contract::ApprovalState::Pending);
        data.decide_approval(ME, &id, Decision::Approve).unwrap();
        let t = wait_for(&data, "turn end", |t| !t.running);
        assert_eq!(t.approvals[0].state, moss_shell_contract::ApprovalState::Used);
        assert_eq!(t.messages[1].text, "ok");
        task.join().unwrap();
    }

    #[test]
    fn answering_a_card_after_the_idle_limit_does_not_end_the_turn() {
        let rig = Rig::new();
        let listener = rig.listener.try_clone().unwrap();
        let task = std::thread::spawn(move || {
            let mut runner = Runner::accept(&listener);
            runner.send(ask(5));
            let answer = runner.next().expect("no answer");
            assert_eq!(answer, json!({"op":"answer","id":5,"allow":true}));
            std::thread::sleep(Duration::from_millis(100));
            runner.send(json!({"event":"done","text":"finished"}));
        });
        let data = rig.data(Limits {
            idle: Duration::from_millis(400),
            ..Limits::default()
        });
        data.send_message(&SendMessage {
            text: "go".into(),
            ..Default::default()
        })
        .unwrap();
        let t = wait_for(&data, "pending card", |t| !t.approvals.is_empty());
        // The person takes longer than the idle limit to answer.
        std::thread::sleep(Duration::from_millis(900));
        data.decide_approval(ME, &t.approvals[0].id, Decision::Approve).unwrap();
        let t = wait_for(&data, "turn end", |t| !t.running);
        assert_eq!(t.messages[1].text, "finished", "{:?}", t.messages);
        task.join().unwrap();
    }

    #[test]
    fn an_unanswered_card_times_out_and_the_runner_is_told_no() {
        let rig = Rig::new();
        let listener = rig.listener.try_clone().unwrap();
        let task = std::thread::spawn(move || {
            let mut runner = Runner::accept(&listener);
            runner.send(ask(9));
            let answer = runner.next().expect("the runner was never answered");
            assert_eq!(answer, json!({"op":"answer","id":9,"allow":false}));
            runner.send(json!({"event":"done","text":"refused"}));
        });
        let data = rig.data(Limits {
            approval_ttl: Duration::from_millis(150),
            ..Limits::default()
        });
        data.send_message(&SendMessage {
            text: "go".into(),
            ..Default::default()
        })
        .unwrap();
        let t = wait_for(&data, "turn end", |t| !t.running && !t.approvals.is_empty());
        assert_eq!(t.approvals[0].state, moss_shell_contract::ApprovalState::TimedOut);
        let id = t.approvals[0].id.clone();
        assert_eq!(
            data.decide_approval(ME, &id, Decision::Approve).unwrap_err(),
            ChatError::Closed
        );
        task.join().unwrap();
    }

    #[test]
    fn an_expired_card_cannot_be_approved_even_before_the_sweep_runs() {
        let rig = Rig::new();
        let data = rig.data(Limits::default());
        let (mine, runner_end) = UnixStream::pair().unwrap();
        runner_end
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let id = uuid::Uuid::new_v4();
        {
            let mut st = data.inner.state.lock().unwrap();
            st.turn = Some(OpenTurn {
                writer: Arc::new(Mutex::new(Box::new(mine))),
            });
            st.book.add(crate::chat_approvals::Record {
                id,
                actor: ME.into(),
                turn: "t".into(),
                kind: moss_shell_contract::ApprovalKind::Permission,
                runner_id: 5,
                title: "t".into(),
                fields: vec![],
                expires: Instant::now() - Duration::from_secs(1),
                state: moss_shell_contract::ApprovalState::Pending,
            });
        }
        assert_eq!(
            data.decide_approval(ME, &id.to_string(), Decision::Approve)
                .unwrap_err(),
            ChatError::Closed
        );
        let mut line = String::new();
        BufReader::new(runner_end).read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({"op":"answer","id":5,"allow":false})
        );
    }

    #[test]
    fn the_turn_limit_ends_a_stuck_turn_and_voids_its_card() {
        let rig = Rig::new();
        let listener = rig.listener.try_clone().unwrap();
        let task = std::thread::spawn(move || {
            let mut runner = Runner::accept(&listener);
            runner.send(ask(3));
            // The server gives up and closes the socket.
            while runner.next().is_some() {}
        });
        let data = rig.data(Limits {
            turn: Duration::from_millis(400),
            ..Limits::default()
        });
        data.send_message(&SendMessage {
            text: "go".into(),
            ..Default::default()
        })
        .unwrap();
        let t = wait_for(&data, "turn limit", |t| !t.running);
        assert!(t.messages[1].text.contains("15 minute limit"), "{:?}", t.messages);
        assert_eq!(t.approvals[0].state, moss_shell_contract::ApprovalState::Voided);
        let id = t.approvals[0].id.clone();
        assert_eq!(
            data.decide_approval(ME, &id, Decision::Approve).unwrap_err(),
            ChatError::Closed
        );
        task.join().unwrap();
    }

    #[test]
    fn a_module_tool_card_is_refused_until_part_3b() {
        let rig = Rig::new();
        let listener = rig.listener.try_clone().unwrap();
        let task = std::thread::spawn(move || {
            let mut runner = Runner::accept(&listener);
            runner.send(json!({"event":"approval","id":4,"card":{"source":"moss","tool":"scratchpad_append","input":{}}}));
            assert_eq!(
                runner.next().unwrap(),
                json!({"op":"answer","id":4,"allow":false})
            );
            runner.send(json!({"event":"done","text":"declined"}));
        });
        let data = rig.data(Limits::default());
        data.send_message(&SendMessage {
            text: "go".into(),
            ..Default::default()
        })
        .unwrap();
        let t = wait_for(&data, "turn end", |t| !t.running);
        assert!(t.approvals.is_empty());
        assert!(t.messages[1].text.contains("declined"));
        task.join().unwrap();
    }
}
