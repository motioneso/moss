//! Restore a chosen archive to a new instance. The destination must not already exist.
//! Authenticate the complete input before creating staging. Validate the restored database
//! and files, stop the isolated cluster, then publish with one same-filesystem rename.
use std::fs::{self, File};
use std::io::{self, BufReader, Seek};
use std::path::Path;

use bundled_db::cluster::Bundle;
use keystore::custody::{self, MasterKey, OsKeyStore};
use serde_json::{json, Value};

use crate::archive::{self, ArchiveReader, Header};

#[derive(Debug)]
pub enum Failure {
    WrongKey,
    Damaged,
    Destination,
    KeyStore(custody::CustodyError),
    Restore,
}
impl Failure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::WrongKey => "app_backup_wrong_key",
            Self::Damaged => "app_backup_damaged",
            Self::Destination => "app_restore_destination",
            Self::KeyStore(custody::CustodyError::Locked) => "app_keystore_locked",
            Self::KeyStore(_) => "app_keystore_unavailable",
            Self::Restore => "app_restore_failed",
        }
    }
    pub fn reason(&self) -> &'static str {
        match self {
            Self::WrongKey => "Those recovery words do not open this backup. Check all 24 words and try again.",
            Self::Damaged => "This backup is damaged or incomplete. Choose another copy of the backup.",
            Self::Destination => "Moss cannot restore here. Choose a new, empty destination; your existing Moss has not changed.",
            Self::KeyStore(custody::CustodyError::Locked) => "Unlock your computer's key store, then try Restore again.",
            Self::KeyStore(_) => "Moss could not save the restored key in your computer's key store. Sign in to your desktop, then try again.",
            Self::Restore => "Moss could not finish restoring. Your existing Moss has not changed. Check free space and folder permissions, then try again.",
        }
    }
    pub fn state(&self) -> Value {
        json!({"code": self.code(), "error": self.reason()})
    }
}

/// Display facts from the selected file. These are unverified until recovery words open it.
pub fn inspect(path: &Path) -> Result<Value, Failure> {
    let mut input = BufReader::new(File::open(path).map_err(|_| Failure::Damaged)?);
    let header = archive::read_header(&mut input).map_err(|_| Failure::Damaged)?;
    Ok(json!({
        "file": path.file_name().and_then(|s| s.to_str()).unwrap_or("Backup file"),
        "machine": header.value["source"]["machine"],
        "made": header.value["createdAt"],
        "version": header.value["source"]["version"],
        "accounts": header.value["source"]["accounts"],
    }))
}

fn open(input: &mut BufReader<File>, words: &[String]) -> Result<(Header, MasterKey), Failure> {
    input.rewind().map_err(|_| Failure::Damaged)?;
    let header = archive::read_header(input).map_err(|_| Failure::Damaged)?;
    let recovery = keystore::recovery::parse_words(words).map_err(|_| Failure::WrongKey)?;
    // The key id distinguishes a different valid sheet from corruption in its wrapped key.
    let bundle_header: Value = serde_json::from_str(
        header.key_bundle()["header"]
            .as_str()
            .ok_or(Failure::Damaged)?,
    )
    .map_err(|_| Failure::Damaged)?;
    if bundle_header["recoveryKeyId"] != recovery.id() {
        return Err(Failure::WrongKey);
    }
    let master = custody::master_from_recovery(header.key_bundle(), &recovery)
        .map_err(|_| Failure::Damaged)?;
    crate::drill::check_credentials(header.key_bundle(), &master).map_err(|_| Failure::Damaged)?;
    Ok((header, master))
}

/// Complete authentication pass. No staging directories, database tools or key-store writes.
fn check_chunks(
    input: &mut BufReader<File>,
    header: &Header,
    master: &MasterKey,
) -> Result<(), Failure> {
    let key = archive::open_data_key(header, master).map_err(|_| Failure::Damaged)?;
    let mut reader = ArchiveReader::new(input, header, &key);
    io::copy(&mut reader, &mut io::sink()).map_err(|_| Failure::Damaged)?;
    Ok(())
}

/// Restores a new generation. `prepare` binds machine-specific settings in staging, before
/// publication. It must never start the app or workers. Existing destinations are refused,
/// so callers can retain the working generation and switch their selected instance afterwards.
pub fn restore(
    path: &Path,
    words: &[String],
    destination: &Path,
    bundle: &Bundle,
    prepare: impl FnOnce(&Path, &mut Value) -> Result<(), String>,
    event: impl Fn(&str),
) -> Result<crate::drill::Report, Failure> {
    let mut input = BufReader::new(File::open(path).map_err(|_| Failure::Damaged)?);
    let (header, master) = open(&mut input, words)?;
    check_chunks(&mut input, &header, &master)?;
    event("archive-checked");
    let parent = destination.parent().ok_or(Failure::Destination)?;
    let name = destination
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(Failure::Destination)?;
    if !crate::valid_id(name) || !parent.is_dir() || destination.exists() {
        return Err(Failure::Destination);
    }
    let lock_path = parent.join("restore.lock");
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path)
        .map_err(|_| Failure::Restore)?;
    portability::file_lock::exclusive(&lock).map_err(|_| Failure::Restore)?;
    if destination.exists() {
        return Err(Failure::Destination);
    }
    let mut os_store = keystore::platform::platform_store();
    os_store.probe().map_err(Failure::KeyStore)?;
    let service = keystore::platform::service_name(name);
    match os_store.load_master(&service) {
        Err(custody::CustodyError::NoMaster) => (),
        Ok(_) => return Err(Failure::Destination),
        Err(e) => return Err(Failure::KeyStore(e)),
    }
    let stage = parent.join(format!(
        ".restore-{}",
        hex::encode(rand::random::<[u8; 12]>())
    ));
    // Exclusive creation under a private parent: archive paths cannot traverse a pre-existing link.
    fs::create_dir(&stage).map_err(|_| Failure::Restore)?;
    let result = (|| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))
                .map_err(|_| Failure::Restore)?;
        }
        event("staging-created");
        let (second, second_master) = open(&mut input, words)?;
        if second.value != header.value {
            return Err(Failure::Damaged);
        }
        let key = archive::open_data_key(&second, &second_master).map_err(|_| Failure::Damaged)?;
        let mut reader = ArchiveReader::new(&mut input, &second, &key);
        let payload = custody::unwrap_with_master(header.key_bundle(), &master)
            .map_err(|_| Failure::Damaged)?;
        let mut credentials: Value =
            serde_json::from_slice(&payload).map_err(|_| Failure::Damaged)?;
        let report = crate::drill::materialize(
            &mut reader,
            bundle,
            &header.backup_id,
            &stage.join("database"),
            &stage,
            None,
            |client| {
                // Only canonical runtime roles regain login. Archive-supplied extra roles stay NOLOGIN.
                for role in bundled_db::RUNTIME_ROLES
                    .into_iter()
                    .chain([bundled_db::SUPERUSER])
                {
                    let password = credentials["database_secrets"][role]
                        .as_str()
                        .ok_or("missing role credential")?;
                    client
                        .batch_execute(&format!(
                            "ALTER ROLE {} LOGIN PASSWORD '{}'",
                            crate::quote_ident(role),
                            password.replace('\'', "''")
                        ))
                        .map_err(|_| "could not restore database login")?;
                }
                Ok(())
            },
        )
        .map_err(|_| Failure::Restore)?;
        event("data-checked");
        rebind_database(&stage, destination, &mut credentials).map_err(|_| Failure::Restore)?;
        prepare(&stage, &mut credentials).map_err(|_| Failure::Restore)?;
        event("machine-prepared");
        // Neither local runtime state nor a headless key-file choice may arrive from another machine.
        for file in [
            "running.json",
            "key-file-choice.json",
            "credentials.json",
            "database.log",
            "service-stopped",
            "firewall.json",
            "firewalld-service.json",
        ] {
            let p = stage.join(file);
            if p.is_file() {
                fs::remove_file(p).map_err(|_| Failure::Restore)?;
            }
        }
        let recovery = keystore::recovery::parse_words(words).map_err(|_| Failure::WrongKey)?;
        let wrapped = custody::wrap_bundle(
            &master,
            &recovery,
            &serde_json::to_vec(&credentials).map_err(|_| Failure::Restore)?,
        );
        let path = stage.join(custody::BUNDLE_FILE);
        let mut out = crate::create_private_file(&path).map_err(|_| Failure::Restore)?;
        use std::io::Write;
        out.write_all(wrapped.to_string().as_bytes())
            .and_then(|_| out.sync_all())
            .map_err(|_| Failure::Restore)?;
        fs::remove_dir_all(stage.join("database/secrets")).map_err(|_| Failure::Restore)?;
        crate::create_private_dir(&stage.join("database/secrets")).map_err(|_| Failure::Restore)?;
        event("key-saving");
        os_store
            .store_master(&service, &master)
            .map_err(Failure::KeyStore)?;
        event("key-loading");
        let loaded = os_store.load_master(&service).map_err(Failure::KeyStore)?;
        if custody::unwrap_with_master(&wrapped, &loaded).map_err(Failure::KeyStore)?
            != serde_json::to_vec(&credentials).map_err(|_| Failure::Restore)?
        {
            return Err(Failure::Restore);
        }
        event("key-saved");
        // A concurrent restore must never replace a published instance (including an empty one).
        if destination.exists() {
            return Err(Failure::Destination);
        }
        fs::rename(&stage, destination).map_err(|_| Failure::Restore)?;
        #[cfg(unix)]
        if let Ok(folder) = File::open(parent) {
            let _ = folder.sync_all();
        }
        event("activated");
        Ok(report)
    })();
    if result.is_err() {
        // Never keep a failed partial restore. The destination has not been published.
        fs::remove_dir_all(&stage).map_err(|_| Failure::Restore)?;
        os_store
            .delete_master(&service)
            .map_err(Failure::KeyStore)?;
    }
    result
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Rebind database addresses to this generation, retaining the restored role passwords.
fn rebind_database(
    stage: &Path,
    destination: &Path,
    credentials: &mut Value,
) -> Result<(), String> {
    #[cfg(unix)]
    let host = format!(
        "{}:5432",
        encode(
            &bundled_db::layout::prospective_run(&destination.join("database"))
                .map_err(|e| e.to_string())?
                .to_string_lossy()
        )
    );
    #[cfg(windows)]
    let host = {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        fs::write(stage.join("database.port"), port.to_string()).map_err(|e| e.to_string())?;
        format!("127.0.0.1:{port}")
    };
    let _ = stage;
    for (field, role) in [
        ("app_url", "jarvis_app_runtime"),
        ("auth_url", "jarvis_auth_runtime"),
        ("migrations_url", "jarvis_migration_owner"),
        ("worker_url", "jarvis_worker_runtime"),
        ("module_producer_url", "jarvis_app_runtime"),
        ("module_migrations_url", "jarvis_migration_owner"),
        ("module_worker_url", "jarvis_worker_runtime"),
    ] {
        if credentials.get(field).is_some() || ["app_url", "auth_url"].contains(&field) {
            let password = credentials["database_secrets"][role]
                .as_str()
                .ok_or("missing role credential")?;
            credentials[field] = json!(format!(
                "postgres://{role}:{}@{host}/{}",
                encode(password),
                bundled_db::APP_DATABASE
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn wrong_words_and_late_chunk_damage_write_nothing() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("test.mossbak");
        let recovery = keystore::recovery::RecoveryKey::generate();
        let master = MasterKey::from_bytes(rand::random());
        let mut secrets = json!({});
        for role in bundled_db::RUNTIME_ROLES.into_iter().chain([
            bundled_db::SUPERUSER,
            "session-signing-secret",
            "connector-key",
            "ai-key",
        ]) {
            secrets[role] = json!(hex::encode(rand::random::<[u8; 32]>()));
        }
        let bundle = custody::wrap_bundle(
            &master,
            &recovery,
            json!({"database_secrets": secrets}).to_string().as_bytes(),
        );
        let mut archive =
            archive::ArchiveWriter::new(File::create(&path).unwrap(), "test", 1, &master, &bundle)
                .unwrap();
        archive
            .begin_entry(archive::ENTRY_FILE, "vault/test")
            .unwrap();
        archive
            .segment(&vec![42; archive::CHUNK_SIZE + 10])
            .unwrap();
        archive.end_entry().unwrap();
        archive.write_all(&[archive::ENTRY_END]).unwrap();
        archive.finish().unwrap();
        let parent = scratch.path().join("target");
        fs::create_dir(&parent).unwrap();
        let destination = parent.join("new-machine");
        let pg = Bundle {
            root: scratch.path().join("unavailable-postgres"),
        };
        let wrong: Vec<String> = keystore::recovery::RecoveryKey::generate()
            .words()
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(matches!(
            restore(
                &path,
                &wrong,
                &destination,
                &pg,
                |_, _| panic!("must not write"),
                |_| panic!("must not reach staging")
            ),
            Err(Failure::WrongKey)
        ));
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&path, bytes).unwrap();
        let words: Vec<String> = recovery.words().iter().map(|s| s.to_string()).collect();
        assert!(matches!(
            restore(
                &path,
                &words,
                &destination,
                &pg,
                |_, _| panic!("must not write"),
                |_| panic!("must not reach staging")
            ),
            Err(Failure::Damaged)
        ));
        assert_eq!(
            fs::read_dir(&parent).unwrap().count(),
            0,
            "target listing must be empty"
        );
    }
}
