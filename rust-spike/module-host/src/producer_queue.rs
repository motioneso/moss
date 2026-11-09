//! One reusable delayed-job producer connection, bound to the complete manifest.
//! Queue::enqueue still sets the actor in a separate transaction for every send.
use crate::{jobs, manifest::Manifest};
use anyhow::Result;
use moss_platform_jobs::{Queue, Role};
use std::sync::Arc;
use tokio::sync::Mutex;

type Entry = (String, Arc<Queue>);
#[derive(Default)]
pub(crate) struct ProducerQueue(Mutex<Option<Entry>>);

impl ProducerQueue {
    pub async fn get(&self, url: &str, manifest: &Manifest) -> Result<Arc<Queue>> {
        let identity = jobs::manifest_hash(manifest);
        let mut slot = self.0.lock().await;
        if let Some((cached, queue)) = slot.as_ref() {
            if *cached == identity {
                return Ok(queue.clone());
            }
        }
        let queue = Arc::new(Queue::connect(url, Role::Producer, jobs::specs(manifest)).await?);
        // Keep only one idle connection. Concurrent sends retain their own Arc;
        // changing module or manifest cannot change their immutable queue specs.
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
