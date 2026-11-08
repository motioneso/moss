//! The public API preserves the legacy presentation without granting or executing it.
use moss_module_sdk::{Error, Host, Result};
use moss_notes::guest::handle;
use serde_json::{json, Value};
use std::collections::BTreeMap;

struct ReadOnly {
    files: BTreeMap<String, String>,
}
impl Host for ReadOnly {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        match (port, operation, resource) {
            ("vault", "folder.resolve", "source") => {
                assert_eq!(p, json!({}));
                Ok(json!({"status":200,"body":"/notes"}))
            }
            ("vault", "notes.read", "source") => {
                let path = p["path"].as_str().unwrap();
                Ok(
                    json!({"path":path,"destinationId":"bound-destination","content":self.files.get(path)}),
                )
            }
            _ => Err(Error::new("Approval attempted a non-read operation")),
        }
    }
}

#[test]
fn installed_api_envelope_matches_legacy_approval_fields_and_input_order() {
    #[derive(serde::Deserialize)]
    struct Case {
        files: BTreeMap<String, String>,
        request: Box<serde_json::value::RawValue>,
        expected: Value,
    }
    for line in include_str!("approval-vectors.jsonl").lines() {
        let case: Case = serde_json::from_str(line).unwrap();
        #[derive(serde::Deserialize)]
        struct Input {
            tool: String,
            parameters: Box<serde_json::value::RawValue>,
        }
        let input: Input = serde_json::from_str(case.request.get()).unwrap();
        let request = json!({"name":"prepareNoteAction","parameters":{"tool":input.tool,"inputJson":input.parameters.get()}}).to_string();
        let out = handle(&ReadOnly { files: case.files }, "api", &request).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"ok":case.expected})
        );
    }
}

#[test]
fn invalid_approval_fields_return_null_before_any_host_access() {
    struct NoCalls;
    impl Host for NoCalls {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
            panic!("Invalid presentation reached host")
        }
    }
    for parameters in [
        json!({"tool":"notes.create","parameters":{"path":"a.md"}}),
        json!({"tool":"notes.create","parameters":{"path":"a.md","content":null}}),
        json!({"tool":"notes.create","parameters":{"path":"a.md","content":"x","overwrite":null}}),
        json!({"tool":"notes.edit","parameters":{"path":"a.md","oldText":"old","newText":3}}),
        json!({"tool":"notes.delete","parameters":{"path":"a.md","actorUserId":"other"}}),
        json!({"tool":"notes.delete","parameters":{"path":3}}),
    ] {
        let out = handle(&NoCalls,"api",&json!({"name":"prepareNoteAction","parameters":{"tool":parameters["tool"],"inputJson":parameters["parameters"].to_string()}}).to_string()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({"ok":null})
        );
    }
    for request in [
        json!({"name":"prepareNoteAction","parameters":{"tool":"notes.search","parameters":{}}}),
        json!({"name":"prepareNoteAction","parameters":{"tool":"notes.delete","parameters":{"path":"a.md"}},"actorUserId":"other"}),
        json!({"name":"collectManagedNotesExportSection","parameters":{"tool":"notes.delete","parameters":{"path":"a.md"}}}),
    ] {
        assert!(handle(&NoCalls, "api", &request.to_string()).is_err());
    }
}

#[test]
fn prerequisite_errors_are_typed_and_backend_messages_are_not_returned() {
    struct Source(Value);
    impl Host for Source {
        fn call(&self, port: &str, operation: &str, _: &str, _: Value) -> Result<Value> {
            assert_eq!((port, operation), ("vault", "folder.resolve"));
            Ok(self.0.clone())
        }
    }
    let payload = json!({"name":"prepareNoteAction","parameters":{"tool":"notes.delete","inputJson":r#"{"path":"note.md"}"#}}).to_string();
    for (status, message) in [
        (409, "Notes source is not configured"),
        (
            400,
            "Notes source path does not exist or cannot be resolved",
        ),
        (400, "Notes source path is not within an allowed notes root"),
        (503, "Notes roots not configured on this server"),
    ] {
        let host = Source(json!({"status":status,"body":{"error":message}}));
        let out: Value = serde_json::from_str(&handle(&host, "api", &payload).unwrap()).unwrap();
        assert_eq!(out, json!({"error":{"statusCode":status,"error":message}}));
    }
    for host in [
        Source(json!({"status":500,"body":{"error":"Synthetic private backend diagnostic"}})),
        Source(json!({"status":400,"body":{"error":"Notes roots not configured on this server"}})),
    ] {
        let out: Value = serde_json::from_str(&handle(&host, "api", &payload).unwrap()).unwrap();
        assert_eq!(
            out,
            json!({"error":{"statusCode":503,"error":"Notes service is unavailable"}})
        );
    }
}
