//! What a queued job may carry: ids, choices fixed in code, small numbers, flags and hashed
//! idempotency keys. There is no way to add free text, so private content, prompts and secrets
//! cannot reach a job payload. Field names are code constants and may not name a secret.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::redact::is_secret_name;

/// The largest number a payload may carry.
pub const MAX_COUNT: u32 = 1_000_000;

#[derive(Debug, PartialEq, Eq)]
pub enum PayloadError {
    SecretName(&'static str),
    Duplicate(&'static str),
    TooLarge(&'static str),
}

#[derive(Debug)]
pub struct JobPayload {
    fields: Map<String, Value>,
}

impl JobPayload {
    pub fn builder() -> JobPayloadBuilder {
        JobPayloadBuilder {
            fields: Map::new(),
            error: None,
        }
    }

    pub fn to_json(&self) -> Value {
        Value::Object(self.fields.clone())
    }
}

pub struct JobPayloadBuilder {
    fields: Map<String, Value>,
    error: Option<PayloadError>,
}

impl JobPayloadBuilder {
    pub fn id(self, name: &'static str, id: Uuid) -> Self {
        self.put(name, json!(id))
    }

    /// A value from a set written in code, such as a status name.
    pub fn choice(self, name: &'static str, value: &'static str) -> Self {
        self.put(name, json!(value))
    }

    pub fn count(self, name: &'static str, value: u32) -> Self {
        if value > MAX_COUNT {
            return self.fail(PayloadError::TooLarge(name));
        }
        self.put(name, json!(value))
    }

    pub fn flag(self, name: &'static str, value: bool) -> Self {
        self.put(name, json!(value))
    }

    /// An idempotency key, stored as its SHA-256 so client text never reaches the queue. Equal
    /// keys still hash equal, so de-duplication keeps working.
    pub fn key_hash(self, name: &'static str, key: &str) -> Self {
        let digest = Sha256::digest(key.as_bytes());
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        self.put(name, json!(format!("sha256:{hex}")))
    }

    pub fn build(self) -> Result<JobPayload, PayloadError> {
        match self.error {
            Some(error) => Err(error),
            None => Ok(JobPayload {
                fields: self.fields,
            }),
        }
    }

    fn put(mut self, name: &'static str, value: Value) -> Self {
        if self.error.is_some() {
            return self;
        }
        if is_secret_name(name) {
            return self.fail(PayloadError::SecretName(name));
        }
        if self.fields.insert(name.to_owned(), value).is_some() {
            return self.fail(PayloadError::Duplicate(name));
        }
        self
    }

    fn fail(mut self, error: PayloadError) -> Self {
        self.error.get_or_insert(error);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENTINEL: &str = "MOSS-SENTINEL-payload-51c2";

    #[test]
    fn carries_only_metadata() {
        let payload = JobPayload::builder()
            .id("actorUserId", Uuid::nil())
            .choice("requestedStatus", "done")
            .count("attempt", 2)
            .key_hash("idempotencyKey", SENTINEL)
            .build()
            .unwrap();
        let text = payload.to_json().to_string();
        assert!(!text.contains(SENTINEL), "{text}");
        assert!(text.contains("\"requestedStatus\":\"done\""));
    }

    #[test]
    fn refuses_secret_names_duplicates_and_large_numbers() {
        let named = JobPayload::builder().id("accessToken", Uuid::nil()).build();
        assert_eq!(named.unwrap_err(), PayloadError::SecretName("accessToken"));
        let twice = JobPayload::builder()
            .flag("done", true)
            .flag("done", false)
            .build();
        assert_eq!(twice.unwrap_err(), PayloadError::Duplicate("done"));
        let large = JobPayload::builder().count("rows", MAX_COUNT + 1).build();
        assert_eq!(large.unwrap_err(), PayloadError::TooLarge("rows"));
    }
}
