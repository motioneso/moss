use crate::support::Fixture;
use moss_module_host::application::Application;
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
use uuid::Uuid;

pub fn compare(app: &Application, f: &Fixture) {
    let paths = vec![
        "/events".to_string(),
        format!("/events/{}", f.event),
        format!("/events/{}", Uuid::new_v4()),
        "/briefing-settings".to_string(),
    ];
    for actor in [f.a, f.b, f.admin] {
        let mut child = Command::new("pnpm")
            .args(["exec", "tsx", "modules/calendar/tools/read-oracle.ts"])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(json!({
            "actor":actor,"paths":paths.iter().map(|p|format!("/api/calendar{p}")).collect::<Vec<_>>()
        }).to_string().as_bytes()).unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "Production HTTP oracle failed (database diagnostics omitted)"
        );
        let expected: Vec<Value> = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(
            expected.len(),
            paths.len(),
            "Read oracle omitted a response"
        );
        for (path, expected) in paths.iter().zip(expected) {
            let raw = app
                .dispatch_extended(
                    f.access(actor),
                    "GET",
                    &format!("/api/m/calendar{path}"),
                    "null",
                )
                .unwrap();
            let actual: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                json!({"status":actual["status"],"body":actual["body"]}),
                expected,
                "Installed Wasm differs from production HTTP route at {path}"
            );
        }
    }
    println!("PASS 12 installed-Wasm / production HTTP read comparisons (owner, foreign, admin)");
}
