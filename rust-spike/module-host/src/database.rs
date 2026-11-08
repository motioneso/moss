//! Typed module queries run inside the caller's existing DataContext and a per-module role.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Context, Result};
use safety_core::db::{DataContext, Database};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::runtime::Runtime;

pub fn runtime_role(id: &str) -> String {
    format!("moss_mod_{}", &crate::trust::digest(id.as_bytes())[..24])
}
pub fn owner_role(id: &str) -> String {
    format!("moss_own_{}", &crate::trust::digest(id.as_bytes())[..24])
}
pub struct DatabasePorts {
    database: Database,
    runtime: Runtime,
    other: Arc<dyn Ports>,
}
impl DatabasePorts {
    pub fn new(database: Database, other: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: Runtime::new()?,
            other,
        })
    }
}
impl Ports for DatabasePorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "db" {
            return self.other.invoke(scope, port, request);
        }
        crate::runtime::authorize(scope.module(), port, request)?;
        self.runtime.block_on(async {
            let cx=DataContext::open(&self.database,scope.access()).await.map_err(|_|anyhow::anyhow!("Could not open the module data context"))?;
            let role=runtime_role(&scope.module().id);
            let checked=cx.db().query_opt("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1",&[&role]).await?.context("The module runtime role has not been provisioned")?;
            ensure!(!checked.get::<_,bool>(0) && !checked.get::<_,bool>(1),"The module runtime role can bypass privacy rules");
            cx.db().batch_execute(&format!("SET LOCAL ROLE {role}")).await?;
            let timeout=scope.remaining().as_millis().clamp(1,30_000).to_string();
            cx.db().query_one("SELECT set_config('statement_timeout',$1,true)",&[&timeout]).await?;
            let table=&request.resource;
            let rows=match request.operation.as_str() {
                "select"=> {
                    let limit=request.parameters["limit"].as_u64().unwrap_or(100).min(1000) as i64;
                    if let Some(id)=request.parameters["id"].as_str() {
                        cx.db().query(&format!("SELECT to_jsonb(row) FROM {table} row WHERE id::text=$1 LIMIT $2"),&[&id,&limit]).await?
                    } else {cx.db().query(&format!("SELECT to_jsonb(row) FROM {table} row LIMIT $1"),&[&limit]).await?}
                },
                "delete"=> {
                    let id=request.parameters["id"].as_str().context("Deleting needs a row id")?;
                    cx.db().query(&format!("DELETE FROM {table} row WHERE id::text=$1 RETURNING to_jsonb(row)"),&[&id]).await?
                },
                operation=> {
                    let mut values=request.parameters["values"].as_object().context("Writing needs typed column values")?.clone();
                    ensure!(!values.contains_key("owner_user_id"),"The host sets the row owner");
                    if operation=="insert" {values.insert("owner_user_id".into(),json!(scope.access().actor_user_id()));}
                    ensure!(!values.is_empty() && values.len()<=64,"Invalid column count");
                    for column in values.keys() {ensure!(!column.is_empty() && column.len()<=63 && column.as_bytes()[0].is_ascii_lowercase() && column.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'_'),"Invalid column name");}
                    let columns=values.keys().map(|c|format!("\"{c}\"")).collect::<Vec<_>>().join(",");
                    let value=Value::Object(values);
                    if operation=="insert" {
                        cx.db().query(&format!("INSERT INTO {table} AS row ({columns}) SELECT {columns} FROM jsonb_populate_record(NULL::{table},$1) RETURNING to_jsonb(row)"),&[&value]).await?
                    } else {
                        ensure!(operation=="update","Unknown typed database operation");
                        let id=request.parameters["id"].as_str().context("Updating needs a row id")?;
                        cx.db().query(&format!("UPDATE {table} AS row SET ({columns})=(SELECT {columns} FROM jsonb_populate_record(NULL::{table},$1)) WHERE id::text=$2 RETURNING to_jsonb(row)"),&[&value,&id]).await?
                    }
                }
            };
            let output=Value::Array(rows.into_iter().map(|r|r.get(0)).collect());
            cx.commit().await.map_err(|_|anyhow::anyhow!("Could not commit the module data context"))?;Ok(output)
        })
    }
}
