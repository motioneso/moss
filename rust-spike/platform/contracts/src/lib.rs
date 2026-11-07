//! The host supplies an authenticated actor; features never receive a raw database handle.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub struct Actor {
    user_id: Uuid,
    request_id: Uuid,
}
impl Actor {
    /// Join point for the safety core's session / DataContext resolver.
    pub fn from_authenticated_session(user_id: Uuid, request_id: Uuid) -> Self {
        Self {
            user_id,
            request_id,
        }
    }
    pub fn user_id(self) -> Uuid {
        self.user_id
    }
    pub fn request_id(self) -> Uuid {
        self.request_id
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidPayload,
    InvalidDeclaration,
    Database,
    StaleLease,
    Unavailable,
    Transport,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

/// No free text or generic identifier kind: a short credential also fits those types.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum ParamSchema {
    Uuid,
    Boolean,
    Null,
    Enum {
        values: Vec<String>,
    },
    Integer {
        min: i64,
        max: i64,
    },
    Number {
        min: f64,
        max: f64,
    },
    Array {
        items: Box<ParamSchema>,
        #[serde(rename = "maxItems")]
        max_items: usize,
    },
    Object {
        fields: BTreeMap<String, ParamSchema>,
    },
}
impl ParamSchema {
    pub fn valid(&self) -> bool {
        match self {
            Self::Enum { values } => {
                !values.is_empty() && values.len() <= 64 && values.iter().all(|v| identifier(v))
            }
            Self::Integer { min, max } => min <= max && *min >= -1_000_000 && *max <= 1_000_000,
            Self::Number { min, max } => {
                min.is_finite() && max.is_finite() && min <= max && *min >= -1e6 && *max <= 1e6
            }
            Self::Array { items, max_items } => {
                *max_items > 0
                    && *max_items <= 64
                    && !matches!(**items, Self::Array { .. } | Self::Object { .. })
                    && items.valid()
            }
            Self::Object { fields } => {
                fields.len() <= 32
                    && fields.iter().all(|(k, v)| {
                        identifier(k) && !matches!(v, Self::Object { .. }) && v.valid()
                    })
            }
            _ => true,
        }
    }
    pub fn accepts(&self, value: &Value) -> bool {
        match self {
            Self::Uuid => value.as_str().is_some_and(valid_uuid),
            Self::Boolean => value.is_boolean(),
            Self::Null => value.is_null(),
            Self::Enum { values } => value
                .as_str()
                .is_some_and(|v| values.iter().any(|s| s == v)),
            Self::Integer { min, max } => value.as_i64().is_some_and(|n| n >= *min && n <= *max),
            Self::Number { min, max } => value
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= *min && n <= *max),
            Self::Array { items, max_items } => value
                .as_array()
                .is_some_and(|a| a.len() <= *max_items && a.iter().all(|v| items.accepts(v))),
            Self::Object { fields } => value.as_object().is_some_and(|o| {
                o.iter()
                    .all(|(k, v)| fields.get(k).is_some_and(|s| s.accepts(v)))
            }),
        }
    }
}
pub fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        && s.as_bytes()[0].is_ascii_alphanumeric()
}
pub fn module_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.as_bytes()[s.len() - 1].is_ascii_alphanumeric()
}
pub fn valid_uuid(s: &str) -> bool {
    s.len() == 36
        && Uuid::parse_str(s).is_ok_and(|u| {
            matches!(u.get_version_num(), 1..=5) && u.get_variant() == uuid::Variant::RFC4122
        })
}
fn job_kind(s: &str) -> bool {
    identifier(s)
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueSpec {
    pub name: String,
    pub module_id: String,
    pub job_kinds: Vec<String>,
    pub params_schema: Option<ParamSchema>,
    pub retry_limit: u32,
    pub retry_delay_seconds: u32,
    pub retry_backoff: bool,
    pub lease_seconds: u32,
}
impl QueueSpec {
    pub fn validate(&self) -> Result<(), Error> {
        if !module_id(&self.module_id)
            || !self.name.starts_with(&format!("{}.", self.module_id))
            || !job_kind(&self.name)
            || self.job_kinds.is_empty()
            || self.job_kinds.iter().any(|k| !job_kind(k))
            || self.params_schema.as_ref().is_some_and(|s| !s.valid())
            || self.lease_seconds == 0
            || self.lease_seconds > 86400
            || self.retry_limit > 100
            || self.retry_delay_seconds > 86400
        {
            return Err(Error::InvalidDeclaration);
        }
        Ok(())
    }
    pub fn parse_payload(&self, value: Value) -> Result<Metadata, Error> {
        self.validate()?;
        if serde_json::to_vec(&value)
            .map_err(|_| Error::InvalidPayload)?
            .len()
            > 4096
        {
            return Err(Error::InvalidPayload);
        }
        if value.get("params").is_some_and(Value::is_null)
            || !value
                .get("actorUserId")
                .and_then(Value::as_str)
                .is_some_and(valid_uuid)
        {
            return Err(Error::InvalidPayload);
        }
        let payload: Metadata = serde_json::from_value(value).map_err(|_| Error::InvalidPayload)?;
        if !valid_uuid(&payload.actor_user_id.to_string())
            || payload.module_id != self.module_id
            || !self.job_kinds.contains(&payload.job_kind)
            || !payload.manifest_hash.starts_with("sha256:")
            || payload.manifest_hash.len() != 71
            || !payload.manifest_hash[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::InvalidPayload);
        }
        if let Some(params) = &payload.params {
            if serde_json::to_vec(params)
                .map_err(|_| Error::InvalidPayload)?
                .len()
                > 2048
                || !self
                    .params_schema
                    .as_ref()
                    .is_some_and(|s| s.accepts(params))
            {
                return Err(Error::InvalidPayload);
            }
        }
        Ok(payload)
    }
}

/// Queue operations revalidate this envelope; no Debug or raw error value is exposed.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    actor_user_id: Uuid,
    module_id: String,
    job_kind: String,
    manifest_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}
impl Metadata {
    pub fn actor_user_id(&self) -> Uuid {
        self.actor_user_id
    }
    pub fn job_kind(&self) -> &str {
        &self.job_kind
    }
    pub fn params(&self) -> Option<&Value> {
        self.params.as_ref()
    }
}
