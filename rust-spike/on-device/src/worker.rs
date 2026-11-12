//! The one thread that runs the model. It loads the model on the first request and lets it go
//! after an idle spell, so about 600 MB comes back when nobody is searching.
use crate::{
    download::{hash_file, FileSpec},
    engine::Engine,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, RecvTimeoutError, SyncSender},
        Arc,
    },
    time::{Duration, Instant},
};

pub enum WorkerError {
    /// A model file does not match its pinned hash.
    Damaged,
    /// Fixed words only. Neither the text nor the engine's own message is carried.
    Failed(&'static str),
}

struct Job {
    text: String,
    deadline: Instant,
    reply: SyncSender<Result<Vec<f32>, WorkerError>>,
}

#[derive(Clone)]
pub struct Worker {
    queue: SyncSender<Job>,
}

pub struct Setup {
    pub folder: PathBuf,
    pub files: Vec<FileSpec>,
    pub idle: Duration,
    /// Set once every file has passed its hash check in this process.
    pub verified: Arc<AtomicBool>,
}

fn load(setup: &Setup) -> Result<Engine, WorkerError> {
    if !setup.verified.load(Ordering::Acquire) {
        for file in &setup.files {
            let path = setup.folder.join(&file.name);
            if !hash_file(&path).is_ok_and(|h| h.eq_ignore_ascii_case(&file.sha256)) {
                return Err(WorkerError::Damaged);
            }
        }
        setup.verified.store(true, Ordering::Release);
    }
    Engine::load(&setup.folder).map_err(|_| WorkerError::Failed("The search model could not be loaded"))
}

impl Worker {
    pub fn spawn(setup: Setup) -> std::io::Result<Self> {
        let (queue, jobs) = sync_channel::<Job>(256);
        std::thread::Builder::new()
            .name("moss-embedding".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || {
                let mut engine: Option<Engine> = None;
                loop {
                    let job = match jobs.recv_timeout(setup.idle) {
                        Ok(job) => job,
                        Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return,
                    };
                    if Instant::now() >= job.deadline {
                        let _ = job.reply.send(Err(WorkerError::Failed("The search model took too long")));
                        continue;
                    }
                    if engine.is_none() {
                        match load(&setup) {
                            Ok(loaded) => engine = Some(loaded),
                            Err(e) => {
                                let _ = job.reply.send(Err(e));
                                return;
                            }
                        }
                    }
                    let result = engine.as_mut().map_or(
                        Err(WorkerError::Failed("The search model is not loaded")),
                        |e| {
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.embed(&job.text)))
                                .ok()
                                .and_then(Result::ok)
                                .ok_or(WorkerError::Failed("The search model could not read this text"))
                        },
                    );
                    let _ = job.reply.send(result);
                }
            })?;
        Ok(Self { queue })
    }

    /// `None` means the thread has already exited and a new one is needed.
    pub fn embed(&self, text: &str, timeout: Duration) -> Option<Result<Vec<f32>, WorkerError>> {
        let (reply, answer) = sync_channel(1);
        let deadline = Instant::now() + timeout;
        self.queue
            .send(Job { text: text.to_owned(), deadline, reply })
            .ok()?;
        match answer.recv_timeout(timeout) {
            Ok(result) => Some(result),
            Err(RecvTimeoutError::Timeout) => {
                Some(Err(WorkerError::Failed("The search model took too long")))
            }
            Err(RecvTimeoutError::Disconnected) => None,
        }
    }
}
