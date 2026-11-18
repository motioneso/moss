//! Opt-in delayed, idempotent enqueue. The host still supplies the actor and module envelope.
use anyhow::{ensure, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EnqueueOptions {
    pub params: Value,
    pub idempotency_key: Uuid,
    pub available_at: DateTime<Utc>,
}

pub(crate) fn parse(value: &Value) -> Result<EnqueueOptions> {
    let options: EnqueueOptions = serde_json::from_value(value.clone())?;
    ensure!(
        options.params.is_object(),
        "Job parameters must be an object"
    );
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> Value {
        json!({"params":{"command-id":"00000000-0000-4000-8000-000000000001"},"idempotencyKey":"00000000-0000-4000-8000-000000000002","availableAt":"2026-11-08T12:15:00.123Z"})
    }

    #[test]
    fn retains_exact_parameters_time_and_stable_key() {
        let value = request();
        let first = parse(&value).unwrap();
        let second = parse(&value).unwrap();
        assert_eq!(first.params, value["params"]);
        assert_eq!(first.idempotency_key.to_string(), value["idempotencyKey"]);
        assert_eq!(first.idempotency_key, second.idempotency_key);
        assert_eq!(first.available_at.timestamp_millis(), 1794140100123);
    }

    #[test]
    fn normalizes_an_explicit_offset_to_utc() {
        let mut value = request();
        value["availableAt"] = json!("2026-11-08T04:15:00.123-08:00");
        assert_eq!(
            parse(&value).unwrap().available_at,
            parse(&request()).unwrap().available_at
        );
    }

    #[test]
    fn requires_a_strict_metadata_envelope() {
        let mut invalid = vec![Value::Null, json!([])];
        for key in ["params", "idempotencyKey", "availableAt"] {
            let mut value = request();
            value.as_object_mut().unwrap().remove(key);
            invalid.push(value);
        }
        for (key, bad) in [
            ("actorUserId", json!("another-account")),
            ("moduleId", json!("another-module")),
            ("params", json!("private note content")),
            ("params", Value::Null),
            ("params", json!([])),
            ("idempotencyKey", json!("not-a-uuid")),
            ("availableAt", json!("2026-11-08T12:15:00")),
            ("availableAt", json!("tomorrow")),
        ] {
            let mut value = request();
            value[key] = bad;
            invalid.push(value);
        }
        for value in invalid {
            assert!(parse(&value).is_err(), "Invalid envelope accepted: {value}");
        }
    }
}
