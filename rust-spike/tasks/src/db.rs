//! Database roles and the data context.
//!
//! Requests run as `jarvis_app_runtime` and the job worker as `jarvis_worker_runtime`, the same
//! NOBYPASSRLS roles the TypeScript server uses. A [`DataContext`] is the only way to reach a
//! connection for module queries, and its only constructor opens a transaction and sets
//! `app.actor_user_id` and `app.request_id` transaction-locally, as `DataContextRunner` does.

use deadpool_postgres::{Config, Object, Pool, Runtime};
use tokio_postgres::NoTls;
use uuid::Uuid;

use crate::error::ApiError;

/// Who is acting, and the request it belongs to. Exactly these two fields, as in TypeScript.
#[derive(Clone, Debug)]
pub struct AccessContext {
    pub actor_user_id: Uuid,
    pub request_id: String,
}

pub fn pool(url: &str, max_size: usize) -> Result<Pool, String> {
    let mut config = Config::new();
    config.url = Some(url.to_owned());
    config.pool = Some(deadpool_postgres::PoolConfig::new(max_size));
    config.create_pool(Some(Runtime::Tokio1), NoTls).map_err(|error| error.to_string())
}

/// Refuses to run on a role that could read past RLS.
pub async fn assert_runtime_role(pool: &Pool, expected: &str) -> Result<(), String> {
    let client = pool.get().await.map_err(|error| error.to_string())?;
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
    actor_user_id: Uuid,
}

impl DataContext {
    pub async fn open(pool: &Pool, access: &AccessContext) -> Result<Self, ApiError> {
        let client = pool.get().await?;
        client.batch_execute("BEGIN").await?;
        let context = DataContext { client: Some(client), actor_user_id: access.actor_user_id };
        context
            .db()
            .execute(
                "SELECT set_config('app.actor_user_id', $1, true), \
                        set_config('app.request_id', $2, true)",
                &[&access.actor_user_id.to_string(), &access.request_id],
            )
            .await?;
        Ok(context)
    }

    pub fn db(&self) -> &tokio_postgres::Client {
        self.client.as_ref().expect("data context is open")
    }

    pub fn actor_user_id(&self) -> Uuid {
        self.actor_user_id
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
