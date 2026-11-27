//! Test fixture for the phase 7 backup runner. Plants test data in a throwaway instance,
//! plays a writer and a hostile worker, inspects a paused drill, and scans for plaintext.
//! Every value it plants is generated in the run. Prints one JSON object on stdout.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use base64::Engine;
use bundled_db::cluster::{self, Endpoint};
use bundled_db::layout::Layout;
use bundled_db::{secrets, APP_DATABASE, SUPERUSER};
use keystore::custody;
use moss_backup::{archive, fence, ledger};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const ROLES: [&str; 5] = [
    "moss_admin",
    "jarvis_migration_owner",
    "jarvis_app_runtime",
    "jarvis_worker_runtime",
    "jarvis_auth_runtime",
];

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn required(args: &[String], name: &str) -> Result<String, String> {
    flag(args, name).ok_or_else(|| format!("{name} is required"))
}

fn all(args: &[String], name: &str) -> Vec<String> {
    args.windows(2)
        .filter(|w| w[0] == name)
        .map(|w| w[1].clone())
        .collect()
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn db(error: postgres::Error) -> String {
    cluster::db_error(&error)
}

/// A superuser connection to the instance's own running database.
fn live(instance: &Path) -> Result<postgres::Client, String> {
    let layout = Layout::open(&instance.join("database")).map_err(|e| e.to_string())?;
    let state = cluster::read_state(&layout)?;
    let endpoint = Endpoint::from_json(&state["endpoint"], &layout.run)
        .ok_or("the database is not running")?;
    let password = secrets::existing(&layout, SUPERUSER)?;
    endpoint.connect(SUPERUSER, &password, APP_DATABASE)
}

/// Writes `relative` under the instance, creating its folders.
fn write_file(instance: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let path = instance.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())
}

/// Plants an attachment with its database record, a job that would call the canary if any
/// worker ran it, and a secret marker row.
fn plant(args: &[String]) -> Result<Value, String> {
    let instance = PathBuf::from(required(args, "--instance")?);
    let canary = required(args, "--canary")?;
    let marker = required(args, "--marker")?;
    let content = format!(
        "attachment body {}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let relative = "vault/attachments/proof-attachment.txt";
    let _fence = fence::writer(&instance).map_err(|e| e.to_string())?;
    write_file(&instance, relative, content.as_bytes())?;
    let mut client = live(&instance)?;
    client
        .batch_execute(
            "CREATE SCHEMA IF NOT EXISTS backup_proof;
             CREATE TABLE IF NOT EXISTS backup_proof.attachments (path text PRIMARY KEY, size bigint, sha256 text);
             CREATE TABLE IF NOT EXISTS backup_proof.jobs (id serial PRIMARY KEY, url text, state text);
             CREATE TABLE IF NOT EXISTS backup_proof.notes (name text PRIMARY KEY, sha256 text);
             CREATE TABLE IF NOT EXISTS backup_proof.markers (value text);",
        )
        .map_err(db)?;
    client
        .execute(
            "INSERT INTO backup_proof.attachments VALUES ($1, $2, $3)",
            &[&relative, &(content.len() as i64), &sha(content.as_bytes())],
        )
        .map_err(db)?;
    client
        .execute(
            "INSERT INTO backup_proof.jobs (url, state) VALUES ($1, 'queued')",
            &[&canary],
        )
        .map_err(db)?;
    client
        .execute("INSERT INTO backup_proof.markers VALUES ($1)", &[&marker])
        .map_err(db)?;
    Ok(json!({ "attachment": relative, "sha256": sha(content.as_bytes()), "content": content }))
}

/// A writer that changes a file and its row under the fence, holding the fence in between.
fn writer(args: &[String]) -> Result<Value, String> {
    let instance = PathBuf::from(required(args, "--instance")?);
    let name = required(args, "--name")?;
    let hold: u64 = required(args, "--hold-ms")?
        .parse()
        .map_err(|_| "--hold-ms is a number")?;
    let _fence = fence::writer(&instance).map_err(|e| e.to_string())?;
    let body = format!("note {name} {}", hex::encode(rand::random::<[u8; 8]>()));
    write_file(
        &instance,
        &format!("vault/notes/{name}.txt"),
        body.as_bytes(),
    )?;
    println!("{}", json!({ "entered": name }));
    std::io::stdout().flush().ok();
    std::thread::sleep(Duration::from_millis(hold));
    let mut client = live(&instance)?;
    client
        .execute(
            "INSERT INTO backup_proof.notes VALUES ($1, $2)",
            &[&name, &sha(body.as_bytes())],
        )
        .map_err(db)?;
    Ok(json!({ "written": name }))
}

/// Connects to a database endpoint the way a worker would.
fn try_connect(
    socket_dir: Option<&str>,
    port: u16,
    role: &str,
    password: &str,
) -> Result<postgres::Client, String> {
    let mut config = postgres::Config::new();
    config
        .user(role)
        .password(password)
        .dbname(APP_DATABASE)
        .connect_timeout(Duration::from_secs(5));
    #[cfg(unix)]
    if let Some(dir) = socket_dir {
        config.host_path(dir);
    }
    if socket_dir.is_none() || cfg!(windows) {
        config.host("127.0.0.1");
    }
    config.port(port);
    config.connect(postgres::NoTls).map_err(db)
}

/// Calls a URL over plain HTTP, as a job runner would.
fn call(url: &str) -> Result<(), String> {
    let rest = url.strip_prefix("http://").ok_or("canary must be http")?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let mut stream = std::net::TcpStream::connect(host).map_err(|e| e.to_string())?;
    write!(stream, "GET /{path} HTTP/1.0\r\nHost: {host}\r\n\r\n").map_err(|e| e.to_string())?;
    let mut sink = Vec::new();
    let _ = stream.read_to_end(&mut sink);
    Ok(())
}

/// Plays a worker that holds every real credential of the instance and tries to sign in to the
/// drill's throwaway database. If it gets in, it runs the queued jobs, which call the canary.
fn hostile_worker(args: &[String]) -> Result<Value, String> {
    let instance = PathBuf::from(required(args, "--instance")?);
    let pause: Value = serde_json::from_slice(
        &std::fs::read(required(args, "--pause")?).map_err(|e| format!("pause marker: {e}"))?,
    )
    .map_err(|_| "pause marker is not JSON")?;
    let socket_dir = pause["socketDir"].as_str();
    let port = pause["port"].as_u64().ok_or("pause marker has no port")? as u16;
    let mut refused = Vec::new();
    let mut accepted = Vec::new();
    let mut called = 0;
    for role in ROLES {
        let password =
            keystore::database_secrets::read(&instance, role).map_err(|e| e.to_string())?;
        match try_connect(socket_dir, port, role, &password) {
            Err(_) => refused.push(role),
            Ok(mut client) => {
                accepted.push(role);
                if let Ok(rows) = client.query(
                    "SELECT url FROM backup_proof.jobs WHERE state = 'queued'",
                    &[],
                ) {
                    for row in rows {
                        if call(&row.get::<_, String>(0)).is_ok() {
                            called += 1;
                        }
                    }
                }
            }
        }
    }
    Ok(json!({ "refused": refused, "accepted": accepted, "called": called }))
}

/// Reads a paused drill's restored rows and files.
fn inspect_drill(args: &[String]) -> Result<Value, String> {
    let pause: Value = serde_json::from_slice(
        &std::fs::read(required(args, "--pause")?).map_err(|e| format!("pause marker: {e}"))?,
    )
    .map_err(|_| "pause marker is not JSON")?;
    let scratch = PathBuf::from(
        pause["scratch"]
            .as_str()
            .ok_or("pause marker has no scratch")?,
    );
    let files = PathBuf::from(pause["files"].as_str().ok_or("pause marker has no files")?);
    let layout = Layout::open(&scratch.join("cluster")).map_err(|e| e.to_string())?;
    let endpoint = Endpoint {
        socket_dir: pause["socketDir"].as_str().map(PathBuf::from),
        port: pause["port"].as_u64().ok_or("pause marker has no port")? as u16,
    };
    let password = secrets::existing(&layout, SUPERUSER)?;
    let mut client = endpoint.connect(SUPERUSER, &password, APP_DATABASE)?;
    let mut attachments = Vec::new();
    for row in client
        .query(
            "SELECT path, size, sha256 FROM backup_proof.attachments",
            &[],
        )
        .map_err(db)?
    {
        let path: String = row.get(0);
        let restored = std::fs::read(files.join(&path)).ok();
        attachments.push(json!({
            "path": path,
            "recordSha256": row.get::<_, String>(2),
            "recordSize": row.get::<_, i64>(1),
            "fileSha256": restored.as_deref().map(sha),
            "fileSize": restored.as_ref().map(Vec::len),
        }));
    }
    let rows: Vec<String> = client
        .query("SELECT name FROM backup_proof.notes ORDER BY 1", &[])
        .map_err(db)?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let mut note_files = Vec::new();
    if let Ok(dir) = std::fs::read_dir(files.join("vault/notes")) {
        for entry in dir.flatten() {
            if let Some(name) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.strip_suffix(".txt"))
            {
                note_files.push(name.to_owned());
            }
        }
    }
    note_files.sort();
    let jobs: i64 = client
        .query_one(
            "SELECT count(*) FROM backup_proof.jobs WHERE state = 'queued'",
            &[],
        )
        .map_err(db)?
        .get(0);
    let logins: Vec<String> = client
        .query(
            "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname <> current_user",
            &[],
        )
        .map_err(db)?
        .iter()
        .map(|r| r.get(0))
        .collect();
    Ok(json!({
        "attachments": attachments,
        "noteRows": rows,
        "noteFiles": note_files,
        "queuedJobs": jobs,
        "loginRoles": logins,
    }))
}

/// Reads the planted item and attachment after a new-machine restore and real sign-in.
fn restored(args: &[String]) -> Result<Value, String> {
    let instance = PathBuf::from(required(args, "--instance")?);
    let mut client = live(&instance)?;
    let count: i64 = client
        .query_one("SELECT count(*) FROM backup_proof.markers", &[])
        .map_err(db)?
        .get(0);
    if count != 1 {
        return Err("the planted item did not restore".into());
    }
    let marker: String = client
        .query_one("SELECT value FROM backup_proof.markers", &[])
        .map_err(db)?
        .get(0);
    if flag(args, "--marker").is_some_and(|expected| marker != expected) {
        return Err("the restored item differs from the source item".into());
    }
    let row = client
        .query_one("SELECT path, sha256 FROM backup_proof.attachments", &[])
        .map_err(db)?;
    let path: String = row.get(0);
    let expected: String = row.get(1);
    let bytes =
        std::fs::read(moss_backup::safe_join(&instance, &path)?).map_err(|e| e.to_string())?;
    if sha(&bytes) != expected || flag(args, "--sha256").is_some_and(|source| expected != source) {
        return Err("the attachment did not restore".into());
    }
    Ok(json!({"item": true, "attachment": true}))
}

/// Pushes `needle` and its common encodings.
fn encodings(list: &mut Vec<Vec<u8>>, needle: &[u8]) {
    list.push(needle.to_vec());
    list.push(hex::encode(needle).into_bytes());
    list.push(
        base64::engine::general_purpose::STANDARD
            .encode(needle)
            .into_bytes(),
    );
    list.push(
        base64::engine::general_purpose::STANDARD_NO_PAD
            .encode(needle)
            .into_bytes(),
    );
}

/// Searches every byte under `--root` for the instance's credentials, master key, every
/// archive's data key, and the planted markers.
fn scan(args: &[String]) -> Result<Value, String> {
    let instance = PathBuf::from(required(args, "--instance")?);
    let root = PathBuf::from(required(args, "--root")?);
    let master =
        keystore::database_secrets::instance_master(&instance).map_err(|e| e.to_string())?;
    let bundle = custody::read_bundle(&instance).map_err(|e| e.to_string())?;
    let payload: Value = serde_json::from_slice(
        &custody::unwrap_with_master(&bundle, &master).map_err(|e| e.to_string())?,
    )
    .map_err(|_| "credentials are not JSON")?;
    let mut needles = Vec::new();
    let mut leaves = Vec::new();
    collect_strings(&payload, &mut leaves);
    for leaf in leaves.iter().filter(|s| s.len() >= 8) {
        needles.push(leaf.as_bytes().to_vec());
    }
    encodings(&mut needles, master.bytes());
    let mut archives = 0;
    for entry in ledger::list(&instance)? {
        let path = ledger::archive_path(&instance, &entry.id);
        let mut input =
            std::io::BufReader::new(std::fs::File::open(&path).map_err(|e| e.to_string())?);
        let header = archive::read_header(&mut input)?;
        let key = archive::open_data_key(&header, &master)?;
        encodings(&mut needles, key.bytes());
        archives += 1;
    }
    for marker in all(args, "--marker") {
        needles.push(marker.into_bytes());
    }
    let hits: Vec<String> = custody::find_plaintext(&root, &needles)
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    Ok(json!({ "needles": needles.len(), "archives": archives, "hits": hits }))
}

fn collect_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

/// Fills a throwaway instance's ledger with one backup a day for `--days` days, ending today,
/// with matching archive files. `--pin N` and `--verify N` mark the backup N days back.
fn seed_ledger(args: &[String]) -> Result<Value, String> {
    let instance = PathBuf::from(required(args, "--instance")?);
    let days: u64 = required(args, "--days")?
        .parse()
        .map_err(|_| "--days is a number")?;
    let pins: Vec<u64> = all(args, "--pin")
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    let verified: Vec<u64> = all(args, "--verify")
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
    let now = moss_backup::now_seconds();
    let mut made = Vec::new();
    ledger::update(&instance, |entries| {
        for back in (0..days).rev() {
            let created_at = now - back * 86_400;
            let id = moss_backup::new_backup_id(created_at);
            let path = ledger::archive_path(&instance, &id);
            std::fs::write(&path, id.as_bytes()).map_err(|e| e.to_string())?;
            entries.push(ledger::Entry {
                id: id.clone(),
                created_at,
                size: id.len() as u64,
                sha256: sha(id.as_bytes()),
                verified: verified.contains(&back),
                verified_at: verified.contains(&back).then_some(created_at),
                pinned: pins.contains(&back),
            });
            made.push(json!({ "id": id, "daysBack": back }));
        }
        Ok(())
    })?;
    Ok(json!({ "seeded": made }))
}

/// Makes the ledger agree with an archive's current bytes, as if the damage happened before
/// it was recorded. Only a real restore can then tell the archive is bad.
fn rehash(args: &[String]) -> Result<Value, String> {
    let instance = PathBuf::from(required(args, "--instance")?);
    let id = required(args, "--id")?;
    let bytes = std::fs::read(ledger::archive_path(&instance, &id)).map_err(|e| e.to_string())?;
    ledger::update(&instance, |entries| {
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or("no such backup")?;
        entry.size = bytes.len() as u64;
        entry.sha256 = sha(&bytes);
        Ok(())
    })?;
    Ok(json!({ "id": id }))
}

/// A digest of the instance's own wrapped credentials, to compare with an opened archive.
fn credentials_digest(args: &[String]) -> Result<Value, String> {
    let instance = PathBuf::from(required(args, "--instance")?);
    let master =
        keystore::database_secrets::instance_master(&instance).map_err(|e| e.to_string())?;
    let bundle = custody::read_bundle(&instance).map_err(|e| e.to_string())?;
    let payload = custody::unwrap_with_master(&bundle, &master).map_err(|e| e.to_string())?;
    Ok(json!({ "credentialsSha256": sha(&payload) }))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = args.split_first() else {
        return ExitCode::from(2);
    };
    let result = match command.as_str() {
        "plant" => plant(rest),
        "restored" => restored(rest),
        "write" => writer(rest),
        "hostile-worker" => hostile_worker(rest),
        "inspect-drill" => inspect_drill(rest),
        "scan" => scan(rest),
        "forget" => (|| -> Result<Value, String> {
            let instance = PathBuf::from(required(rest, "--instance")?);
            let name = instance
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("missing fixture instance")?;
            keystore::platform::platform_store()
                .delete_master(&keystore::platform::service_name(name))
                .map_err(|_| "cannot remove fixture key")?;
            Ok(json!({"forgotten": true}))
        })(),
        "seed-ledger" => seed_ledger(rest),
        "rehash" => rehash(rest),
        "credentials-digest" => credentials_digest(rest),
        other => Err(format!("unknown command {other}")),
    };
    match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", json!({ "ok": false, "error": error }));
            ExitCode::from(1)
        }
    }
}
