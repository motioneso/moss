//! Opt-in typed database port. A transaction belongs to one host invocation, never to an
//! actor-provided request id. Existing Phase 4b database operations delegate unchanged.
use crate::{
    database::{owner_role, runtime_role},
    runtime::{CallScope, Ports, Request},
    typed_query,
};
use anyhow::{ensure, Context, Result};
use moss_module_sdk::query::{Kind, Query};
use safety_core::db::{DataContext, Database};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::runtime::Runtime;
use tokio_postgres::types::ToSql;
use uuid::Uuid;

struct Session {
    context: DataContext,
    failed: bool,
}
type SharedSession = Arc<Mutex<Session>>;
pub struct TransactionalDatabasePorts {
    database: Database,
    runtime: Runtime,
    sessions: Mutex<BTreeMap<Uuid, SharedSession>>,
    next: Arc<dyn Ports>,
}
impl TransactionalDatabasePorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: Runtime::new()?,
            sessions: Mutex::new(BTreeMap::new()),
            next,
        })
    }
    fn session(&self, scope: &CallScope) -> Result<SharedSession> {
        if let Some(session) = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("Database sessions busy"))?
            .get(&scope.call_id())
            .cloned()
        {
            return Ok(session);
        }
        let context = self
            .runtime
            .block_on(DataContext::open_bounded(
                &self.database,
                scope.access(),
                scope.remaining(),
            ))
            .map_err(|_| anyhow::anyhow!("Could not open the module data context"))?;
        let session = Arc::new(Mutex::new(Session {
            context,
            failed: false,
        }));
        self.sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("Database sessions busy"))?
            .insert(scope.call_id(), session.clone());
        Ok(session)
    }
    async fn query(&self, cx: &DataContext, scope: &CallScope, request: &Request) -> Result<Value> {
        let table = &request.resource;
        let mut query: Query = serde_json::from_value(request.parameters.clone())?;
        // Validate before using the table in any PostgreSQL metadata request.
        typed_query::compile(table, &query)?;
        let role = if scope.module().database.ledger != crate::manifest::Ledger::Module
            && crate::legacy::owns(&scope.module().id, table)
        {
            "jarvis_app_runtime".into()
        } else {
            runtime_role(&scope.module().id)
        };
        let role_info = cx
            .db()
            .query_opt(
                "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1",
                &[&role],
            )
            .await?
            .context("Module runtime role missing")?;
        ensure!(
            !role_info.get::<_, bool>(0)
                && !role_info.get::<_, bool>(1)
                && role != owner_role(&scope.module().id),
            "Module runtime cannot bypass privacy"
        );
        cx.db()
            .batch_execute(&format!("SET LOCAL ROLE {role}"))
            .await?;
        let timeout = scope.remaining().as_millis().clamp(1, 30_000).to_string();
        cx.db()
            .query_one(
                "SELECT set_config('statement_timeout',$1,true)",
                &[&timeout],
            )
            .await?;
        if query.kind == Kind::Insert {
            ensure!(
                !query.values.contains_key("owner_user_id"),
                "The host sets ownership"
            );
            let columns = cx.db().query("SELECT attname::text, atttypid = 'uuid'::regtype FROM pg_attribute WHERE attrelid=$1::text::regclass AND attnum>0 AND NOT attisdropped", &[&table]).await?;
            if columns
                .iter()
                .any(|r| r.get::<_, String>(0) == "owner_user_id")
            {
                query.values.insert(
                    "owner_user_id".into(),
                    json!(scope.access().actor_user_id()),
                );
            }
            if !query.values.contains_key("id")
                && columns
                    .iter()
                    .any(|r| r.get::<_, String>(0) == "id" && r.get::<_, bool>(1))
            {
                query.values.insert("id".into(), json!(Uuid::new_v4()));
            }
        }
        let statement = typed_query::compile(table, &query)?;
        let params: Vec<&(dyn ToSql + Sync)> = statement
            .parameters
            .iter()
            .map(|v| v as &(dyn ToSql + Sync))
            .collect();
        let rows = cx.db().query(&statement.sql, &params).await?;
        Ok(Value::Array(rows.into_iter().map(|r| r.get(0)).collect()))
    }
}
impl Ports for TransactionalDatabasePorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "db" || request.operation != "query" {
            return self.next.invoke(scope, port, request);
        }
        crate::runtime::authorize(scope.module(), port, request)?;
        let session = self.session(scope)?;
        let mut session = session
            .lock()
            .map_err(|_| anyhow::anyhow!("Database invocation busy"))?;
        ensure!(!session.failed, "This database invocation already failed");
        let result = self.runtime.block_on(async {
            tokio::time::timeout(
                scope.remaining(),
                self.query(&session.context, scope, request),
            )
            .await
            .context("Module database deadline exceeded")?
        });
        session.failed |= result.is_err();
        result
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("Database sessions busy"))?
            .remove(&scope.call_id());
        let result = (|| -> Result<()> {
            if let Some(session) = session {
                let session = Arc::try_unwrap(session)
                    .map_err(|_| anyhow::anyhow!("Database invocation is still busy"))?
                    .into_inner()
                    .map_err(|_| anyhow::anyhow!("Database invocation poisoned"))?;
                if success && !session.failed {
                    self.runtime
                        .block_on(session.context.commit_bounded(scope.remaining()))
                        .map_err(|_| anyhow::anyhow!("Could not commit the module data context"))?;
                } else {
                    self.runtime.block_on(async {
                        tokio::time::timeout(
                            scope.remaining(),
                            session.context.db().batch_execute("ROLLBACK"),
                        )
                        .await
                        .context("Module rollback deadline exceeded")??;
                        Ok::<_, anyhow::Error>(())
                    })?;
                    ensure!(!success, "The module caught a failed database operation; its changes were rolled back");
                }
            }
            Ok(())
        })();
        let downstream = self.next.finish_call(scope, success && result.is_ok());
        result.and(downstream)
    }
}
