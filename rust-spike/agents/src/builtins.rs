//! Runner-local tools. Module execution is supplied by the server bridge in part 2b.
use crate::approvals::{Risk, ToolFacts};
use crate::gateway::{ToolDef, ToolFuture, ToolHost};
use serde_json::{json, Value};

pub struct BuiltinTools;

pub fn current_time() -> ToolDef {
    ToolDef {
        name: "current_time".into(),
        module: None,
        description: "The current date and time on the Moss server, in UTC.".into(),
        input_schema: json!({"type":"object", "properties":{}}),
        facts: ToolFacts {
            risk: Risk::Read,
            is_external: false,
            execution_auto: true,
            confirm_under_yolo: false,
            family: None,
        },
    }
}

impl ToolHost for BuiltinTools {
    fn tools(&self, _: &str) -> Vec<ToolDef> {
        vec![current_time()]
    }
    fn call(&self, _: &str, name: &str, _: Value) -> ToolFuture {
        match name {
            "current_time" => Box::pin(async {
                let secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_secs();
                Ok(format!("Unix time {secs} (UTC)."))
            }),
            // Explicitly opted-in debug builds used by the live kill gate.
            #[cfg(all(debug_assertions, feature = "live-proof"))]
            name if name.starts_with("proof_") => Box::pin(async {
                Ok(format!(
                    "Live runner challenge: {}",
                    crate::hello::random_secret()
                ))
            }),
            _ => Box::pin(async {
                Err("Module tool execution arrives with the server bridge.".into())
            }),
        }
    }
}
