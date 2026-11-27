//! Verifying a backup by restoring it.
//!
//! A backup counts as verified only after a drill opens every chunk, restores the database
//! into a throwaway cluster, writes every file into a throwaway folder, and finds the rows,
//! files and credentials the manifest promises. Checking the archive's hash alone proves
//! nothing about whether it restores.
//!
//! Nothing in the drill can act on the restored data. Every restored role is `NOLOGIN`, the
//! throwaway cluster has a fresh superuser password that exists only in the throwaway folder,
//! and on Unix it listens only on a socket in that folder. No worker can sign in, so no job
//! runs and nothing calls out.

use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use bundled_db::cluster::{self, Bundle, Listen, Running};
use bundled_db::dump::{self, Target};
use bundled_db::layout::Layout;
use bundled_db::{secrets, APP_DATABASE, SUPERUSER};
use keystore::custody;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::archive::{self, ArchiveReader};
use crate::{ledger, quote_ident};

/// The credential names every instance's key bundle must carry.
const DATABASE_SECRETS: [&str; 8] = [
    "moss_admin",
    "jarvis_migration_owner",
    "jarvis_app_runtime",
    "jarvis_worker_runtime",
    "jarvis_auth_runtime",
    "session-signing-secret",
    "connector-key",
    "ai-key",
];

pub struct Report {
    pub tables: usize,
    pub rows: i64,
    pub files: usize,
    pub dump_bytes: u64,
}

/// A started throwaway cluster that stops when dropped.
struct Scratch {
    layout: Layout,
    running: Option<Running>,
    _lock: Option<cluster::InstallLock>,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(mut running) = self.running.take() {
            let _ = cluster::stop(&self.layout, &mut running, Duration::from_secs(30));
        }
    }
}

/// Hashes what it reads.
struct HashingReader<R: Read> {
    inner: R,
    hash: Sha256,
    bytes: u64,
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.hash.update(&buffer[..count]);
        self.bytes += count as u64;
        Ok(count)
    }
}

/// Runs the drill for backup `id` under `scratch_parent`, then marks the ledger. A failed drill
/// marks the backup unverified.
pub fn verify(
    instance: &Path,
    bundle: &Bundle,
    id: &str,
    scratch_parent: &Path,
    pause: Option<&Path>,
) -> Result<Report, String> {
    let instance = crate::resolve_instance(instance)?;
    let entry = ledger::find(&instance, id)?;
    let folder = scratch_parent.join(format!(
        "drill-{id}-{}",
        hex::encode(rand::random::<[u8; 4]>())
    ));
    let result = drill(&instance, bundle, &entry, &folder, pause);
    let _ = std::fs::remove_dir_all(&folder);
    ledger::set_verified(&instance, id, result.is_ok())?;
    result
}

fn drill(
    instance: &Path,
    bundle: &Bundle,
    entry: &ledger::Entry,
    folder: &Path,
    pause: Option<&Path>,
) -> Result<Report, String> {
    let path = ledger::archive_path(instance, &entry.id);
    let open = || std::fs::File::open(&path).map_err(|e| format!("{}: {e}", path.display()));
    let (size, sha256) =
        archive::copy_hashed(&mut open()?, &mut io::sink()).map_err(|e| e.to_string())?;
    if size != entry.size || sha256 != entry.sha256 {
        return Err("the archive is not the file the ledger recorded".into());
    }
    let mut input = io::BufReader::new(open()?);
    let header = archive::read_header(&mut input)?;
    if header.backup_id != entry.id {
        return Err("the archive names a different backup".into());
    }
    let master =
        keystore::database_secrets::instance_master(instance).map_err(|e| e.to_string())?;
    let key = archive::open_data_key(&header, &master)?;
    check_credentials(header.key_bundle(), &master)?;
    let mut reader = ArchiveReader::new(input, &header, &key);

    crate::create_private_dir(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let files_root = folder.join("files");
    crate::create_private_dir(&files_root).map_err(|e| format!("{}: {e}", files_root.display()))?;
    let layout =
        Layout::create(&folder.join("cluster")).map_err(|e| format!("scratch cluster: {e}"))?;
    let lock = cluster::lock(&layout)?;
    cluster::initialize(&layout, bundle)?;
    let listen = if cfg!(unix) {
        Listen::SocketOnly
    } else {
        Listen::Loopback(None)
    };
    let running = cluster::start(&layout, bundle, &listen, Duration::from_secs(60))?;
    let mut scratch = Scratch {
        layout,
        running: Some(running),
        _lock: Some(lock),
    };
    let endpoint = scratch.running.as_ref().unwrap().endpoint.clone();
    let password = secrets::existing(&scratch.layout, SUPERUSER)?;

    let read_error = |e: io::Error| e.to_string();
    let (kind, _) = reader.next_entry().map_err(read_error)?;
    if kind != archive::ENTRY_ROLES {
        return Err("the archive does not start with its roles".into());
    }
    let mut roles_text = Vec::new();
    reader
        .content()
        .read_to_end(&mut roles_text)
        .map_err(read_error)?;
    let roles: Value =
        serde_json::from_slice(&roles_text).map_err(|_| "the roles entry is damaged")?;
    {
        let mut client = endpoint.connect(SUPERUSER, &password, "postgres")?;
        create_roles(&mut client, &roles)?;
    }

    let (kind, _) = reader.next_entry().map_err(read_error)?;
    if kind != archive::ENTRY_DUMP {
        return Err("the archive has no database dump".into());
    }
    let (dump_bytes, dump_sha256) = {
        let mut content = HashingReader {
            inner: reader.content(),
            hash: Sha256::new(),
            bytes: 0,
        };
        let target = Target {
            layout: &scratch.layout,
            bundle,
            endpoint: &endpoint,
            role: SUPERUSER,
            password: &password,
        };
        dump::restore(&target, "postgres", &mut content)?;
        io::copy(&mut content, &mut io::sink()).map_err(read_error)?;
        (content.bytes, hex::encode(content.hash.finalize()))
    };

    let mut restored = BTreeMap::new();
    let manifest = loop {
        let (kind, name) = reader.next_entry().map_err(read_error)?;
        match kind {
            archive::ENTRY_FILE => {
                let target = crate::safe_join(&files_root, &name)?;
                if restored.contains_key(&name) {
                    return Err(format!("the archive holds {name} twice"));
                }
                if let Some(parent) = target.parent() {
                    crate::create_private_dir(parent).map_err(|e| format!("{name}: {e}"))?;
                }
                let mut out =
                    crate::create_private_file(&target).map_err(|e| format!("{name}: {e}"))?;
                let (size, sha256) =
                    archive::copy_hashed(&mut reader.content(), &mut out).map_err(read_error)?;
                out.sync_all().map_err(|e| format!("{name}: {e}"))?;
                restored.insert(name, (size, sha256));
            }
            archive::ENTRY_MANIFEST => {
                let mut text = Vec::new();
                reader
                    .content()
                    .read_to_end(&mut text)
                    .map_err(read_error)?;
                break serde_json::from_slice::<Value>(&text)
                    .map_err(|_| "the manifest is damaged")?;
            }
            _ => return Err("the archive entries are out of order".into()),
        }
    };
    let (kind, _) = reader.next_entry().map_err(read_error)?;
    if kind != archive::ENTRY_END {
        return Err("the archive continues after its manifest".into());
    }

    if manifest["backupId"] != entry.id.as_str() {
        return Err("the manifest names a different backup".into());
    }
    if manifest["rolesSha256"] != hex::encode(Sha256::digest(&roles_text)).as_str() {
        return Err("the roles do not match the manifest".into());
    }
    let database = &manifest["database"];
    if database["dumpBytes"] != dump_bytes || database["dumpSha256"] != dump_sha256.as_str() {
        return Err("the database dump does not match the manifest".into());
    }
    let mut expected = BTreeMap::new();
    for file in manifest["files"]
        .as_array()
        .ok_or("the manifest lists no files")?
    {
        let name = file["path"]
            .as_str()
            .ok_or("the manifest is damaged")?
            .to_owned();
        let size = file["size"].as_u64().ok_or("the manifest is damaged")?;
        let sha256 = file["sha256"]
            .as_str()
            .ok_or("the manifest is damaged")?
            .to_owned();
        expected.insert(name, (size, sha256));
    }
    if expected != restored {
        return Err("the restored files do not match the manifest".into());
    }

    let mut client = endpoint.connect(SUPERUSER, &password, APP_DATABASE)?;
    let (_, counts) = crate::capture::row_counts(&mut client)?;
    if counts != database["rowCounts"] {
        return Err("the restored rows do not match the manifest".into());
    }
    let rows: i64 = counts
        .as_object()
        .map(|m| m.values().filter_map(Value::as_i64).sum())
        .unwrap_or(0);
    let tables = counts.as_object().map(|m| m.len()).unwrap_or(0);

    if let Some(marker) = pause {
        let body = json!({
            "stage": "drill-restored",
            "scratch": folder,
            "files": files_root,
            "socketDir": endpoint.socket_dir,
            "port": endpoint.port,
            "secrets": scratch.layout.secrets,
        });
        crate::test_pause(marker, &body.to_string())?;
    }
    drop(client);
    if let Some(mut running) = scratch.running.take() {
        cluster::stop(&scratch.layout, &mut running, Duration::from_secs(30))?;
    }
    Ok(Report {
        tables,
        rows,
        files: restored.len(),
        dump_bytes,
    })
}

/// The archive's key bundle must open with this instance's master key and hold every
/// database credential.
fn check_credentials(bundle: &Value, master: &custody::MasterKey) -> Result<(), String> {
    let payload = custody::unwrap_with_master(bundle, master).map_err(|e| e.to_string())?;
    let value: Value =
        serde_json::from_slice(&payload).map_err(|_| "the wrapped credentials are damaged")?;
    for name in DATABASE_SECRETS {
        if value["database_secrets"][name]
            .as_str()
            .is_none_or(str::is_empty)
        {
            return Err(format!("the wrapped credentials have no {name}"));
        }
    }
    Ok(())
}

/// Creates the archive's roles, none of which can sign in, and their memberships.
fn create_roles(client: &mut postgres::Client, roles: &Value) -> Result<(), String> {
    let flag = |on: bool, name: &str| {
        if on {
            name.to_string()
        } else {
            format!("NO{name}")
        }
    };
    for role in roles["roles"]
        .as_array()
        .ok_or("the roles entry is damaged")?
    {
        let name = role["name"].as_str().ok_or("the roles entry is damaged")?;
        let sql = format!(
            "CREATE ROLE {} NOLOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION {} {} {}",
            quote_ident(name),
            flag(role["inherit"].as_bool().unwrap_or(true), "INHERIT"),
            flag(role["createRole"].as_bool().unwrap_or(false), "CREATEROLE"),
            flag(role["createDb"].as_bool().unwrap_or(false), "CREATEDB"),
        );
        client
            .batch_execute(&sql)
            .map_err(|e| format!("restore role {name}: {}", cluster::db_error(&e)))?;
    }
    for grant in roles["memberships"]
        .as_array()
        .ok_or("the roles entry is damaged")?
    {
        let role = grant["role"].as_str().ok_or("the roles entry is damaged")?;
        let member = grant["member"]
            .as_str()
            .ok_or("the roles entry is damaged")?;
        let admin = if grant["admin"].as_bool().unwrap_or(false) {
            " WITH ADMIN OPTION"
        } else {
            ""
        };
        client
            .batch_execute(&format!(
                "GRANT {} TO {}{admin}",
                quote_ident(role),
                quote_ident(member)
            ))
            .map_err(|e| format!("restore membership {member}: {}", cluster::db_error(&e)))?;
    }
    Ok(())
}

/// Opens an archive with the recovery words alone, as a new computer would: the words open the
/// master key from the archive's own key bundle, and the master key opens the data key. Reads
/// and authenticates every chunk. Returns the backup id and a digest of the credentials.
pub fn open_with_words(path: &Path, words: &[String]) -> Result<(String, String, usize), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut input = io::BufReader::new(file);
    let header = archive::read_header(&mut input)?;
    let recovery = keystore::recovery::parse_words(words)
        .map_err(|_| custody::CustodyError::WrongWords.reason())?;
    let master =
        custody::master_from_recovery(header.key_bundle(), &recovery).map_err(|e| e.reason())?;
    let credentials =
        custody::unwrap_with_master(header.key_bundle(), &master).map_err(|e| e.reason())?;
    let key = archive::open_data_key(&header, &master)?;
    let mut reader = ArchiveReader::new(input, &header, &key);
    let mut entries = 0;
    loop {
        let (kind, _) = reader.next_entry().map_err(|e| e.to_string())?;
        if kind == archive::ENTRY_END {
            break;
        }
        io::copy(&mut reader.content(), &mut io::sink()).map_err(|e| e.to_string())?;
        entries += 1;
    }
    Ok((
        header.backup_id,
        hex::encode(Sha256::digest(&credentials)),
        entries,
    ))
}

/// Where drills run when the caller names no folder.
pub fn default_scratch() -> PathBuf {
    std::env::temp_dir()
}
