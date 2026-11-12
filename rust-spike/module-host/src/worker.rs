//! One owned blocking worker per server. Queue leases coordinate multiple servers.
use crate::store::Installer;
use anyhow::Result;
use safety_core::secret::Secret;
use std::{sync::mpsc, sync::Arc, thread, time::Duration};

pub struct Worker {
    stop: mpsc::Sender<()>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Worker {
    /// Does not create a Tokio runtime on a request thread. A pass uses the existing
    /// installer fences, active declarations, scheduler and queue completion semantics.
    pub fn start(installer: Arc<Installer>, credential: Secret) -> Result<Self> {
        // Fail startup for an unusable worker role instead of serving with a loop
        // which can only report connection errors. Queue owns role validation.
        let runtime = tokio::runtime::Runtime::new()?;
        runtime.block_on(moss_platform_jobs::Queue::connect(
            credential.expose_secret(),
            moss_platform_jobs::Role::Worker,
            vec![],
        ))?;
        drop(runtime);
        Self::spawn(
            move || installer.run_job(&credential),
            || {
                safety_core::http::log(serde_json::json!({"event":"module_worker_pass_failed"}));
            },
        )
    }

    fn spawn(
        mut pass: impl FnMut() -> Result<bool> + Send + 'static,
        mut failed: impl FnMut() + Send + 'static,
    ) -> Result<Self> {
        let (stop, receive) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("moss-module-worker".into())
            .spawn(move || loop {
                match receive.try_recv() {
                    Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                let delay = match pass() {
                    Ok(true) => continue,
                    Ok(false) => Duration::from_secs(1),
                    Err(e) => {
                        safety_core::http::log(serde_json::json!({"event":"TEMP_DIAG","error":format!("{e:#}")}));
                        failed();
                        Duration::from_secs(1)
                    }
                };
                match receive.recv_timeout(delay) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn dropping_worker_waits_for_current_pass_and_prevents_another() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (started, wait_started) = mpsc::channel();
        let (release, wait_release) = mpsc::channel();
        let worker = Worker::spawn(
            move || {
                count.fetch_add(1, Ordering::SeqCst);
                started.send(()).unwrap();
                wait_release.recv().unwrap();
                Ok(false)
            },
            || {},
        )
        .unwrap();
        wait_started.recv_timeout(Duration::from_secs(5)).unwrap();
        // Signal shutdown before releasing the in-flight invocation.
        worker.stop.send(()).unwrap();
        release.send(()).unwrap();
        drop(worker);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_pass_is_reported_and_does_not_kill_the_worker() {
        let (reported, receive) = mpsc::channel();
        let worker = Worker::spawn(
            || anyhow::bail!("private diagnostic"),
            move || {
                reported.send(()).unwrap();
            },
        )
        .unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(worker);
    }
}
