//! Database roles and the data context.
//!
//! Requests run as `jarvis_app_runtime`, jobs as `jarvis_worker_runtime` and sign-in as
//! `jarvis_auth_runtime`, the NOBYPASSRLS roles the TypeScript server uses. [`Database::connect`]
//! refuses any other role. The pool never leaves this crate, so code outside it reaches a
//! connection only through a [`DataContext`], whose only constructor opens a transaction and
//! sets `app.actor_user_id` and `app.request_id` transaction-locally, as `DataContextRunner` does.

use deadpool_postgres::{Config, Object, Pool, PoolConfig, Runtime};
#[path = "db_deadline.rs"]
mod deadline;
use tokio_postgres::NoTls;
use uuid::Uuid;

use crate::access::AccessContext;
use crate::error::ApiError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeRole {
    App,
    Worker,
    Auth,
}

impl RuntimeRole {
    pub fn name(self) -> &'static str {
        match self {
            RuntimeRole::App => "jarvis_app_runtime",
            RuntimeRole::Worker => "jarvis_worker_runtime",
            RuntimeRole::Auth => "jarvis_auth_runtime",
        }
    }
}

/// A connection pool for one runtime role.
#[derive(Clone)]
pub struct Database {
    pool: Pool,
    role: RuntimeRole,
}

impl Database {
    /// Connects and checks the role before anything else can use the pool.
    pub async fn connect(url: &str, max_size: usize, role: RuntimeRole) -> Result<Self, String> {
        let mut config = Config::new();
        config.url = Some(url.to_owned());
        config.pool = Some(PoolConfig::new(max_size));
        let pool = config
            .create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|_| format!("could not set up the {} pool", role.name()))?;
        assert_runtime_role(&pool, role.name()).await?;
        Ok(Self { pool, role })
    }

    /// A pool that has not connected and whose role is unchecked, for tests whose requests
    /// are answered before any query.
    #[cfg(test)]
    pub(crate) fn unconnected(url: &str, role: RuntimeRole) -> Self {
        let mut config = Config::new();
        config.url = Some(url.to_owned());
        let pool = config.create_pool(Some(Runtime::Tokio1), NoTls).expect("test pool");
        Self { pool, role }
    }

    pub fn role(&self) -> RuntimeRole {
        self.role
    }

    /// A raw connection, for the narrow stores in this crate (sign-in, the job queue).
    pub(crate) async fn client(&self) -> Result<Object, ApiError> {
        Ok(self.pool.get().await?)
    }
}

/// Refuses to run on a role that could read past RLS.
async fn assert_runtime_role(pool: &Pool, expected: &str) -> Result<(), String> {
    let client = pool.get().await.map_err(|error| format!("connect as {expected}: {error}"))?;
    let row = client
        .query_one(
            "SELECT current_user::text, r.rolsuper, r.rolbypassrls \
             FROM pg_roles r WHERE r.rolname = current_user",
            &[],
        )
        .await
        .map_err(|error| error.to_string())?;
    let (name, superuser, bypass): (String, bool, bool) = (row.get(0), row.get(1), row.get(2));
    if name != expected {
        return Err(format!("connected as {name}, expected {expected}"));
    }
    if superuser || bypass {
        return Err(format!("role {name} can bypass row-level security; refusing to start"));
    }
    Ok(())
}

/// A transaction bound to one actor. Dropping it without [`DataContext::commit`] discards the
/// connection, so an unfinished transaction never returns to the pool.
pub struct DataContext {
    client: Option<Object>,
    access: AccessContext,
}

impl DataContext {
    pub async fn open(database: &Database, access: &AccessContext) -> Result<Self, ApiError> {
        if database.role == RuntimeRole::Auth {
            return Err(ApiError::Internal("a data context needs the app or worker role".into()));
        }
        let client = database.client().await?;
        client.batch_execute("BEGIN").await?;
        let context = DataContext { client: Some(client), access: access.clone() };
        context
            .db()
            .execute(
                "SELECT set_config('app.actor_user_id', $1, true), \
                        set_config('app.request_id', $2, true)",
                &[&access.actor_user_id().to_string(), &access.request_id()],
            )
            .await?;
        Ok(context)
    }

    pub fn db(&self) -> &tokio_postgres::Client {
        self.client.as_ref().expect("data context is open")
    }

    pub fn actor_user_id(&self) -> Uuid {
        self.access.actor_user_id()
    }

    pub fn access(&self) -> &AccessContext {
        &self.access
    }

    pub async fn commit(mut self) -> Result<(), ApiError> {
        let client = self.client.take().expect("data context is open");
        if let Err(error) = client.batch_execute("COMMIT").await {
            drop(Object::take(client));
            return Err(error.into());
        }
        Ok(())
    }
}

impl Drop for DataContext {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            drop(Object::take(client));
        }
    }
}
