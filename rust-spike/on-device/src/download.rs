//! Plain, resumable download of the pinned model files. Every file is checked against a pinned
//! SHA-256 before it takes its final name, so a cut, damaged or swapped file never gets used.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

/// One file of the model, pinned by size and hash.
#[derive(Clone, Debug)]
pub struct FileSpec {
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Why a download stopped. The message is plain words with no address, path or text in it.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    Network,
    Refused(u16),
    DiskFull,
    Damaged,
    Disk,
}

impl Failure {
    pub fn message(&self) -> String {
        match self {
            Self::Network => "The search model could not be downloaded. Check the internet connection. The download continues where it stopped".into(),
            Self::Refused(code) => format!("The model server refused the download (status {code}). Try again later"),
            Self::DiskFull => "There is not enough free disk space for the search model (about 550 MB)".into(),
            Self::Damaged => "The downloaded search model failed its safety check and was discarded. Try again".into(),
            Self::Disk => "The search model could not be saved to the data folder".into(),
        }
    }
}

/// Bytes fetched so far across all files of one download.
#[derive(Default)]
pub struct Progress {
    pub done: AtomicU64,
}

fn disk(e: &std::io::Error) -> Failure {
    if e.kind() == std::io::ErrorKind::StorageFull {
        Failure::DiskFull
    } else {
        Failure::Disk
    }
}

pub fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// True when the file exists at its pinned size. The hash is checked separately, once per run.
pub fn present(folder: &Path, file: &FileSpec) -> bool {
    folder
        .join(&file.name)
        .metadata()
        .is_ok_and(|m| m.is_file() && m.len() == file.bytes)
}

fn client() -> Result<reqwest::blocking::Client, Failure> {
    reqwest::blocking::Client::builder()
        .user_agent("moss-model-download")
        .connect_timeout(Duration::from_secs(20))
        // Each request moves one slice of the file, so a stalled connection ends in two minutes.
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let local = url.host_str().is_some_and(|h| h == "127.0.0.1" || h == "localhost");
            if attempt.previous().len() >= 5 || !(url.scheme() == "https" || (url.scheme() == "http" && local)) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| Failure::Network)
}

/// Fetches every file that is not already complete. A `.part` file left by an earlier try is
/// resumed with a range request.
/// Returns true when every file was fetched and hash-checked by this call, so none was kept
/// on a size match alone.
pub fn fetch_all(folder: &Path, files: &[FileSpec], progress: &Progress) -> Result<bool, Failure> {
    std::fs::create_dir_all(folder).map_err(|e| disk(&e))?;
    let client = client()?;
    let mut finished: u64 = files.iter().filter(|f| present(folder, f)).map(|f| f.bytes).sum();
    progress.done.store(finished, Ordering::Relaxed);
    let all_fresh = !files.iter().any(|f| present(folder, f));
    for file in files.iter().filter(|f| !present(folder, f)) {
        fetch_one(&client, folder, file, finished, progress)?;
        finished += file.bytes;
        progress.done.store(finished, Ordering::Relaxed);
    }
    Ok(all_fresh)
}

/// Size of one range request.
const SLICE: u64 = 16 * 1024 * 1024;

fn fetch_one(
    client: &reqwest::blocking::Client,
    folder: &Path,
    file: &FileSpec,
    finished: u64,
    progress: &Progress,
) -> Result<(), Failure> {
    let part = folder.join(format!("{}.part", file.name));
    let target = folder.join(&file.name);
    let mut restarts = 0;
    loop {
        let mut have = part.metadata().map(|m| m.len()).unwrap_or(0);
        if have > file.bytes {
            let _ = std::fs::remove_file(&part);
            have = 0;
        }
        if have == file.bytes {
            break;
        }
        let last = (have + SLICE).min(file.bytes) - 1;
        let mut response = client
            .get(&file.url)
            .header("Range", format!("bytes={have}-{last}"))
            .send()
            .map_err(|_| Failure::Network)?;
        let resumed = match response.status().as_u16() {
            206 => true,
            // The server ignored the range and sent the whole file. Start the file again.
            200 => false,
            416 if restarts == 0 => {
                restarts += 1;
                let _ = std::fs::remove_file(&part);
                continue;
            }
            code => return Err(Failure::Refused(code)),
        };
        let mut out = OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .map_err(|e| disk(&e))?;
        let mut written = if resumed { have } else { 0 };
        progress.done.store(finished + written, Ordering::Relaxed);
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            let n = response.read(&mut buffer).map_err(|_| Failure::Network);
            let n = match n {
                Ok(n) => n,
                Err(e) => {
                    // Keep what arrived so the next try resumes from here.
                    let _ = out.sync_all();
                    return Err(e);
                }
            };
            if n == 0 {
                break;
            }
            out.write_all(&buffer[..n]).map_err(|e| disk(&e))?;
            written += n as u64;
            progress.done.store(finished + written.min(file.bytes), Ordering::Relaxed);
        }
        out.sync_all().map_err(|e| disk(&e))?;
        drop(out);
        let progressed = part.metadata().map(|m| m.len()).unwrap_or(0) > have || !resumed;
        if !progressed {
            return Err(Failure::Network);
        }
    }
    let good = hash_file(&part).is_ok_and(|h| h.eq_ignore_ascii_case(&file.sha256));
    if !good {
        let _ = std::fs::remove_file(&part);
        return Err(Failure::Damaged);
    }
    std::fs::rename(&part, &target).map_err(|e| disk(&e))?;
    Ok(())
}
