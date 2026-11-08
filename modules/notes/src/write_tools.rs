//! Write-tool execution checkpoint. The shipped manifest does not offer these tools yet:
//! the core memory/sync worker and approval orchestration must be joined first.
use moss_module_sdk::{Error, Host, Result};
use serde::{
    de::{MapAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    tool: String,
    parameters: Parameters,
}
// Retain submitted field order without randomized maps, which need WASI entropy.
struct Parameters {
    values: Value,
    order: Vec<String>,
}
impl<'de> Deserialize<'de> for Parameters {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> core::result::Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Parameters;
            fn expecting(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                formatter.write_str("Notes parameters object")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut fields: M,
            ) -> core::result::Result<Parameters, M::Error> {
                let mut values = serde_json::Map::new();
                let mut order = Vec::new();
                while let Some((key, value)) = fields.next_entry::<String, Value>()? {
                    if !values.contains_key(&key) {
                        order.push(key.clone());
                    }
                    values.insert(key, value);
                }
                Ok(Parameters {
                    values: Value::Object(values),
                    order,
                })
            }
        }
        deserializer.deserialize_map(Fields)
    }
}
struct Input<'a> {
    tool: &'a str,
    raw: &'a Value,
}
impl<'a> Input<'a> {
    fn parse(request: &'a Request) -> Result<Self> {
        let keys: &[&str] = match request.tool.as_str() {
            "notes.create" => &["path", "content", "overwrite"],
            "notes.edit" => &["path", "oldText", "newText"],
            "notes.delete" => &["path"],
            _ => return Err(failure(400, "Unknown Notes write tool")),
        };
        let raw = &request.parameters.values;
        if !raw
            .as_object()
            .is_some_and(|p| p.keys().all(|k| keys.contains(&k.as_str())))
        {
            return Err(failure(400, "Invalid Notes input"));
        }
        match request.tool.as_str() {
            "notes.create" => {
                if !raw["content"].is_string() {
                    return Err(failure(400, "content must be a string"));
                }
                if raw.get("overwrite").is_some_and(|v| !v.is_boolean()) {
                    return Err(failure(400, "overwrite must be a boolean"));
                }
            }
            "notes.edit" => {
                if !raw["oldText"].is_string() || !raw["newText"].is_string() {
                    return Err(failure(400, "oldText and newText must be strings"));
                }
                if raw["oldText"] == "" {
                    return Err(failure(400, "oldText must be non-empty"));
                }
            }
            _ => (),
        }
        Ok(Self {
            tool: &request.tool,
            raw,
        })
    }
}
fn failure(status: u16, message: &str) -> Error {
    Error::new(json!({"statusCode":status,"error":message}).to_string())
}
fn call(
    host: &impl Host,
    port: &str,
    operation: &str,
    resource: &str,
    parameters: Value,
) -> Result<Value> {
    host.call(port, operation, resource, parameters)
        .map_err(|_| failure(503, "Notes service is unavailable"))
}
fn source(host: &impl Host) -> Result<String> {
    let value = call(host, "vault", "folder.resolve", "source", json!({}))?;
    if value["status"] != 200 {
        // Only these fixed prerequisite messages may cross the tool boundary.
        // Backend errors and arbitrary host text remain the safe service error.
        let message = value["body"]["error"].as_str().unwrap_or("");
        let status = match message {
            "Notes source is not configured" => 409,
            "Notes source path does not exist or cannot be resolved"
            | "Notes source path is not within an allowed notes root" => 400,
            "Notes roots not configured on this server" => 503,
            _ => return Err(failure(503, "Notes service is unavailable")),
        };
        if value["status"] != status {
            return Err(failure(503, "Notes service is unavailable"));
        }
        return Err(failure(status, message));
    }
    value["body"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| failure(409, "Notes source is not configured"))
}
fn relative(raw: &Value, root: &str) -> Result<String> {
    let invalid = || failure(400, "path must be a relative Markdown path");
    let path = raw.as_str().ok_or_else(invalid)?;
    let prefix = format!("{}/", root.trim_end_matches('/'));
    let path = if path.starts_with('/') {
        path.strip_prefix(&prefix).unwrap_or(path)
    } else {
        path
    };
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\0')
        || !path.ends_with(".md")
        || path.split(['/', '\\']).any(|p| p == "..")
    {
        return Err(invalid());
    }
    // POSIX normalization from the existing tool contract. VaultContext may impose
    // stricter platform/path checks, notably for backslashes and symlink descendants.
    Ok(path
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect::<Vec<_>>()
        .join("/"))
}
fn read(host: &impl Host, path: &str) -> Result<Value> {
    let note = call(host, "vault", "notes.read", "source", json!({"path":path}))?;
    if !note["destinationId"].is_string()
        || note
            .get("content")
            .is_none_or(|v| !v.is_null() && !v.is_string())
    {
        return Err(failure(503, "Notes service is unavailable"));
    }
    Ok(note)
}
fn validate_existing(input: &Input<'_>, note: &Value) -> Result<()> {
    if input.tool == "notes.create" {
        if input.raw["overwrite"] != true && !note["content"].is_null() {
            return Err(failure(409, "Note already exists"));
        }
    } else if note["content"].is_null() {
        return Err(failure(409, "Note no longer exists"));
    }
    Ok(())
}

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let request: Request =
        serde_json::from_str(payload).map_err(|_| failure(400, "Invalid Notes input"))?;
    let input = Input::parse(&request)?;
    let root = source(host)?;
    let path = relative(&input.raw["path"], &root)?;
    let note = read(host, &path)?;
    validate_existing(&input, &note)?;
    let content = match input.tool {
        "notes.create" => input.raw["content"].clone(),
        "notes.edit" => json!(crate::edit(
            note["content"].as_str().unwrap(),
            input.raw["oldText"].as_str().unwrap(),
            input.raw["newText"].as_str().unwrap()
        )
        .map_err(|e| failure(409, &e.0))?),
        _ => Value::Null,
    };
    // Allocate metadata before publication. No path, source text or replacement
    // enters the queue. The worker must resolve the account's selected source.
    let id = call(host, "context", "uuid", "new", json!({}))?;
    let context = call(host, "context", "read", "call", json!({}))?;
    let id = id["id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| failure(503, "Notes service is unavailable"))?;
    let now = context["now"]
        .as_str()
        .ok_or_else(|| failure(503, "Notes service is unavailable"))?;
    let operation = if input.tool == "notes.delete" {
        "notes.remove"
    } else {
        "notes.compare-write"
    };
    let mut parameters =
        json!({"path":path,"destinationId":note["destinationId"],"expected":note["content"]});
    if operation == "notes.compare-write" {
        parameters["content"] = content;
    }
    call(host, "vault", operation, "source", parameters)?;
    let receipt = call(
        host,
        "jobs",
        "enqueue-after-commit",
        "notes.sync",
        json!({"params":{},"idempotencyKey":id,"availableAt":now}),
    )?;
    if receipt["deferred"] != true {
        return Err(failure(503, "Notes sync request was not accepted"));
    }
    Ok(json!({"data":{"path":path,"synced":true}}).to_string())
}

/// Read-only presentation preparation. Its opaque version must be rechecked by
/// the future host approval join; this function does not grant or consume approval.
pub fn presentation(host: &impl Host, payload: &str) -> Result<String> {
    let request: Request =
        serde_json::from_str(payload).map_err(|_| failure(400, "Invalid Notes input"))?;
    Ok(prepare(host, &request)?.to_string())
}

/// Preserve input order through map-based SDK transports without accepting an actor.
pub(crate) fn prepare_json(host: &impl Host, tool: &str, input_json: &str) -> Result<Value> {
    let parameters =
        serde_json::from_str(input_json).map_err(|_| failure(400, "Invalid Notes input"))?;
    prepare(
        host,
        &Request {
            tool: tool.into(),
            parameters,
        },
    )
}

/// Read-only public API. It neither grants approval nor runs a write or sync.
fn prepare(host: &impl Host, request: &Request) -> Result<Value> {
    let raw = &request.parameters.values;
    let (allowed, required): (&[&str], &[&str]) = match request.tool.as_str() {
        "notes.create" => (&["path", "content", "overwrite"], &["content"]),
        "notes.edit" => (&["path", "oldText", "newText"], &["oldText", "newText"]),
        "notes.delete" => (&["path"], &[]),
        _ => return Err(failure(400, "Unknown Notes write tool")),
    };
    // Match presentApprovalFields: malformed fields produce no presentation,
    // including a missing/non-string path, before resolving the private source.
    if !raw["path"].is_string()
        || required.iter().any(|key| raw.get(key).is_none())
        || raw.as_object().unwrap().iter().any(|(key, value)| {
            !allowed.contains(&key.as_str())
                || if key == "overwrite" {
                    !value.is_boolean()
                } else {
                    !value.is_string()
                }
        })
    {
        return Ok(Value::Null);
    }
    let input = Input {
        tool: &request.tool,
        raw,
    };
    let root = source(host)?;
    let path = relative(&input.raw["path"], &root)?;
    let note = read(host, &path)?;
    // Legacy create presentations permit an existing file; execution still checks overwrite.
    if input.tool != "notes.create" {
        validate_existing(&input, &note)?;
    }
    let (folder, target) = path.rsplit_once('/').unwrap_or(("", &path));
    let mut fields = Vec::new();
    if !folder.is_empty() {
        fields.push(json!({"label":"Folder","value":folder}));
    }
    // The legacy card preserves submitted field order, including an optional flag.
    for key in &request.parameters.order {
        let value = &input.raw[key];
        let label = match key.as_str() {
            "content" => "Content",
            "oldText" => "Replace",
            "newText" => "With",
            "overwrite" => "Replace existing content",
            _ => continue,
        };
        let shown = if key == "overwrite" {
            json!(if value == true { "Yes" } else { "No" })
        } else {
            value.clone()
        };
        fields.push(json!({"label":label,"value":shown}));
    }
    if input.tool == "notes.delete" {
        fields.push(json!({"label":"Deletion","value":"Permanently delete this note. There is no trash or undo."}));
    }
    let version = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([root, path, note["content"]]))?)
    );
    let mut result = json!({"target":target,"fields":fields,"version":version});
    if input.tool == "notes.create" {
        result["title"] = json!(if input.raw["overwrite"] == true {
            "Overwrite note"
        } else {
            "Create note"
        });
    }
    if input.tool == "notes.delete" {
        result["approvalKind"] = json!("note_delete");
    }
    Ok(result)
}
