//! Typed, parameterized queries. A guest cannot supply SQL, a role, or another actor.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub kind: Kind,
    #[serde(default)]
    pub filter: Filter,
    #[serde(default)]
    pub values: BTreeMap<String, Value>,
    #[serde(default)]
    pub order: Vec<Order>,
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub conflict: Conflict,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    #[default]
    Select,
    Insert,
    Update,
    Delete,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum Conflict {
    #[default]
    Error,
    Ignore,
    /// A single owner-scoped ON CONFLICT update, never guest-supplied SQL.
    Update {
        columns: Vec<String>,
        values: BTreeMap<String, Value>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Order {
    pub column: String,
    #[serde(default)]
    pub descending: bool,
    #[serde(default)]
    pub nulls_first: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Filter {
    #[default]
    All,
    Owned,
    And {
        filters: Vec<Filter>,
    },
    Or {
        filters: Vec<Filter>,
    },
    Compare {
        column: String,
        op: Compare,
        value: Value,
    },
    Null {
        column: String,
        #[serde(default)]
        not: bool,
    },
    In {
        column: String,
        values: Vec<Value>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Compare {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Like,
    ILike,
    /// PostgreSQL lower(column::text) equals the supplied text, without pattern matching.
    /// The caller normalizes the parameter; this does not lowercase it again.
    LowerEq,
}
impl Filter {
    pub fn eq(column: &str, value: impl Into<Value>) -> Self {
        Self::Compare {
            column: column.into(),
            op: Compare::Eq,
            value: value.into(),
        }
    }
}
impl Query {
    pub fn select(filter: Filter) -> Self {
        Self {
            filter,
            ..Self::default()
        }
    }
    pub fn insert(values: BTreeMap<String, Value>) -> Self {
        Self {
            kind: Kind::Insert,
            values,
            ..Self::default()
        }
    }
    pub fn update(filter: Filter, values: BTreeMap<String, Value>) -> Self {
        Self {
            kind: Kind::Update,
            filter,
            values,
            ..Self::default()
        }
    }
    pub fn delete(filter: Filter) -> Self {
        Self {
            kind: Kind::Delete,
            filter,
            ..Self::default()
        }
    }
}
