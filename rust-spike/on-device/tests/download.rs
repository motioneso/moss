//! Download, resume, damage and lock cases against a small local server. No real model is used.
use moss_on_device::{FileSpec, OnDevice, Status};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

/// What the local server does with the next request.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Good,
    CutAfter(usize),
    Status(u16),
    Corrupt,
    NoRange,
}

struct Server {
    port: u16,
    mode: Arc<std::sync::Mutex<Mode>>,
    ranges: Arc<std::sync::Mutex<Vec<String>>>,
    hits: Arc<AtomicUsize>,
}

fn serve(body: Vec<u8>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mode = Arc::new(std::sync::Mutex::new(Mode::Good));
    let ranges = Arc::new(std::sync::Mutex::new(Vec::new()));
    let hits = Arc::new(AtomicUsize::new(0));
    let (m, r, h) = (mode.clone(), ranges.clone(), hits.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).unwrap_or(0) == 0 {
                    break;
                }
                head.push(byte[0]);
            }
            h.fetch_add(1, Ordering::SeqCst);
            let head = String::from_utf8_lossy(&head).to_string();
            let range = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("range: bytes=")
                        .map(str::to_owned)
                })
                .and_then(|v| {
                    let mut parts = v.trim().split('-');
                    Some((
                        parts.next()?.parse::<usize>().ok()?,
                        parts.next().and_then(|e| e.parse::<usize>().ok()),
                    ))
                });
            if let Some((start, _)) = range {
                r.lock().unwrap().push(format!("from {start}"));
            }
            let mode = *m.lock().unwrap();
            let mut data = body.clone();
            if mode == Mode::Corrupt {
                data[0] ^= 0xff;
            }
            let (status, slice) = match (range, mode) {
                (_, Mode::Status(code)) => (code, Vec::new()),
                (Some((start, end)), m) if m != Mode::NoRange => {
                    let end = end.map_or(data.len(), |e| (e + 1).min(data.len()));
                    (206, data[start.min(end)..end].to_vec())
                }
                _ => (200, data),
            };
            let advertised = slice.len();
            let sent = match mode {
                Mode::CutAfter(n) => &slice[..n.min(slice.len())],
                _ => &slice[..],
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-length: {advertised}\r\nconnection: close\r\n\r\n"
            );
            let _ = stream.write_all(sent);
        }
    });
    Server {
        port,
        mode,
        ranges,
        hits,
    }
}

fn spec(server: &Server, body: &[u8]) -> FileSpec {
    FileSpec {
        name: "model.onnx".into(),
        url: format!("http://127.0.0.1:{}/model.onnx", server.port),
        sha256: Sha256::digest(body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        bytes: body.len() as u64,
    }
}

fn wait_for(device: &OnDevice, done: impl Fn(&Status) -> bool) -> Status {
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        let status = device.status();
        if done(&status) || Instant::now() > end {
            return status;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn body() -> Vec<u8> {
    (0..300_000u32).map(|i| (i % 251) as u8).collect()
}

#[test]
fn a_first_use_starts_the_download_and_finishes() {
    let data = body();
    let server = serve(data.clone());
    let root = tempfile::tempdir().unwrap();
    let device = OnDevice::with_files(root.path(), vec![spec(&server, &data)]);
    assert_eq!(device.status(), Status::NotDownloaded);
    let error = device
        .embed("search_query: hi", Duration::from_secs(2))
        .unwrap_err();
    assert!(
        error.0.contains("downloading for the first time"),
        "{error}"
    );
    let status = wait_for(&device, |s| matches!(s, Status::Ready | Status::Failed(_)));
    assert_eq!(status, Status::Ready);
    assert_eq!(
        std::fs::read(device.folder().join("model.onnx")).unwrap(),
        data
    );
    assert!(!device.folder().join("model.onnx.part").exists());
}

#[test]
fn a_cut_connection_is_a_clear_failure_and_the_next_try_resumes() {
    let data = body();
    let server = serve(data.clone());
    *server.mode.lock().unwrap() = Mode::CutAfter(100_000);
    let root = tempfile::tempdir().unwrap();
    let device = OnDevice::with_files(root.path(), vec![spec(&server, &data)]);
    device.start_download(false);
    let status = wait_for(&device, |s| matches!(s, Status::Ready | Status::Failed(_)));
    let Status::Failed(message) = status else {
        panic!("expected a failure, got {status:?}")
    };
    assert!(message.contains("could not be downloaded"), "{message}");
    assert!(
        !message.contains("127.0.0.1"),
        "an address leaked into the message"
    );
    let part = device.folder().join("model.onnx.part");
    assert_eq!(part.metadata().unwrap().len(), 100_000);

    *server.mode.lock().unwrap() = Mode::Good;
    device.start_download(true);
    assert_eq!(
        wait_for(&device, |s| matches!(s, Status::Ready | Status::Failed(_))),
        Status::Ready
    );
    assert_eq!(
        server.ranges.lock().unwrap().last().map(String::as_str),
        Some("from 100000")
    );
    assert_eq!(
        std::fs::read(device.folder().join("model.onnx")).unwrap(),
        data
    );
}

#[test]
fn a_server_that_ignores_ranges_restarts_the_file() {
    let data = body();
    let server = serve(data.clone());
    *server.mode.lock().unwrap() = Mode::CutAfter(50_000);
    let root = tempfile::tempdir().unwrap();
    let device = OnDevice::with_files(root.path(), vec![spec(&server, &data)]);
    device.start_download(false);
    wait_for(&device, |s| matches!(s, Status::Failed(_)));
    *server.mode.lock().unwrap() = Mode::NoRange;
    device.start_download(true);
    assert_eq!(
        wait_for(&device, |s| matches!(s, Status::Ready | Status::Failed(_))),
        Status::Ready
    );
    assert_eq!(
        std::fs::read(device.folder().join("model.onnx")).unwrap(),
        data
    );
}

#[test]
fn a_refusal_names_the_status_and_keeps_nothing() {
    let data = body();
    let server = serve(data.clone());
    *server.mode.lock().unwrap() = Mode::Status(503);
    let root = tempfile::tempdir().unwrap();
    let device = OnDevice::with_files(root.path(), vec![spec(&server, &data)]);
    device.start_download(false);
    let Status::Failed(message) = wait_for(&device, |s| matches!(s, Status::Failed(_))) else {
        panic!("expected a failure")
    };
    assert!(message.contains("503"), "{message}");
    assert!(!device.folder().join("model.onnx").exists());
}

#[test]
fn a_file_that_fails_its_hash_is_discarded_and_never_used() {
    let data = body();
    let server = serve(data.clone());
    *server.mode.lock().unwrap() = Mode::Corrupt;
    let root = tempfile::tempdir().unwrap();
    let device = OnDevice::with_files(root.path(), vec![spec(&server, &data)]);
    device.start_download(false);
    let Status::Failed(message) = wait_for(&device, |s| matches!(s, Status::Failed(_))) else {
        panic!("expected a failure")
    };
    assert!(message.contains("safety check"), "{message}");
    assert!(!device.folder().join("model.onnx").exists());
    assert!(!device.folder().join("model.onnx.part").exists());
}

#[test]
fn a_swapped_file_of_the_right_size_is_caught_before_it_is_loaded() {
    let data = body();
    let server = serve(data.clone());
    let root = tempfile::tempdir().unwrap();
    let device = OnDevice::with_files(root.path(), vec![spec(&server, &data)]);
    std::fs::create_dir_all(device.folder()).unwrap();
    std::fs::write(device.folder().join("model.onnx"), vec![7u8; data.len()]).unwrap();
    assert_eq!(device.status(), Status::Ready);
    let error = device
        .embed("search_query: hi", Duration::from_secs(5))
        .unwrap_err();
    assert!(error.0.contains("damaged"), "{error}");
    let status = wait_for(&device, |s| matches!(s, Status::Ready));
    assert_eq!(status, Status::Ready);
    assert_eq!(
        std::fs::read(device.folder().join("model.onnx")).unwrap(),
        data
    );
}

#[test]
fn a_second_process_waits_on_the_folder_lock_and_says_so() {
    let data = body();
    let server = serve(data.clone());
    let root = tempfile::tempdir().unwrap();
    let device = OnDevice::with_files(root.path(), vec![spec(&server, &data)]).with_waits(
        Duration::from_secs(60),
        Duration::from_millis(600),
        Duration::from_secs(60),
    );
    std::fs::create_dir_all(device.folder()).unwrap();
    let holder = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(device.folder().join(".lock"))
        .unwrap();
    holder.lock().unwrap();
    device.start_download(false);
    let waiting = wait_for(&device, |s| {
        matches!(s, Status::Downloading { waiting: true, .. })
    });
    assert!(
        matches!(waiting, Status::Downloading { waiting: true, .. }),
        "{waiting:?}"
    );
    let error = device
        .embed("search_query: hi", Duration::from_secs(1))
        .unwrap_err();
    assert!(error.0.contains("another Moss process"), "{error}");
    assert_eq!(
        server.hits.load(Ordering::SeqCst),
        0,
        "downloaded while the lock was held"
    );

    let Status::Failed(message) = wait_for(&device, |s| matches!(s, Status::Failed(_))) else {
        panic!("expected the lock wait to give up")
    };
    assert!(message.contains("Another Moss process"), "{message}");

    drop(holder);
    device.start_download(true);
    assert_eq!(
        wait_for(&device, |s| matches!(s, Status::Ready | Status::Failed(_))),
        Status::Ready
    );
}

#[test]
fn a_damaged_file_kept_on_size_is_still_caught_after_another_file_downloads() {
    let data = body();
    let server = serve(data.clone());
    let root = tempfile::tempdir().unwrap();
    let model = spec(&server, &data);
    let mut second = spec(&server, &data);
    second.name = "tokenizer.json".into();
    let device = OnDevice::with_files(root.path(), vec![model, second]);
    std::fs::create_dir_all(device.folder()).unwrap();
    // The model is the right size but wrong inside; the second file is missing.
    std::fs::write(device.folder().join("model.onnx"), vec![7u8; data.len()]).unwrap();
    device.start_download(false);
    assert_eq!(
        wait_for(&device, |s| matches!(s, Status::Ready | Status::Failed(_))),
        Status::Ready
    );
    let error = device
        .embed("search_query: hi", Duration::from_secs(5))
        .unwrap_err();
    assert!(error.0.contains("damaged"), "{error}");
}

#[test]
fn a_repair_replaces_only_the_files_that_fail_their_hash() {
    let data = body();
    let server = serve(data.clone());
    let root = tempfile::tempdir().unwrap();
    let model = spec(&server, &data);
    let mut second = spec(&server, &data);
    second.name = "tokenizer.json".into();
    let device = OnDevice::with_files(root.path(), vec![model, second]);
    std::fs::create_dir_all(device.folder()).unwrap();
    std::fs::write(device.folder().join("model.onnx"), vec![7u8; data.len()]).unwrap();
    std::fs::write(device.folder().join("tokenizer.json"), &data).unwrap();
    device.repair();
    assert_eq!(
        wait_for(&device, |s| matches!(s, Status::Ready | Status::Failed(_))),
        Status::Ready
    );
    assert_eq!(
        std::fs::read(device.folder().join("model.onnx")).unwrap(),
        data
    );
    assert_eq!(
        std::fs::read(device.folder().join("tokenizer.json")).unwrap(),
        data
    );
}
