//! Opt-in typed database port. A transaction belongs to one host invocation, never to an
//! actor-provided request id. Existing Phase 4b database operations delegate unchanged.
use crate::{
    database::{owner_role, runtime_role},
    runtime::{CallScope, Ports, Request},
    typed_query,
};
use anyhow::{ensure, Context, Result};
use moss_module_sdk::query::Kind;
use safety_core::db::{DataContext, Database};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::runtime::Runtime;
use tokio_postgres::types::ToSql;
use uuid::Uuid;

/// The one database transaction a host invocation owns. Adapters placed below this
/// layer join it through `join_call_session`, so their reads and writes see the
/// module's typed-query writes and commit or roll back together with them.
pub struct Session {
    context: DataContext,
    failed: bool,
}
impl Session {
    pub fn context(&self) -> &DataContext {
        &self.context
    }
}
pub type SharedSession = Arc<Mutex<Session>>;

fn registry() -> &'static Mutex<BTreeMap<Uuid, SharedSession>> {
    static SESSIONS: std::sync::OnceLock<Mutex<BTreeMap<Uuid, SharedSession>>> =
        std::sync::OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn open_session(database: &Database, runtime: &Runtime, scope: &CallScope) -> Result<SharedSession> {
    let busy = || anyhow::anyhow!("Database sessions busy");
    if let Some(session) = registry().lock().map_err(|_| busy())?.get(&scope.call_id()) {
        return Ok(session.clone());
    }
    // The registry lock is not held while waiting for a connection, so finishing calls can
    // still commit and release theirs.
    let context = runtime
        .block_on(DataContext::open_bounded(database, scope.access(), scope.remaining()))
        .map_err(|_| anyhow::anyhow!("Could not open the module data context"))?;
    let mut sessions = registry().lock().map_err(|_| busy())?;
    if let Some(session) = sessions.get(&scope.call_id()) {
        return Ok(session.clone());
    }
    let session = Arc::new(Mutex::new(Session {
        context,
        failed: false,
    }));
    sessions.insert(scope.call_id(), session.clone());
    Ok(session)
}

/// Returns the invocation's transaction, opening it when this is the first use.
/// The invocation's `finish_call` in `TransactionalDatabasePorts` commits it.
pub fn join_call_session(
    database: &Database,
    runtime: &Runtime,
    scope: &CallScope,
) -> Result<SharedSession> {
    open_session(database, runtime, scope)
}

pub struct TransactionalDatabasePorts {
    database: Database,
    runtime: Runtime,
    next: Arc<dyn Ports>,
}
impl TransactionalDatabasePorts {
    pub fn new(database: Database, next: Arc<dyn Ports>) -> Result<Self> {
        Ok(Self {
            database,
            runtime: Runtime::new()?,
            next,
        })
    }
    fn session(&self, scope: &CallScope) -> Result<SharedSession> {
        open_session(&self.database, &self.runtime, scope)
    }
    async fn query(&self, cx: &DataContext, scope: &CallScope, request: &Request) -> Result<Value> {
        let table = &request.resource;
        let (mut query, nulls_first) = typed_query::parse(request.parameters.clone())?;
        // Validate before using the table in any PostgreSQL metadata request.
        typed_query::compile_with_nulls_first(table, &query, &nulls_first)?;
        let role = if scope.module().database.ledger != crate::manifest::Ledger::Module
            && crate::legacy::owns(&scope.module().id, table)
        {
            // Legacy tables already grant the app and worker their own RLS-bound
            // roles. A worker cannot switch into the app role, nor should it need to.
            self.database.role().name().into()
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
        let statement = typed_query::compile_with_nulls_first(table, &query, &nulls_first)?;
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
        let account = crate::account_contracts::handles(port, request);
        let notification = port == "notify" && request.operation == "post";
        if !account && !notification && (port != "db" || request.operation != "query") {
            return self.next.invoke(scope, port, request);
        }
        crate::runtime::authorize(scope.module(), port, request)?;
        let session = self.session(scope)?;
        let mut session = session
            .lock()
            .map_err(|_| anyhow::anyhow!("Database invocation busy"))?;
        ensure!(!session.failed, "This database invocation already failed");
        let result = self.runtime.block_on(async {
            tokio::time::timeout(scope.remaining(), async {
                if account || notification {
                    // A previous typed query may have selected a module role.
                    // Account contracts use the original RLS-bound app/worker
                    // role; the actor and invocation transaction stay unchanged.
                    session.context.db().batch_execute("RESET ROLE").await?;
                    if notification {
                        crate::notifications::post(&session.context, scope, request).await
                    } else {
                        crate::account_contracts::invoke(&session.context, scope, port, request)
                            .await
                    }
                } else {
                    self.query(&session.context, scope, request).await
                }
            })
            .await
            .context("Module database deadline exceeded")?
        });
        session.failed |= result.is_err();
        result
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        let session = registry()
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
