//! Local browser check of a signed sample package. Synthetic account, temporary files,
//! no application sign-in or private data. This is not the Moss server or Tasks parity proof.
#[path = "../tests/common/mod.rs"]
mod common;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{
    archive::pack,
    frame::AssetPolicy,
    lifecycle::FileLifecycle,
    local::LocalPorts,
    registry::Source,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Catalog(Mutex<State>);
impl CatalogStore for Catalog {
    fn load(&self) -> Result<State> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn commit(&self, expected: u64, next: &State) -> Result<()> {
        let mut s = self.0.lock().unwrap();
        ensure!(s.revision == expected, "stale");
        *s = next.clone();
        Ok(())
    }
}
type HttpAsset = (Vec<u8>, String, Vec<(String, String)>);
fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().expect("claimed dev port").parse()?;
    let shared = PathBuf::from(args.next().expect("generated shared assets"));
    let data = tempfile::tempdir()?;
    let registry = tempfile::tempdir()?;
    let keys = common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let access = AccessContext::new(uuid::Uuid::new_v4(), "frame-browser-check");
    let installer = Installer::new(
        data.path(),
        Arc::new(Catalog::default()),
        Arc::new(FileLifecycle::new(
            data.path(),
            [access.actor_user_id()].into(),
        )?),
        Host::new(Limits::default())?,
        Arc::new(LocalPorts::new(data.path())?),
        "0.1.0".parse()?,
        LegacyInventory::default(),
    )?;
    let source = installer.refresh(
        &access,
        Source::Folder(registry.path().into()),
        &common::Keys::public(&keys.root),
        &common::Keys::public(&keys.root),
        "sample-registry",
    )?;
    let mut manifest = common::manifest("1.0.0");
    manifest
        .screens
        .insert("/counter".into(), "ui/index.html".into());
    manifest.routes.push(moss_module_host::manifest::Route {
        method: "POST".into(),
        path: "/save".into(),
        sign_in: true,
    });
    let mut files = common::files(&manifest);
    let request = r#"{"operation":"set","resource":"counter","parameters":{"count":9}}"#;
    let escaped: String = request.bytes().map(|b| format!("\\{b:02x}")).collect();
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat")
            .replace(
                "(data (i32.const 128) \"healthy\")",
                &format!("(data (i32.const 128) \"healthy\") (data (i32.const 256) \"{escaped}\")"),
            )
            .replace(
                "local.get $payload local.get $length i32.const 32 call $kv",
                &format!(
                    "i32.const 256 i32.const {} i32.const 32 call $kv",
                    request.len()
                ),
            ),
    )?;
    files.insert("code/module.wasm".into(), wasm);
    files.insert("ui/index.html".into(),br#"<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Counter package</title><link rel="stylesheet" href="/module-shared/park-press.css"><script type="module" src="./app.js"></script></head><body><header class="jds-masthead jds-masthead--field"><div class="jds-masthead__row"><div class="jds-masthead__main"><h1 class="jds-masthead__title">Counter package</h1><p class="jds-masthead__lede">A signed package running in the Rust host</p></div></div></header><button class="jds-btn jds-btn--primary" type="button" id="save">Save sample value</button><p role="status" id="status">Ready</p></body></html>"#.to_vec());
    files.insert("ui/app.js".into(),br#"import {moduleClient} from './guest-bridge.mjs'; const client=moduleClient(); document.querySelector('#save').addEventListener('click',async()=>{try{const value=await client.request('POST','/save',{});document.querySelector('#status').textContent=value.saved?'Saved through the Rust module host':'Not saved';}catch{document.querySelector('#status').textContent='Could not save';}});"#.to_vec());
    files.insert(
        "ui/guest-bridge.mjs".into(),
        include_bytes!("../../module-ui/web/guest-bridge.mjs").to_vec(),
    );
    let bytes = pack(&files)?;
    let digest = moss_module_host::trust::digest(&bytes);
    installer.import_file(
        &access,
        &source,
        &bytes,
        &common::Keys::sign(&keys.publisher, digest.as_bytes()),
        "sample",
        true,
    )?;
    let screen = installer.screen(&access, "sample.counter", "/counter")?;
    let origin = format!("http://127.0.0.1:{port}");
    let policy = AssetPolicy::new(&origin)?;
    let page = format!(
        r#"<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared module frame check</title><link rel="stylesheet" href="/module-shared/park-press.css"></head><body><h1>Shared module frame check</h1><p>Temporary sample account. This checks the package frame, not Tasks.</p><iframe id="module" title="Counter package" sandbox="{}" src="{}" width="100%" height="320"></iframe><script type="module">import {{connectModuleFrame}} from '/host-bridge.mjs';connectModuleFrame(document.querySelector('#module'),'sample.counter',{{request:async(method,path,body)=>{{const response=await fetch(path,{{method,headers:{{'Content-Type':'application/json'}},body:JSON.stringify(body)}});if(!response.ok)throw new Error();return response.json();}},theme:()=>({{theme:'sage'}}),navigate:()=>null,chat:()=>null}});</script></body></html>"#,
        screen.sandbox, screen.src
    );
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("frame-check ready {origin}");
    for stream in listener.incoming() {
        let mut stream = stream?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
        let response = (|| -> Result<HttpAsset> {
            let mut input = Vec::new();
            let mut buffer = [0u8; 8192];
            let end = loop {
                let n = stream.read(&mut buffer)?;
                ensure!(n > 0, "empty request");
                input.extend_from_slice(&buffer[..n]);
                ensure!(input.len() < 1024 * 1024, "too large");
                if let Some(end) = input.windows(4).position(|b| b == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = std::str::from_utf8(&input[..end])?;
            let mut first = headers.lines().next().unwrap().split_whitespace();
            let method = first.next().unwrap().to_string();
            let path = first.next().unwrap().to_string();
            let length = headers
                .lines()
                .find_map(|l| {
                    l.split_once(':')
                        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            ensure!(length < 1024 * 1024, "too large");
            while input.len() < end + length {
                let n = stream.read(&mut buffer)?;
                ensure!(n > 0, "short body");
                input.extend_from_slice(&buffer[..n]);
            }
            if path == "/" {
                return Ok((page.as_bytes().to_vec(), "text/html".into(), vec![]));
            }
            if path == "/host-bridge.mjs" {
                return Ok((
                    include_bytes!("../../module-ui/web/host-bridge.mjs").to_vec(),
                    "text/javascript".into(),
                    vec![],
                ));
            }
            if let Some(file) = path.strip_prefix("/module-shared/") {
                ensure!(
                    moss_module_host::manifest::relative_path(file),
                    "unsafe asset"
                );
                let mime = if file.ends_with(".css") {
                    "text/css"
                } else {
                    "font/woff2"
                };
                return Ok((
                    std::fs::read(shared.join(file))?,
                    mime.into(),
                    vec![("Access-Control-Allow-Origin".into(), "null".into())],
                ));
            }
            if let Some(path) = path.strip_prefix("/module-ui/") {
                let mut parts = path.splitn(3, '/');
                let id = parts.next().unwrap();
                let hash = parts.next().unwrap_or("");
                let file = parts.next().unwrap_or("");
                let asset = installer.ui_asset(id, hash, file, &policy)?;
                return Ok((
                    asset.body,
                    asset.content_type.into(),
                    asset.headers.into_iter().collect(),
                ));
            }
            if path.starts_with("/api/m/") {
                let value = installer.dispatch_extended(
                    access.clone(),
                    &method,
                    &path,
                    std::str::from_utf8(&input[end..end + length])?,
                )?;
                return Ok((value.into_bytes(), "application/json".into(), vec![]));
            }
            anyhow::bail!("unknown route")
        })();
        let (status, body, mime, headers) = match response {
            Ok((body, mime, headers)) => ("200 OK", body, mime, headers),
            Err(_) => (
                "400 Bad Request",
                b"Request refused".to_vec(),
                "text/plain".into(),
                vec![],
            ),
        };
        write!(stream,"HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n",body.len())?;
        for (k, v) in headers {
            write!(stream, "{k}: {v}\r\n")?;
        }
        write!(stream, "\r\n")?;
        stream.write_all(&body)?;
    }
    Ok(())
}
