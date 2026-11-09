//! Reuse delayed-job setup within one host-created invocation only.
//! Queue::enqueue still sets the actor in a separate transaction for every send.
use crate::{jobs, runtime::CallScope};
use anyhow::Result;
use moss_platform_jobs::{Queue, Role};
use std::sync::Arc;
use tokio::sync::Mutex;

type Entry = (uuid::Uuid, Arc<Queue>);
#[derive(Default)]
pub(crate) struct ProducerQueue(Mutex<Option<Entry>>);

impl ProducerQueue {
    pub async fn get(&self, url: &str, scope: &CallScope) -> Result<Arc<Queue>> {
        let identity = scope.call_id();
        let mut slot = self.0.lock().await;
        if let Some((cached, queue)) = slot.as_ref() {
            if *cached == identity {
                return Ok(queue.clone());
            }
        }
        let queue =
            Arc::new(Queue::connect(url, Role::Producer, jobs::specs(scope.module())).await?);
        // CallScope fixes both actor and manifest. A later invocation connects
        // afresh, so an idle connection lost between requests is never reused.
        // Keep at most one idle handle; an active send retains its own Arc.
        *slot = Some((identity, queue.clone()));
        Ok(queue)
    }

    pub async fn discard(&self, failed: &Arc<Queue>) {
        let mut slot = self.0.lock().await;
        if slot
            .as_ref()
            .is_some_and(|(_, queue)| Arc::ptr_eq(queue, failed))
        {
            *slot = None;
        }
    }
}
