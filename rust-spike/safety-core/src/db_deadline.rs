//! Opt-in deadlines. Establish the discard-on-drop guard before sending BEGIN, so
//! cancellation never recycles a connection carrying an unfinished transaction.
use super::{DataContext, Database, RuntimeRole};
use crate::error::ApiError;
use access_context::AccessContext;
use std::time::{Duration, Instant};

fn elapsed() -> ApiError {
    ApiError::Internal("module database deadline exceeded".into())
}
impl DataContext {
    pub async fn open_bounded(
        database: &Database,
        access: &AccessContext,
        budget: Duration,
    ) -> Result<Self, ApiError> {
        if database.role == RuntimeRole::Auth {
            return Err(ApiError::Internal(
                "a data context needs the app or worker role".into(),
            ));
        }
        let start = Instant::now();
        let client = tokio::time::timeout(budget, database.client())
            .await
            .map_err(|_| elapsed())??;
        let context = Self {
            client: Some(client),
            access: access.clone(),
        };
        tokio::time::timeout(budget.saturating_sub(start.elapsed()), async {
            context.db().batch_execute("BEGIN").await?;
            context.db().execute(
                "SELECT set_config('app.actor_user_id', $1, true), set_config('app.request_id', $2, true)",
                &[&access.actor_user_id().to_string(), &access.request_id()],
            ).await?;
            Ok::<_, ApiError>(())
        }).await.map_err(|_| elapsed())??;
        Ok(context)
    }
    /// Keep the discard guard until COMMIT finishes. A canceled or failed commit
    /// cannot put a connection with uncertain transaction state back in the pool.
    pub async fn commit_bounded(mut self, budget: Duration) -> Result<(), ApiError> {
        tokio::time::timeout(budget, self.db().batch_execute("COMMIT"))
            .await
            .map_err(|_| elapsed())??;
        self.client.take();
        Ok(())
    }
}
