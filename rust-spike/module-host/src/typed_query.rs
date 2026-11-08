//! Builds SQL from the guest's typed query tree. Identifiers are checked and every value
//! is a JSONB parameter cast through the declared table's real PostgreSQL row type.
use anyhow::{bail, ensure, Result};
use moss_module_sdk::query::{Compare, Conflict, Filter, Kind, Query};
use serde_json::{json, Value};

pub struct Statement {
    pub sql: String,
    pub parameters: Vec<Value>,
}
fn column(value: &str) -> Result<String> {
    ensure!(
        !value.is_empty()
            && value.len() <= 63
            && value.as_bytes()[0].is_ascii_lowercase()
            && value
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_'),
        "Invalid typed query column"
    );
    Ok(format!("\"{value}\""))
}
pub fn compile(table: &str, query: &Query) -> Result<Statement> {
    let name = table
        .strip_prefix("app.")
        .ok_or_else(|| anyhow::anyhow!("Invalid owned table"))?;
    column(name)?;
    ensure!(
        query.order.len() <= 8 && query.values.len() <= 64 && query.offset <= 1_000_000,
        "Typed query exceeds its limit"
    );
    ensure!(
        query.limit.is_none_or(|n| n > 0 && n <= 1000),
        "Invalid query limit"
    );
    let mut builder = Builder {
        table,
        parameters: vec![],
        nodes: 0,
    };
    let filter = builder.filter(&query.filter, 0)?;
    let order = query
        .order
        .iter()
        .map(|o| {
            Ok(format!(
                "row.{} {} NULLS LAST",
                column(&o.column)?,
                if o.descending { "DESC" } else { "ASC" }
            ))
        })
        .collect::<Result<Vec<_>>>()?
        .join(",");
    let sql = match query.kind {
        Kind::Select => {
            ensure!(
                query.values.is_empty() && query.conflict == Conflict::Error,
                "Invalid read options"
            );
            format!(
                "SELECT to_jsonb(row) FROM {table} row WHERE {filter} {} LIMIT {} OFFSET {}",
                if order.is_empty() {
                    String::new()
                } else {
                    format!("ORDER BY {order}")
                },
                query.limit.unwrap_or(1000),
                query.offset
            )
        }
        Kind::Insert => {
            ensure!(
                matches!(query.filter, Filter::All)
                    && query.order.is_empty()
                    && query.offset == 0
                    && query.limit.is_none(),
                "Invalid insert options"
            );
            ensure!(!query.values.is_empty(), "Writing needs values");
            let columns = query
                .values
                .keys()
                .map(|c| column(c))
                .collect::<Result<Vec<_>>>()?
                .join(",");
            let n = builder.parameter(serde_json::to_value(&query.values)?);
            format!("INSERT INTO {table} AS row ({columns}) SELECT {columns} FROM jsonb_populate_record(NULL::{table},${n}) {} RETURNING to_jsonb(row)",
                if query.conflict == Conflict::Ignore { "ON CONFLICT DO NOTHING" } else { "" })
        }
        Kind::Update | Kind::Delete => {
            ensure!(
                !matches!(query.filter, Filter::All),
                "Mutations need an explicit filter"
            );
            ensure!(
                query.order.is_empty()
                    && query.offset == 0
                    && query.limit.is_none()
                    && query.conflict == Conflict::Error,
                "Invalid mutation options"
            );
            if query.kind == Kind::Delete {
                ensure!(query.values.is_empty(), "Delete cannot set values");
                format!("DELETE FROM {table} AS row WHERE {filter} RETURNING to_jsonb(row)")
            } else {
                ensure!(
                    !query.values.is_empty() && !query.values.contains_key("owner_user_id"),
                    "An update needs values and cannot change ownership"
                );
                let columns = query
                    .values
                    .keys()
                    .map(|c| column(c))
                    .collect::<Result<Vec<_>>>()?
                    .join(",");
                let n = builder.parameter(serde_json::to_value(&query.values)?);
                format!("UPDATE {table} AS row SET ({columns})=(SELECT {columns} FROM jsonb_populate_record(NULL::{table},${n})) WHERE {filter} RETURNING to_jsonb(row)")
            }
        }
    };
    Ok(Statement {
        sql,
        parameters: builder.parameters,
    })
}
struct Builder<'a> {
    table: &'a str,
    parameters: Vec<Value>,
    nodes: usize,
}
impl Builder<'_> {
    fn parameter(&mut self, value: Value) -> usize {
        self.parameters.push(value);
        self.parameters.len()
    }
    fn filter(&mut self, filter: &Filter, depth: usize) -> Result<String> {
        self.nodes += 1;
        ensure!(
            depth <= 12 && self.nodes <= 128,
            "Typed filter exceeds its limit"
        );
        Ok(match filter {
            Filter::All => "true".into(),
            Filter::Owned => "row.owner_user_id = app.current_actor_user_id()".into(),
            Filter::And { filters } | Filter::Or { filters } => {
                ensure!(!filters.is_empty(), "Empty filter group");
                let parts = filters
                    .iter()
                    .map(|f| self.filter(f, depth + 1))
                    .collect::<Result<Vec<_>>>()?;
                format!(
                    "({})",
                    parts.join(if matches!(filter, Filter::And { .. }) {
                        " AND "
                    } else {
                        " OR "
                    })
                )
            }
            Filter::Null { column: name, not } => format!(
                "row.{} IS {}NULL",
                column(name)?,
                if *not { "NOT " } else { "" }
            ),
            Filter::Compare {
                column: name,
                op,
                value,
            } => {
                ensure!(!value.is_null(), "Use the typed null filter");
                let c = column(name)?;
                let n = self.parameter(json!({name:value}));
                let op = match op {
                    Compare::Eq => "=",
                    Compare::Ne => "<>",
                    Compare::Lt => "<",
                    Compare::Le => "<=",
                    Compare::Gt => ">",
                    Compare::Ge => ">=",
                    Compare::Like => "LIKE",
                    Compare::ILike => "ILIKE",
                };
                format!(
                    "row.{c} {op} (SELECT {c} FROM jsonb_populate_record(NULL::{},${n}))",
                    self.table
                )
            }
            Filter::In {
                column: name,
                values,
            } => {
                ensure!(values.len() <= 1000, "Too many membership values");
                if values.is_empty() {
                    return Ok("false".into());
                }
                ensure!(
                    values.iter().all(|v| !v.is_null()),
                    "Use the typed null filter"
                );
                let c = column(name)?;
                let n = self.parameter(Value::Array(
                    values.iter().map(|v| json!({name:v})).collect(),
                ));
                format!(
                    "row.{c} IN (SELECT {c} FROM jsonb_populate_recordset(NULL::{},${n}))",
                    self.table
                )
            }
        })
    }
}

/// Validation used before a guest reaches any database adapter.
pub fn validate(parameters: Value) -> Result<()> {
    let query: Query = serde_json::from_value(parameters)?;
    // The placeholder table is never executed; it validates all guest-controlled syntax.
    compile("app.validation", &query)?;
    if query.values.contains_key("owner_user_id") {
        bail!("The host sets ownership");
    }
    Ok(())
}
