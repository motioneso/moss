//! Shared oracle boundary stand-in. Never used by the release component.
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};
use std::cell::RefCell;

pub struct SyncHost<'a> {
    pub case: &'a Value,
    pub calls: RefCell<Vec<Value>>,
}
impl Host for SyncHost<'_> {
    fn call(&self, port: &str, operation: &str, resource: &str, p: Value) -> Result<Value> {
        assert_eq!((port, resource), ("vault", "source"));
        match operation {
            "index.sync-open" => {
                assert_eq!(p, json!({"sourcePath":self.case["payload"]["sourcePath"]}));
                let source = p["sourcePath"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| self.case["source"].as_str().filter(|s| !s.is_empty()));
                if let Some(stage) = self.case["openFailure"].as_str() {
                    return Ok(json!({"error":if stage == "walk" { "EACCES" } else { "Error" }}));
                }
                if source.is_none() {
                    return Ok(json!({"sourcePath":null}));
                }
                Ok(json!({"sourcePath":source,
                    "resolvedSourcePath":self.case["resolvedSource"].as_str().or(source),
                    "files":self.case["files"]}))
            }
            "index.sync-file" => {
                assert_eq!(p["sourcePath"], "/notes");
                let file = p["filePath"].as_str().unwrap();
                if let Some(code) = self.case["resolveFailures"][file].as_str() {
                    return Ok(json!({"error":code}));
                }
                let resolved = self.case["resolvedFiles"][file].as_str().unwrap_or(file);
                let mut call = p.as_object().unwrap().clone();
                call.insert("filePath".into(), json!(resolved));
                call.remove("sourcePath");
                self.calls.borrow_mut().push(Value::Object(call));
                if let Some(code) = self.case["failures"][file].as_str() {
                    return Ok(json!({"error":code}));
                }
                let mut result = self.case["results"][resolved]
                    .as_object()
                    .map(|v| Value::Object(v.clone()))
                    .unwrap_or(json!({"status":"ingested","chunksProcessed":1}));
                result["filePath"] = json!(resolved);
                Ok(result)
            }
            "index.sync-canonical" => {
                let file = p["filePath"].as_str().unwrap();
                self.calls.borrow_mut().push(json!({"canonical":file}));
                if let Some(code) = self.case["resolveFailures"][file].as_str() {
                    return Ok(json!({"error":code}));
                }
                Ok(json!({"path":self.case["resolvedFiles"][file].as_str().unwrap_or(file)}))
            }
            "index.sync-indexed" => {
                self.calls.borrow_mut().push(json!({"indexed":true}));
                if self.case["purgeFailure"] == true {
                    return Ok(json!({"error":"EACCES"}));
                }
                Ok(json!({"paths":self.case["indexed"].as_array().cloned().unwrap_or_default()}))
            }
            "index.sync-remove" => {
                let path = &p["filePath"];
                self.calls.borrow_mut().extend([
                    json!({"deleteChunks":{"path":path,"kind":"notes"}}),
                    json!({"replaceLinks":{"path":path,"links":[]}}),
                    json!({"deleteIndex":{"path":path,"kind":"notes"}}),
                ]);
                Ok(json!({}))
            }
            _ => panic!("Unexpected sync operation: {operation}"),
        }
    }
}
