//! Bounded loopback-only HTTP fixture, deliberately separate from production composition.
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{application::Application, frame::AssetPolicy};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
};
type Reply = (u16, Vec<u8>, String, Vec<(String, String)>);
pub fn serve(app: &Application, access: &AccessContext) -> Result<()> {
    let port: u16 = std::env::var("CALENDAR_BROWSER_PORT")?.parse()?;
    ensure!((5180..=5299).contains(&port), "Use a claimed dev port");
    let shared = PathBuf::from(std::env::var("CALENDAR_SHARED_DIR")?);
    let done = PathBuf::from(std::env::var("CALENDAR_BROWSER_DONE")?);
    let origin = format!("http://127.0.0.1:{port}");
    let policy = AssetPolicy::new(&origin)?;
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    println!("Calendar signed-package frame ready on claimed loopback port");
    let start = std::time::Instant::now();
    while !done.exists() && start.elapsed() < std::time::Duration::from_secs(1800) {
        let (mut stream, _) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        stream.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
        let response = respond(&mut stream, app, access, &shared, &policy, &origin);
        let (status, body, mime, headers) = response.unwrap_or_else(|_| {
            (
                500,
                b"Calendar frame check failed".to_vec(),
                "text/plain".into(),
                vec![],
            )
        });
        write!(stream,"HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nContent-Type: {mime}\r\nConnection: close\r\n",body.len())?;
        for (k, v) in headers {
            write!(stream, "{k}: {v}\r\n")?;
        }
        stream.write_all(b"\r\n")?;
        stream.write_all(&body)?;
    }
    ensure!(done.exists(), "Browser proof timed out");
    println!("Calendar frame check stopped cleanly");
    Ok(())
}
fn respond(
    stream: &mut TcpStream,
    app: &Application,
    access: &AccessContext,
    shared: &std::path::Path,
    policy: &AssetPolicy,
    origin: &str,
) -> Result<Reply> {
    let mut input = Vec::new();
    let mut buffer = [0; 8192];
    let end = loop {
        let n = stream.read(&mut buffer)?;
        ensure!(n > 0, "empty request");
        input.extend_from_slice(&buffer[..n]);
        ensure!(input.len() <= 1024 * 1024, "request too large");
        if let Some(i) = input.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let headers = std::str::from_utf8(&input[..end])?.to_string();
    let mut first = headers
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = first.next().unwrap_or_default();
    let path = first.next().unwrap_or_default();
    let header = |name: &str| {
        headers
            .lines()
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.trim())
    };
    ensure!(
        header("host") == origin.strip_prefix("http://"),
        "Unexpected host"
    );
    let length: usize = header("content-length").unwrap_or("0").parse()?;
    ensure!(length <= 1024 * 1024, "body too large");
    while input.len() < end + length {
        let n = stream.read(&mut buffer)?;
        ensure!(n > 0, "short body");
        input.extend_from_slice(&buffer[..n]);
    }
    if method != "GET" {
        ensure!(header("origin") == Some(origin), "Unexpected origin");
    }
    if path == "/" || path == "/settings" {
        let screen = app.installer.screen(
            access,
            "calendar",
            if path == "/settings" {
                "/settings/calendar"
            } else {
                "/calendar"
            },
        )?;
        let page = format!(
            r#"<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calendar package check</title><link rel="stylesheet" href="/module-shared/park-press.css"></head><body><p>Calendar signed-package check · synthetic account · not signed-in Moss</p><iframe title="Calendar" id="calendar" sandbox="{}" data-src="{}" style="width:100%;height:90vh;border:0"></iframe><script type="module" src="/parent.mjs"></script></body></html>"#,
            screen.sandbox, screen.src
        );
        return Ok((200, page.into_bytes(), "text/html".into(), vec![]));
    }
    if path == "/parent.mjs" {
        return Ok((
            200,
            include_bytes!("ui_parent.mjs").to_vec(),
            "text/javascript".into(),
            vec![],
        ));
    }
    if path == "/host-bridge.mjs" {
        return Ok((
            200,
            include_bytes!("../../../../rust-spike/module-ui/web/host-bridge.mjs").to_vec(),
            "text/javascript".into(),
            vec![],
        ));
    }
    if let Some(file) = path.strip_prefix("/module-shared/") {
        ensure!(
            moss_module_host::manifest::relative_path(file),
            "Unsafe asset"
        );
        return Ok((
            200,
            std::fs::read(shared.join(file))?,
            if file.ends_with(".css") {
                "text/css"
            } else {
                "font/woff2"
            }
            .into(),
            vec![("Access-Control-Allow-Origin".into(), "null".into())],
        ));
    }
    if let Some(file) = path.strip_prefix("/module-ui/") {
        let parts: Vec<_> = file.splitn(3, '/').collect();
        ensure!(parts.len() == 3, "Missing asset path");
        let asset = app
            .installer
            .ui_asset(parts[0], parts[1], parts[2], policy)?;
        return Ok((
            200,
            asset.body,
            asset.content_type.into(),
            asset.headers.into_iter().collect(),
        ));
    }
    if path.starts_with("/api/m/calendar/") {
        let value: serde_json::Value = serde_json::from_str(&app.dispatch_extended(
            access.clone(),
            method,
            path,
            std::str::from_utf8(&input[end..end + length])?,
        )?)?;
        return Ok((
            value["status"].as_u64().unwrap_or(500) as u16,
            serde_json::to_vec(&value["body"])?,
            "application/json".into(),
            vec![],
        ));
    }
    Ok((404, b"Not found".to_vec(), "text/plain".into(), vec![]))
}
