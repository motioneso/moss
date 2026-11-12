//! The search model that runs inside the host. It is the same nomic model the old app ran
//! (768 numbers per text) behind one small interface: ask for a vector, ask how the model is
//! doing. The model is downloaded on first use into the data folder, never into the repository.
mod download;
mod engine;
mod lock;
mod worker;

pub use download::{FileSpec, Progress};
pub use engine::{DIMENSIONS, MAX_TOKENS};

use download::{fetch_all, present, Failure};
use lock::CacheLock;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use worker::{Setup, Worker, WorkerError};

pub const MODEL_NAME: &str = "nomic-ai/nomic-embed-text-v1.5";
const REVISION: &str = "e9b6763023c676ca8431644204f50c2b100d9aab";

/// The three files the model needs, pinned to one revision of the model hub and checked by hash.
pub fn pinned_files() -> Vec<FileSpec> {
    let base = format!("https://huggingface.co/{MODEL_NAME}/resolve/{REVISION}");
    let file = |name: &str, path: &str, sha256: &str, bytes: u64| FileSpec {
        name: name.into(),
        url: format!("{base}/{path}"),
        sha256: sha256.into(),
        bytes,
    };
    vec![
        file(
            "model.onnx",
            "onnx/model.onnx",
            "147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965",
            547_310_275,
        ),
        file(
            "tokenizer.json",
            "tokenizer.json",
            "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
            711_396,
        ),
    ]
}

/// How the model is doing, in terms a settings screen can show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    NotDownloaded,
    /// `waiting` is true while another Moss process holds the model folder.
    Downloading { done: u64, total: u64, waiting: bool },
    Ready,
    Failed(String),
}

/// Why a vector could not be made right now. The message is shown to the person.
#[derive(Debug)]
pub struct Unavailable(pub String);

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Unavailable {}

enum Phase {
    Idle,
    Downloading,
    Failed { message: String, at: Instant },
}

struct Inner {
    folder: PathBuf,
    files: Vec<FileSpec>,
    idle: Duration,
    lock_wait: Duration,
    retry_after: Duration,
    phase: Mutex<Phase>,
    progress: Progress,
    waiting: AtomicBool,
    verified: Arc<AtomicBool>,
    worker: Mutex<Option<Worker>>,
}

#[derive(Clone)]
pub struct OnDevice {
    inner: Arc<Inner>,
}

impl OnDevice {
    /// `root` is a folder inside the data folder. Nothing is read or written until first use.
    pub fn new(root: &Path) -> Self {
        Self::with_files(root, pinned_files())
    }

    pub fn with_files(root: &Path, files: Vec<FileSpec>) -> Self {
        Self {
            inner: Arc::new(Inner {
                folder: root.join(format!("nomic-embed-text-v1.5-{}", &REVISION[..8])),
                files,
                idle: Duration::from_secs(600),
                lock_wait: Duration::from_secs(900),
                retry_after: Duration::from_secs(600),
                phase: Mutex::new(Phase::Idle),
                progress: Progress::default(),
                waiting: AtomicBool::new(false),
                verified: Arc::new(AtomicBool::new(false)),
                worker: Mutex::new(None),
            }),
        }
    }

    /// Test hook. Shortens the waits.
    pub fn with_waits(mut self, idle: Duration, lock_wait: Duration, retry_after: Duration) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("not shared yet");
        inner.idle = idle;
        inner.lock_wait = lock_wait;
        inner.retry_after = retry_after;
        self
    }

    fn complete(&self) -> bool {
        self.inner.files.iter().all(|f| present(&self.inner.folder, f))
    }

    pub fn status(&self) -> Status {
        let phase = self.inner.phase.lock().unwrap_or_else(|e| e.into_inner());
        match &*phase {
            Phase::Downloading => Status::Downloading {
                done: self.inner.progress.done.load(Ordering::Relaxed),
                total: self.inner.files.iter().map(|f| f.bytes).sum(),
                waiting: self.inner.waiting.load(Ordering::Relaxed),
            },
            _ if self.complete() => Status::Ready,
            Phase::Failed { message, .. } => Status::Failed(message.clone()),
            Phase::Idle => Status::NotDownloaded,
        }
    }

    /// Starts the download in the background unless the files are complete or a download is
    /// already running. `force` also retries straight after a failure.
    pub fn start_download(&self, force: bool) {
        if self.complete() {
            return;
        }
        {
            let mut phase = self.inner.phase.lock().unwrap_or_else(|e| e.into_inner());
            match &*phase {
                Phase::Downloading => return,
                Phase::Failed { at, .. } if !force && at.elapsed() < self.inner.retry_after => return,
                _ => {}
            }
            *phase = Phase::Downloading;
        }
        let inner = self.inner.clone();
        let spawned = std::thread::Builder::new()
            .name("moss-model-download".into())
            .spawn({
                let inner = inner.clone();
                move || {
                    let outcome = Self::download(&inner);
                    let mut phase = inner.phase.lock().unwrap_or_else(|e| e.into_inner());
                    *phase = match outcome {
                        Ok(()) => Phase::Idle,
                        Err(message) => Phase::Failed { message, at: Instant::now() },
                    };
                }
            });
        if spawned.is_err() {
            let mut phase = inner.phase.lock().unwrap_or_else(|e| e.into_inner());
            *phase = Phase::Failed {
                message: "The search model download could not start".into(),
                at: Instant::now(),
            };
        }
    }

    fn download(inner: &Inner) -> Result<(), String> {
        inner.waiting.store(true, Ordering::Relaxed);
        let lock = CacheLock::acquire(&inner.folder, inner.lock_wait).map_err(|e| e.to_string());
        inner.waiting.store(false, Ordering::Relaxed);
        let _lock = lock?;
        fetch_all(&inner.folder, &inner.files, &inner.progress).map_err(|f: Failure| f.message())
    }

    /// One vector for one text, already prefixed by the caller. Returns at once with a plain
    /// message while the model is not ready, and starts the download the first time.
    pub fn embed(&self, text: &str, timeout: Duration) -> Result<Vec<f32>, Unavailable> {
        match self.status() {
            Status::Ready => {}
            Status::Downloading { done, total, waiting } => {
                return Err(Unavailable(if waiting {
                    "The search model is being downloaded by another Moss process".into()
                } else {
                    format!(
                        "The search model is still downloading ({}%)",
                        if total == 0 { 0 } else { done * 100 / total }
                    )
                }))
            }
            Status::NotDownloaded | Status::Failed(_) => {
                let before = self.status();
                self.start_download(false);
                return Err(Unavailable(match before {
                    Status::Failed(message) => message,
                    _ => "The search model is downloading for the first time".into(),
                }));
            }
        }
        for _ in 0..2 {
            let attempt = {
                let mut slot = self.inner.worker.lock().unwrap_or_else(|e| e.into_inner());
                if slot.is_none() {
                    *slot = Some(
                        Worker::spawn(Setup {
                            folder: self.inner.folder.clone(),
                            files: self.inner.files.clone(),
                            idle: self.inner.idle,
                            verified: self.inner.verified.clone(),
                        })
                        .map_err(|_| Unavailable("The search model could not start".into()))?,
                    );
                }
                slot.as_ref().and_then(|w| w.embed(text, timeout))
            };
            match attempt {
                Some(Ok(vector)) => return Ok(vector),
                Some(Err(WorkerError::Damaged)) => {
                    self.discard_damaged();
                    return Err(Unavailable(
                        "The search model files were damaged and are being downloaded again".into(),
                    ));
                }
                Some(Err(WorkerError::Failed(message))) => return Err(Unavailable(message.into())),
                // The thread had gone idle and left. Start a fresh one.
                None => *self.inner.worker.lock().unwrap_or_else(|e| e.into_inner()) = None,
            }
        }
        Err(Unavailable("The search model could not start".into()))
    }

    fn discard_damaged(&self) {
        *self.inner.worker.lock().unwrap_or_else(|e| e.into_inner()) = None;
        for file in &self.inner.files {
            let _ = std::fs::remove_file(self.inner.folder.join(&file.name));
        }
        self.start_download(true);
    }
}

impl OnDevice {
    /// The folder the model files live in.
    pub fn folder(&self) -> &Path {
        &self.inner.folder
    }
}
