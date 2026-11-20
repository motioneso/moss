//! Real installed component, host approvals, account lifecycle and two-person privacy.
mod support;
use serde_json::{json, Value};
use support::{install::Installed, Fixture};
use uuid::Uuid;
const MARK: &str = "PLANTED-CHAT-PRIVATE-8e";

struct World {
    f: Fixture,
    app: Installed,
}
impl World {
    fn new() -> Self {
        let f = Fixture::new();
        let app = support::install::install(&f);
        Self { f, app }
    }
    fn route(&self, actor: Uuid, method: &str, path: &str, body: Value) -> Value {
        serde_json::from_str(
            &self
                .app
                .app
                .dispatch_extended(
                    self.f.access(actor),
                    method,
                    &format!("/api/m/scratchpad{path}"),
                    &body.to_string(),
                )
                .unwrap(),
        )
        .unwrap()
    }
    fn api(&self, actor: Uuid, name: &str, parameters: Value) -> anyhow::Result<Value> {
        Ok(serde_json::from_str(&self.app.app.installer.call(
            "scratchpad",
            self.f.access(actor),
            "api",
            &json!({"name":name,"parameters":parameters}).to_string(),
        )?)?)
    }
    fn approved(&self, actor: Uuid, parameters: &Value) {
        self.app
            .app
            .services
            .approve_tool(
                &self.f.access(actor),
                "scratchpad",
                "scratchpad.append",
                parameters,
            )
            .unwrap();
    }
}
#[test]
#[ignore = "Only through verify-gate"]
fn approval_is_exact_account_bound_one_use_and_append_updates_the_same_note() {
    let w = World::new();
    let a = w.f.a;
    let b = w.f.b;
    w.route(
        a,
        "PUT",
        "/note",
        json!({"body":format!("{MARK}😀"),"revision":0}),
    );
    let input = json!({"text":format!(" {MARK} appended ")});
    let card = w.api(a, "prepareScratchpadAction", input.clone()).unwrap();
    assert_eq!(card["revision"], 1);
    assert_eq!(card["characterCount"], MARK.len() + 2);
    assert_eq!(
        card["fields"],
        json!([{"label":"Text to append","value":format!(" {MARK} appended ")}])
    );
    assert_eq!(
        w.route(a, "GET", "/note", Value::Null)["body"]["revision"],
        1
    );
    assert_eq!(
        w.route(a, "POST", "/chat/append", input.clone())["status"],
        500,
        "no approval"
    );
    w.approved(a, &input);
    assert_eq!(
        w.route(b, "POST", "/chat/append", input.clone())["status"],
        500,
        "another account cannot use a grant"
    );
    assert_eq!(
        w.route(a, "POST", "/chat/append", json!({"text":"different"}))["status"],
        500,
        "different text cannot use a grant"
    );
    assert_eq!(
        w.route(a, "POST", "/chat/append", input.clone())["body"]["data"]["appended"],
        format!("\n{MARK} appended")
    );
    assert_eq!(
        w.route(a, "POST", "/chat/append", input)["status"],
        500,
        "grant consumed"
    );
    let note = w.route(a, "GET", "/note", Value::Null);
    assert_eq!(note["body"]["body"], format!("{MARK}😀\n{MARK} appended"));
    assert_eq!(note["body"]["revision"], 2);
    let read = w.route(a, "GET", "/chat/read", Value::Null);
    assert_eq!(read["body"]["data"]["body"], note["body"]["body"]);
    assert_eq!(
        w.route(b, "GET", "/chat/read", Value::Null)["body"]["data"]["body"],
        ""
    );
    let activity = w
        .app
        .app
        .services
        .activity("scratchpad", &w.f.access(a))
        .unwrap();
    assert!(!serde_json::to_string(&activity).unwrap().contains(MARK));
    let tables:Vec<String>=w.f.rt.block_on(w.f.root.query(
        "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('moss_queue','moss_modules') OR table_name IN ('moss_activity_detail','moss_error_log','moss_action_audit_log','moss_model_activity_log')",&[])).unwrap().iter().map(|r|r.get(0)).collect();
    assert!(tables.iter().any(|t| t.starts_with("moss_queue.")));
    for table in &tables {
        let hits: i64 =
            w.f.rt
                .block_on(w.f.root.query_one(
                    &format!(
                        "SELECT count(*) FROM {table} t WHERE to_jsonb(t)::text LIKE '%'||$1||'%'"
                    ),
                    &[&MARK],
                ))
                .unwrap()
                .get(0);
        assert_eq!(hits, 0, "{table} contains private text");
    }
    w.route(
        a,
        "PUT",
        "/note",
        json!({"body":"x".repeat(64000),"revision":2}),
    );
    let full = json!({"text":"y"});
    w.approved(a, &full);
    assert_eq!(
        w.route(a, "POST", "/chat/append", full)["body"]["data"]["error"],
        "Scratchpad is full"
    );
    println!("PASS chat privacy: scanned {} queue/module/activity tables; full note refused without a write",tables.len());
    println!("PASS stored-record card, exact account-bound one-use approval, chat append and route read agree");
}
#[test]
#[ignore = "Only through verify-gate"]
fn export_and_delete_touch_only_the_callers_note_and_reject_account_overrides() {
    let w = World::new();
    let a = w.f.a;
    let b = w.f.b;
    for (actor, text) in [(a, "private alpha"), (b, "private beta")] {
        w.route(actor, "POST", "/append", json!({"text":text}));
    }
    let exported = w
        .api(a, "collectScratchpadExportSection", json!({}))
        .unwrap();
    assert_eq!(exported["scratchpad"]["body"], "private alpha");
    assert_eq!(exported["scratchpad"].as_object().unwrap().len(), 5);
    assert!(!exported.to_string().contains("beta"));
    assert!(w
        .api(a, "deleteScratchpadAccountData", json!({"userId":b}))
        .is_err());
    assert_eq!(
        w.api(w.f.admin, "deleteScratchpadAccountData", json!({}))
            .unwrap()["deleted"],
        0
    );
    assert_eq!(
        w.api(a, "deleteScratchpadAccountData", json!({})).unwrap()["deleted"],
        1
    );
    assert_eq!(
        w.api(a, "deleteScratchpadAccountData", json!({})).unwrap()["deleted"],
        0
    );
    assert_eq!(
        w.api(a, "collectScratchpadExportSection", json!({}))
            .unwrap(),
        json!({"scratchpad":null})
    );
    assert_eq!(
        w.route(b, "GET", "/note", Value::Null)["body"]["body"],
        "private beta"
    );
    // Observe the identical actor-isolation assertion fail with the protection removed.
    w.f.rt
        .block_on(
            w.f.root
                .batch_execute("ALTER TABLE app.scratchpads DISABLE ROW LEVEL SECURITY"),
        )
        .unwrap();
    let red = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert_eq!(
            w.api(a, "collectScratchpadExportSection", json!({}))
                .unwrap(),
            json!({"scratchpad":null})
        );
    }));
    w.f.rt.block_on(w.f.root.batch_execute("ALTER TABLE app.scratchpads ENABLE ROW LEVEL SECURITY; ALTER TABLE app.scratchpads FORCE ROW LEVEL SECURITY")).unwrap();
    assert!(
        red.is_err(),
        "protection removal must break the isolation assertion"
    );
    assert_eq!(
        w.api(a, "collectScratchpadExportSection", json!({}))
            .unwrap(),
        json!({"scratchpad":null})
    );
    println!("RED/GREEN: account export isolation assertion fails with RLS off, passes with RLS restored");
}
#[test]
#[ignore = "Only through verify-gate"]
fn tool_replies_match_the_real_legacy_handlers() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let w = World::new();
    let read = json!({"tool":"scratchpad.read","parameters":{}});
    let add = |p: Value| json!({"tool":"scratchpad.append","parameters":p});
    let steps = vec![
        read.clone(),
        add(json!({})),
        add(json!({"text":3})),
        add(json!({"text":" \n "})),
        add(json!({"text":"  first😀  "})),
        read.clone(),
        add(json!({"text":"😀".repeat(1001)})),
        add(json!({"text":"\u{feff}second\u{a0}"})),
        read,
    ];
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", "modules/scratchpad/tools/tools-oracle.ts"])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!({"actor":w.f.a,"steps":steps}).to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Old tool oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    for (step, mut expected) in steps.iter().zip(expected) {
        let mut actual: Value = serde_json::from_str(
            &w.app
                .app
                .installer
                .call_tool_for_test("scratchpad", w.f.access(w.f.b), &step.to_string())
                .unwrap(),
        )
        .unwrap();
        expected["data"]
            .as_object_mut()
            .unwrap()
            .remove("updatedAt");
        actual["data"].as_object_mut().unwrap().remove("updatedAt");
        // The Rust chat drawer additionally consumes this after-the-fact acceptance row.
        // Its exact content is asserted by the installed chat append test below.
        actual["data"].as_object_mut().unwrap().remove("changed");
        assert_eq!(actual, expected, "tool parity mismatch");
    }
    println!(
        "PASS replay: {} actual legacy tool steps match the installed Wasm guest",
        steps.len()
    );
}

#[test]
#[ignore = "Only through verify-gate"]
fn chat_append_uses_the_installed_schema_adapter_and_done_result() {
    let w = World::new();
    let access = w.f.access(w.f.a);
    let tools = w.app.app.installer.chat_tools(&access).unwrap();
    let append = tools.iter().find(|t| t.tool == "scratchpad.append").unwrap();
    assert_eq!(append.rule, moss_module_host::chat_tools::ChatToolRule::RunUnlessPolicy);
    let parameters = json!({"text":"Chat line"});
    let card = w.app.app.installer.chat_tool_card(&access, "scratchpad", "scratchpad.append", &parameters).unwrap().unwrap();
    assert_eq!(card.title, "Action request");
    assert_eq!(card.fields[0].value, "Your scratchpad");
    assert_eq!(card.fields[1].value, "Chat line");
    let output = w.app.app.installer.run_chat_tool(&access, "scratchpad", "scratchpad.append", parameters).unwrap();
    assert_eq!(output["data"]["changed"], json!([{"label":"Text appended","before":"","after":"Chat line"}]));
    assert_eq!(w.route(w.f.a, "GET", "/note", Value::Null)["body"]["body"], "Chat line");
    w.app.app.services.set_action_policy(&access, "scratchpad", &std::collections::BTreeMap::from([("scratchpad.append".into(), true)])).unwrap();
    let tools = w.app.app.installer.chat_tools(&access).unwrap();
    assert_eq!(tools.iter().find(|t| t.tool == "scratchpad.append").unwrap().rule, moss_module_host::chat_tools::ChatToolRule::Card { pinned: false });
    let parameters = json!({"text":"記".repeat(2000)});
    assert!(w.app.app.installer.run_chat_tool(&access, "scratchpad", "scratchpad.append", parameters.clone()).is_err());
    let card = w.app.app.installer.chat_tool_card(&access, "scratchpad", "scratchpad.append", &parameters).unwrap().unwrap();
    assert_eq!(card.fields[1..].iter().map(|f| f.value.as_str()).collect::<String>(), parameters["text"].as_str().unwrap());
    w.app.app.installer.run_approved_chat_tool(&access, "scratchpad", "scratchpad.append", parameters, card.version.as_deref()).unwrap();
    assert_eq!(w.route(w.f.a, "GET", "/note", Value::Null)["body"]["body"], format!("Chat line\n{}", "記".repeat(2000)));
}
