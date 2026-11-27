//! Key custody for one instance.
//!
//! The instance master key lives in the operating system key store. The credentials are
//! held in a wrapped bundle beside the instance config. The bundle holds no plaintext.
//! A 24 word recovery key wraps the same master key, so the words alone restore the bundle.
//! The only file that may hold a key is a key file the owner chooses at setup on a headless
//! Linux server with no keychain session. A desktop session never gets that choice.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use crate::recovery::{RecoveryKey, WordsError};

pub const BUNDLE_FILE: &str = "key-bundle.json";
pub const LEGACY_CREDENTIALS: &str = "credentials.json";
const BUNDLE_KIND: &str = "moss-key-custody-bundle";
const KEY_FILE_KIND: &str = "moss-master-key-file";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustodyError {
    Locked,
    Unavailable(String),
    /// The key store works, but holds no master key for this instance yet.
    NoMaster,
    /// There is no keychain session at all, as on a headless server.
    NoSession,
    WrongWords,
    BadWords(WordsError),
    Damaged(String),
    Io(String),
}

impl CustodyError {
    pub fn code(&self) -> &'static str {
        match self {
            CustodyError::Locked => "app_keystore_locked",
            _ => "app_keystore_unavailable",
        }
    }

    pub fn reason(&self) -> String {
        match self {
            CustodyError::NoSession => {
                "No key store found. Check your key store, then try again.".to_string()
            }
            CustodyError::NoMaster => {
                "No key was found in your key store. Restore with your recovery words, then try again.".to_string()
            }
            CustodyError::Locked => {
                "Your key store is locked. Unlock your key store, then try again.".to_string()
            }
            CustodyError::Unavailable(_) => {
                "No key store found. Check your key store, then try again.".to_string()
            }
            CustodyError::WrongWords => {
                "Those recovery words do not open this Moss. Check the words and try again."
                    .to_string()
            }
            CustodyError::BadWords(_) => "Check the recovery words and try again.".to_string(),
            CustodyError::Damaged(detail) => format!("The saved key bundle is damaged. {detail}"),
            CustodyError::Io(detail) => format!("Moss could not use the key store. {detail}"),
        }
    }
}

impl std::fmt::Display for CustodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.reason())
    }
}
impl std::error::Error for CustodyError {}

/// The instance master key. No Debug or Display, so it cannot reach a log line.
pub struct MasterKey([u8; 32]);

impl MasterKey {
    pub fn generate() -> Self {
        Self(rand::random())
    }
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// One operating system key store. Implementations hold only the master key.
pub trait OsKeyStore {
    fn store_master(&mut self, service: &str, master: &MasterKey) -> Result<(), CustodyError>;
    fn load_master(&self, service: &str) -> Result<MasterKey, CustodyError>;
    fn delete_master(&mut self, service: &str) -> Result<(), CustodyError>;
    fn probe(&self) -> Result<(), CustodyError>;
}

impl OsKeyStore for Box<dyn OsKeyStore> {
    fn store_master(&mut self, service: &str, master: &MasterKey) -> Result<(), CustodyError> {
        self.as_mut().store_master(service, master)
    }
    fn load_master(&self, service: &str) -> Result<MasterKey, CustodyError> {
        self.as_ref().load_master(service)
    }
    fn delete_master(&mut self, service: &str) -> Result<(), CustodyError> {
        self.as_mut().delete_master(service)
    }
    fn probe(&self) -> Result<(), CustodyError> {
        self.as_ref().probe()
    }
}

impl OsKeyStore for Box<dyn OsKeyStore + Send> {
    fn store_master(&mut self, service: &str, master: &MasterKey) -> Result<(), CustodyError> {
        self.as_mut().store_master(service, master)
    }
    fn load_master(&self, service: &str) -> Result<MasterKey, CustodyError> {
        self.as_ref().load_master(service)
    }
    fn delete_master(&mut self, service: &str) -> Result<(), CustodyError> {
        self.as_mut().delete_master(service)
    }
    fn probe(&self) -> Result<(), CustodyError> {
        self.as_ref().probe()
    }
}

/// An in-memory store for tests and the runner. It can be made locked or missing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FakeMode {
    Working,
    Locked,
    Missing,
    Broken,
}

pub struct MemoryStore {
    pub mode: FakeMode,
    master: Option<[u8; 32]>,
}

impl MemoryStore {
    pub fn new(mode: FakeMode) -> Self {
        Self { mode, master: None }
    }
    fn gate(&self) -> Result<(), CustodyError> {
        match self.mode {
            FakeMode::Working => Ok(()),
            FakeMode::Locked => Err(CustodyError::Locked),
            FakeMode::Missing => Err(CustodyError::NoSession),
            FakeMode::Broken => Err(CustodyError::Unavailable("key store did not answer".into())),
        }
    }
}

impl OsKeyStore for MemoryStore {
    fn store_master(&mut self, _service: &str, master: &MasterKey) -> Result<(), CustodyError> {
        self.gate()?;
        self.master = Some(*master.bytes());
        Ok(())
    }
    fn load_master(&self, _service: &str) -> Result<MasterKey, CustodyError> {
        self.gate()?;
        self.master
            .map(MasterKey::from_bytes)
            .ok_or(CustodyError::NoMaster)
    }
    fn delete_master(&mut self, _service: &str) -> Result<(), CustodyError> {
        self.gate()?;
        self.master = None;
        Ok(())
    }
    fn probe(&self) -> Result<(), CustodyError> {
        self.gate()
    }
}

fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Value {
    let nonce: [u8; 12] = rand::random();
    let sealed = Aes256Gcm::new(key.into())
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("small messages always seal");
    json!({ "nonce": STANDARD.encode(nonce), "sealed": STANDARD.encode(sealed) })
}

fn unseal(key: &[u8; 32], aad: &[u8], sealed: &Value) -> Option<Vec<u8>> {
    let nonce = STANDARD
        .decode(sealed.get("nonce")?.as_str()?)
        .ok()
        .filter(|n: &Vec<u8>| n.len() == 12)?;
    let sealed = STANDARD.decode(sealed.get("sealed")?.as_str()?).ok()?;
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &sealed, aad })
        .ok()
}

pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), CustodyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| CustodyError::Io(format!("create private-file parent: {e}")))?;
    }
    if fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(CustodyError::Damaged(
            "a link is in the way of a private file".into(),
        ));
    }
    let staging = path.with_extension("staging");
    let _ = fs::remove_file(&staging);
    let written = (|| -> Result<(), CustodyError> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&staging)
            .map_err(|e| CustodyError::Io(format!("open bundle staging file: {e}")))?;
        use std::io::Write;
        file.write_all(bytes)
            .map_err(|e| CustodyError::Io(format!("write bundle staging file: {e}")))?;
        file.sync_all()
            .map_err(|e| CustodyError::Io(format!("sync bundle staging file: {e}")))?;
        drop(file);
        #[cfg(windows)]
        let replaced = crate::windows_replace::rename_sibling(&staging, path);
        #[cfg(not(windows))]
        let replaced = fs::rename(&staging, path);
        replaced.map_err(|e| CustodyError::Io(format!("replace private file: {e}")))
    })();
    if written.is_err() {
        let _ = fs::remove_file(&staging);
    }
    if written.is_ok() {
        if let Some(parent) = path.parent() {
            sync_folder(parent);
        }
    }
    written
}

/// Best-effort folder sync, so a rename or deletion survives a power loss.
pub(crate) fn sync_folder(folder: &Path) {
    #[cfg(unix)]
    {
        if let Ok(file) = fs::File::open(folder) {
            let _ = file.sync_all();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = folder;
    }
}

/// Records the owner's headless key-file choice beside the bundle. The file itself
/// lives outside the instance root, where setup chose it.
pub fn record_key_file_choice(instance_root: &Path, key_file: &Path) -> Result<(), CustodyError> {
    let key_file = headless_key_file_path(instance_root, key_file)?;
    let body = json!({ "kind": "moss-key-file-choice", "path": key_file.display().to_string() });
    write_private(
        &instance_root.join("key-file-choice.json"),
        &serde_json::to_vec_pretty(&body).unwrap(),
    )
}

/// Clears a previous headless choice after preparing a new OS-store bundle.
pub fn clear_key_file_choice(instance_root: &Path) -> Result<(), CustodyError> {
    match fs::remove_file(instance_root.join("key-file-choice.json")) {
        Ok(()) => {
            sync_folder(instance_root);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(CustodyError::Io(e.to_string())),
    }
}

/// The recorded key file for this instance, if the owner chose one at setup.
pub fn recorded_key_file(instance_root: &Path) -> Option<PathBuf> {
    let body = fs::read(instance_root.join("key-file-choice.json")).ok()?;
    let value: Value = serde_json::from_slice(&body).ok()?;
    if value.get("kind").and_then(Value::as_str) != Some("moss-key-file-choice") {
        return None;
    }
    value
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// Wraps credentials with the master key. The recovery key wraps the master key.
pub fn wrap_bundle(master: &MasterKey, recovery: &RecoveryKey, credentials: &[u8]) -> Value {
    let header = json!({
        "kind": BUNDLE_KIND,
        "encodingVersion": 1,
        "recoveryKeyId": recovery.id(),
    });
    let header_text = header.to_string();
    json!({
        "header": header_text,
        "masterByRecovery": seal(recovery.bytes(), header_text.as_bytes(), master.bytes()),
        "payload": seal(master.bytes(), header_text.as_bytes(), credentials),
    })
}

fn header_of(bundle: &Value) -> Result<String, CustodyError> {
    let header_text = bundle
        .get("header")
        .and_then(Value::as_str)
        .ok_or_else(|| CustodyError::Damaged("no header".into()))?
        .to_string();
    let header: Value = serde_json::from_str(&header_text)
        .map_err(|_| CustodyError::Damaged("header not readable".into()))?;
    if header.get("kind").and_then(Value::as_str) != Some(BUNDLE_KIND) {
        return Err(CustodyError::Damaged("unknown kind".into()));
    }
    Ok(header_text)
}

pub fn unwrap_with_master(bundle: &Value, master: &MasterKey) -> Result<Vec<u8>, CustodyError> {
    let header = header_of(bundle)?;
    unseal(
        master.bytes(),
        header.as_bytes(),
        bundle
            .get("payload")
            .ok_or_else(|| CustodyError::Damaged("no payload".into()))?,
    )
    .ok_or_else(|| CustodyError::Damaged("payload failed its safety check".into()))
}

pub fn unwrap_with_recovery(
    bundle: &Value,
    recovery: &RecoveryKey,
) -> Result<Vec<u8>, CustodyError> {
    let header = header_of(bundle)?;
    let master_bytes = unseal(
        recovery.bytes(),
        header.as_bytes(),
        bundle
            .get("masterByRecovery")
            .ok_or_else(|| CustodyError::Damaged("no wrapped master key".into()))?,
    )
    .ok_or(CustodyError::WrongWords)?;
    let master: [u8; 32] = master_bytes
        .try_into()
        .map_err(|_| CustodyError::WrongWords)?;
    unwrap_with_master(bundle, &MasterKey::from_bytes(master))
}

/// The master key a recovery key unwraps, so a restore can put it back in a store.
pub fn master_from_recovery(
    bundle: &Value,
    recovery: &RecoveryKey,
) -> Result<MasterKey, CustodyError> {
    let header = header_of(bundle)?;
    let master_bytes = unseal(
        recovery.bytes(),
        header.as_bytes(),
        bundle
            .get("masterByRecovery")
            .ok_or_else(|| CustodyError::Damaged("no wrapped master key".into()))?,
    )
    .ok_or(CustodyError::WrongWords)?;
    let bytes: [u8; 32] = master_bytes
        .try_into()
        .map_err(|_| CustodyError::WrongWords)?;
    Ok(MasterKey::from_bytes(bytes))
}

/// Restores the master key into a store from typed recovery words.
pub fn restore_to_store(
    bundle: &Value,
    typed: &[String],
    store: &mut dyn OsKeyStore,
    service: &str,
) -> Result<Vec<u8>, CustodyError> {
    let recovery = crate::recovery::parse_words(typed).map_err(CustodyError::BadWords)?;
    let master = master_from_recovery(bundle, &recovery)?;
    let payload = unwrap_with_master(bundle, &master)?;
    store.store_master(service, &master)?;
    Ok(payload)
}

/// Restores the wrapped bundle from typed recovery words. Wrong words are refused.
pub fn restore_with_words(bundle: &Value, typed: &[String]) -> Result<Vec<u8>, CustodyError> {
    let recovery = crate::recovery::parse_words(typed).map_err(CustodyError::BadWords)?;
    unwrap_with_recovery(bundle, &recovery)
}

/// The headless key-file store. It holds the master key in the file the owner
/// chose at setup, and nowhere else.
pub struct KeyFileStore {
    path: PathBuf,
}

impl KeyFileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl OsKeyStore for KeyFileStore {
    fn store_master(&mut self, _service: &str, master: &MasterKey) -> Result<(), CustodyError> {
        write_key_file(&self.path, master)
    }
    fn load_master(&self, _service: &str) -> Result<MasterKey, CustodyError> {
        read_key_file(&self.path)
    }
    fn delete_master(&mut self, _service: &str) -> Result<(), CustodyError> {
        let _ = fs::remove_file(&self.path);
        Ok(())
    }
    fn probe(&self) -> Result<(), CustodyError> {
        // A recorded file that is missing or damaged is not a working store.
        read_key_file(&self.path).map(|_| ())
    }
}

/// Sets up a headless instance whose master key lives in the chosen key file.
/// Records the choice beside the bundle, so a later server start honours only
/// that recorded file.
pub fn set_up_headless(
    instance_root: &Path,
    credentials: &[u8],
    key_file: &Path,
    session: &mut dyn OsKeyStore,
) -> Result<HeadlessPrepared, CustodyError> {
    // A key file inside the instance root would travel with the bundle it opens.
    let chosen = headless_key_file_path(instance_root, key_file)?;
    // The route comes from the caller's real session store. A working store,
    // a locked one and a broken one all stop this path.
    match setup_route(false, session.probe()) {
        SetupRoute::KeyFileChoice => {}
        SetupRoute::OsStore => {
            return Err(CustodyError::Unavailable(
                "this machine has a key store, so the key file is not offered".into(),
            ))
        }
        SetupRoute::Stop(error) => return Err(error),
    }
    let mut store = KeyFileStore::new(chosen.clone());
    let prepared = prepare(instance_root, credentials, &mut store, "headless", false)?;
    record_key_file_choice(instance_root, &chosen)?;
    Ok(HeadlessPrepared { prepared, store })
}

/// A headless migration waiting for the owner to copy the recovery words.
pub struct HeadlessPrepared {
    prepared: Prepared,
    store: KeyFileStore,
}

impl HeadlessPrepared {
    pub fn words(&self) -> Vec<&'static str> {
        self.prepared.words()
    }
    pub fn bundle_path(&self) -> &Path {
        self.prepared.bundle_path()
    }
    pub fn commit(mut self) -> Result<Migration, CustodyError> {
        self.prepared.commit_with(&mut self.store, "headless")
    }
}

/// Resolve the chosen path before creating a key, including existing parent
/// symlinks. Both setup and migration use this guard before writing the master.
pub fn headless_key_file_path(
    instance_root: &Path,
    key_file: &Path,
) -> Result<PathBuf, CustodyError> {
    let root = fs::canonicalize(instance_root).map_err(|e| CustodyError::Io(e.to_string()))?;
    let mut ancestor = absolute_lexical(key_file);
    let mut missing = Vec::new();
    let chosen = loop {
        match fs::canonicalize(&ancestor) {
            Ok(mut resolved) => {
                for name in missing.iter().rev() {
                    resolved.push(name);
                }
                break resolved;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = ancestor
                    .file_name()
                    .ok_or_else(|| CustodyError::Io(error.to_string()))?
                    .to_os_string();
                missing.push(name);
                ancestor.pop();
            }
            Err(error) => return Err(CustodyError::Io(error.to_string())),
        }
    };
    if chosen.starts_with(&root) {
        return Err(CustodyError::Damaged(
            "choose a key file outside the server folder".into(),
        ));
    }
    Ok(chosen)
}

fn absolute_lexical(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for part in absolute.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether this session may be offered the headless key file at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupRoute {
    OsStore,
    /// Headless Linux with no keychain session. The owner chooses the file at setup.
    KeyFileChoice,
    /// Desktop session whose key store is locked, missing or broken. Setup stops.
    Stop(CustodyError),
}

/// Decides the setup route. A desktop session never falls back to a key file.
pub fn setup_route(desktop_session: bool, probe: Result<(), CustodyError>) -> SetupRoute {
    match probe {
        Ok(()) => SetupRoute::OsStore,
        Err(CustodyError::Locked) => SetupRoute::Stop(CustodyError::Locked),
        // Only a machine with no keychain session at all may choose a key file.
        // A store that is there but broken stops setup on every machine.
        Err(CustodyError::NoSession) if !desktop_session => SetupRoute::KeyFileChoice,
        Err(error) => SetupRoute::Stop(error),
    }
}

/// Refuses to start when the key store is locked or unavailable.
pub fn start_gate(store: &dyn OsKeyStore, service: &str) -> Result<MasterKey, CustodyError> {
    store.load_master(service)
}

/// Writes the master key to an owner chosen key file. Headless setup only.
pub fn write_key_file(path: &Path, master: &MasterKey) -> Result<(), CustodyError> {
    let body = json!({
        "kind": KEY_FILE_KIND,
        "encodingVersion": 1,
        "masterKey": STANDARD.encode(master.bytes()),
    });
    write_private(path, &serde_json::to_vec_pretty(&body).unwrap())
}

pub fn read_key_file(path: &Path) -> Result<MasterKey, CustodyError> {
    let bytes = fs::read(path).map_err(|e| CustodyError::Unavailable(e.to_string()))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| CustodyError::Damaged("key file not readable".into()))?;
    if value.get("kind").and_then(Value::as_str) != Some(KEY_FILE_KIND) {
        return Err(CustodyError::Damaged("unknown key file kind".into()));
    }
    let raw = STANDARD
        .decode(value.get("masterKey").and_then(Value::as_str).unwrap_or(""))
        .map_err(|_| CustodyError::Damaged("no readable master key".into()))?;
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| CustodyError::Damaged("master key has the wrong size".into()))?;
    Ok(MasterKey::from_bytes(bytes))
}

/// Loads the master key for a server start. The OS store wins. A key file counts only
/// when the caller names it, which setup does only for a headless server.
pub fn load_master(
    store: &dyn OsKeyStore,
    service: &str,
    key_file: Option<&Path>,
) -> Result<MasterKey, CustodyError> {
    match store.load_master(service) {
        Ok(master) => Ok(master),
        // Only a machine with no keychain session, or a working store that
        // holds no master yet, may use the recorded file. A locked or broken
        // store still refuses.
        Err(error @ (CustodyError::NoSession | CustodyError::NoMaster)) => match key_file {
            Some(path) => read_key_file(path),
            None => Err(error),
        },
        Err(error) => Err(error),
    }
}

/// Finds files under `root` that contain any of the secret byte strings.
pub fn find_plaintext(root: &Path, secrets: &[Vec<u8>]) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some(dir) = stack.pop() {
        // A linked folder that points back to a parent must not loop forever.
        let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !visited.insert(canonical) {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            // A disappearing live database folder has no bytes left to scan.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            // A folder that cannot be read cannot be cleared, so it counts.
            Err(_) => {
                hits.push(dir);
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                // An entry that cannot be read cannot be cleared either.
                Err(_) => {
                    hits.push(dir.clone());
                    continue;
                }
            };
            let path = entry.path();
            // The is_dir check follows links on purpose: a linked folder
            // holding a plain copy still counts, and the visited set above
            // keeps the walk finite.
            if path.is_dir() {
                stack.push(path);
            } else {
                match crate::plaintext_scan::contains(&path, secrets) {
                    Ok(true) => hits.push(path),
                    Ok(false) => {}
                    // A file that cannot be read cannot be cleared, so it counts.
                    Err(_) => hits.push(path),
                }
            }
        }
    }
    hits.sort();
    hits
}

fn collect_leaves(value: &Value, out: &mut Vec<Vec<u8>>) {
    match value {
        Value::String(text) if text.len() >= 4 => out.push(text.as_bytes().to_vec()),
        Value::Array(items) => items.iter().for_each(|item| collect_leaves(item, out)),
        Value::Object(object) => object.values().for_each(|item| collect_leaves(item, out)),
        _ => {}
    }
}

/// The password inside a connection string such as a database address,
/// split out so a bare copy of it is caught by the search too.
fn url_passwords(text: &str) -> Vec<Vec<u8>> {
    let Some(rest) = text.split_once("://").map(|(_, rest)| rest) else {
        return Vec::new();
    };
    let (authority, _) = rest.split_once(['/', '?', '#']).unwrap_or((rest, ""));
    let Some(userinfo) = authority.rsplit_once('@').map(|(info, _)| info) else {
        return Vec::new();
    };
    let Some(password) = userinfo.split_once(':').map(|(_, password)| password) else {
        return Vec::new();
    };
    // Shorter than four characters cannot be searched for: it matches
    // ordinary file bytes, so copy detection would be all noise. Real
    // passwords in this system are far longer.
    if password.len() < 4 {
        return Vec::new();
    }
    // The raw form as written is always searched. When percent-decoding
    // works, the decoded form a file would hold is searched too; when it
    // does not, the raw form still covers the copy.
    let mut forms = vec![password.as_bytes().to_vec()];
    let bytes = password.as_bytes();
    let mut decoded = Vec::with_capacity(password.len());
    let mut valid = true;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok())
                .and_then(|pair| u8::from_str_radix(pair, 16).ok());
            match hex {
                Some(byte) => {
                    decoded.push(byte);
                    i += 3;
                }
                None => {
                    valid = false;
                    break;
                }
            }
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    if valid && decoded != forms[0] {
        forms.push(decoded);
    }
    forms
}

/// Adds one collected value, plus the password split out of it when the
/// value is a connection string, so a bare password copy is searched for too.
fn push_secret(out: &mut Vec<Vec<u8>>, value: &Value) {
    let mut leaves = Vec::new();
    collect_leaves(value, &mut leaves);
    for leaf in &leaves {
        if let Ok(text) = std::str::from_utf8(leaf) {
            out.extend(url_passwords(text));
        }
    }
    out.extend(leaves);
}

fn secret_values(credentials: &[u8]) -> Vec<Vec<u8>> {
    let mut out = vec![credentials.to_vec()];
    if let Ok(value) = serde_json::from_slice::<Value>(credentials) {
        push_secret(&mut out, &value);
    }
    out
}

/// Reads the secret fields of the module settings file without changing it.
/// They move into the wrapped bundle, so no plain copy stays under the root.
fn module_secret_values(instance_root: &Path, secrets: &mut Vec<Vec<u8>>) -> ModuleSecrets {
    let mut found = ModuleSecrets::default();
    let path = instance_root.join("modules.json");
    let Ok(bytes) = fs::read(&path) else {
        return found;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return found;
    };
    let Some(object) = value.as_object() else {
        return found;
    };
    for key in [
        "connector_key",
        "ai_key",
        "producer_url",
        "migrations_url",
        "worker_url",
    ] {
        if let Some(removed) = object.get(key).cloned() {
            push_secret(secrets, &removed);
        }
    }
    if let Some(embeddings) = object.get("embeddings") {
        // Only the key is a secret. The endpoint and model stay plain.
        if let Some(key) = embeddings.get("api_key").cloned() {
            push_secret(secrets, &key);
        }
        found.embeddings_api_key = embeddings
            .get("api_key")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    found.producer_url = text("producer_url");
    found.connector_key = text("connector_key");
    found.ai_key = text("ai_key");
    found.migrations_url = text("migrations_url");
    found.worker_url = text("worker_url");
    found
}

/// Removes the secret fields once the bundle that now holds them is verified.
fn strip_module_secrets(instance_root: &Path) -> Result<(), CustodyError> {
    let path = instance_root.join("modules.json");
    let Ok(bytes) = fs::read(&path) else {
        return Ok(());
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(());
    };
    let Some(object) = value.as_object_mut() else {
        return Ok(());
    };
    let mut changed = false;
    for key in [
        "connector_key",
        "ai_key",
        "producer_url",
        "migrations_url",
        "worker_url",
    ] {
        changed |= object.remove(key).is_some();
    }
    if let Some(embeddings) = object.get_mut("embeddings").and_then(Value::as_object_mut) {
        changed |= embeddings.remove("api_key").is_some();
    }
    if changed {
        write_private(&path, &serde_json::to_vec_pretty(&value).unwrap())?;
    }
    Ok(())
}

#[derive(Default)]
struct ModuleSecrets {
    producer_url: Option<String>,
    connector_key: Option<String>,
    ai_key: Option<String>,
    migrations_url: Option<String>,
    worker_url: Option<String>,
    embeddings_api_key: Option<String>,
}

pub struct Migration {
    pub recovery: RecoveryKey,
    pub bundle_path: PathBuf,
}

/// A verified bundle whose old plaintext file still stands. Commit deletes it.
pub struct Prepared {
    recovery: RecoveryKey,
    bundle_path: PathBuf,
    legacy: PathBuf,
    instance_root: PathBuf,
    settings_original: Option<Vec<u8>>,
    secrets: Vec<Vec<u8>>,
    payload: Vec<u8>,
    database_secrets: std::collections::BTreeMap<String, String>,
    /// The bundle and master this attempt replaced, if an earlier attempt
    /// left one. A rolled-back finish puts them back, not a deletion.
    previous: Option<(Vec<u8>, [u8; 32])>,
}

impl Prepared {
    pub fn words(&self) -> Vec<&'static str> {
        self.recovery.words()
    }
    pub fn recovery_id(&self) -> String {
        self.recovery.id()
    }
    pub fn bundle_path(&self) -> &Path {
        &self.bundle_path
    }
    /// Finishes setup: strips the module settings, checks once more, and only
    /// then deletes the old plaintext file. Call only once the server settings
    /// point at the bundle and, in the desktop app, once the owner has checked
    /// the recovery words. A failure restores the settings file, removes the
    /// new bundle and drops its master from the store.
    pub fn commit_with(
        self,
        store: &mut dyn OsKeyStore,
        service: &str,
    ) -> Result<Migration, CustodyError> {
        // Read both halves back the way a later start will, before anything is
        // deleted. A store that cannot hand its key back stops here, with the
        // plain file still standing.
        let on_disk = read_bundle(&self.instance_root)?;
        let loaded = store.load_master(service)?;
        let opened = unwrap_with_master(&on_disk, &loaded)?;
        // The recovery half is verified too, before the last plain copy goes.
        let recovered = unwrap_with_recovery(&on_disk, &self.recovery)?;
        if opened != self.payload || recovered != self.payload {
            return Err(CustodyError::Damaged(
                "the bundle read back does not hold the credentials".into(),
            ));
        }
        let settings_path = self.instance_root.join("modules.json");
        let finish = (|| -> Result<(), CustodyError> {
            strip_module_secrets(&self.instance_root)?;
            crate::database_secrets::remove(&self.instance_root, &self.database_secrets)?;
            let hits: Vec<PathBuf> = find_plaintext(&self.instance_root, &self.secrets)
                .into_iter()
                .filter(|path| path != &self.legacy)
                .collect();
            if !hits.is_empty() {
                return Err(CustodyError::Damaged(format!(
                    "plaintext remains in {}",
                    hits.iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
            if self.legacy.exists() {
                fs::remove_file(&self.legacy).map_err(|e| CustodyError::Io(e.to_string()))?;
                sync_folder(&self.instance_root);
            }
            Ok(())
        })();
        if let Err(error) = finish {
            // A partial role-file removal must not lose the old database login.
            crate::database_secrets::restore(&self.instance_root, &self.database_secrets)?;
            // Roll the whole attempt back, so the disk matches the retry advice.
            match &self.settings_original {
                Some(bytes) => {
                    let _ = write_private(&settings_path, bytes);
                }
                None => {
                    let _ = fs::remove_file(&settings_path);
                }
            }
            // Put the earlier bundle and master back. They may hold module
            // values recovered from an interrupted attempt; deleting them
            // would lose the only copy.
            match &self.previous {
                Some((bytes, master_bytes)) => {
                    let _ = write_private(&self.bundle_path, bytes);
                    let _ = store.store_master(service, &MasterKey::from_bytes(*master_bytes));
                }
                None => {
                    let _ = fs::remove_file(&self.bundle_path);
                    let _ = store.delete_master(service);
                }
            }
            return Err(error);
        }
        Ok(Migration {
            recovery: self.recovery,
            bundle_path: self.bundle_path,
        })
    }
}

fn prepare(
    instance_root: &Path,
    plaintext: &[u8],
    store: &mut dyn OsKeyStore,
    service: &str,
    leak_plaintext: bool,
) -> Result<Prepared, CustodyError> {
    let legacy = instance_root.join(LEGACY_CREDENTIALS);
    let mut secrets = secret_values(plaintext);
    let module_secrets = module_secret_values(instance_root, &mut secrets);
    // The bundle payload also carries the module AI key, so stripping the
    // settings file later loses nothing.
    let mut payload_value: Value = serde_json::from_slice(plaintext).unwrap_or(Value::Null);
    // A retry after the settings were stripped recovers the AI key from the
    // bundle the failed attempt already verified.
    let recovered_ai = read_bundle(instance_root)
        .ok()
        .and_then(|bundle| {
            store
                .load_master(service)
                .ok()
                .and_then(|master| unwrap_with_master(&bundle, &master).ok())
        })
        .and_then(|payload| serde_json::from_slice::<Value>(&payload).ok())
        .and_then(|value| {
            value
                .get("module_ai_key")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let recovered_module = read_bundle(instance_root)
        .ok()
        .and_then(|bundle| {
            store
                .load_master(service)
                .ok()
                .and_then(|master| unwrap_with_master(&bundle, &master).ok())
        })
        .and_then(|payload| serde_json::from_slice::<Value>(&payload).ok());
    let database_secrets =
        crate::database_secrets::collect(instance_root, recovered_module.as_ref())?;
    for value in database_secrets.values() {
        secrets.push(value.as_bytes().to_vec());
    }
    if !database_secrets.is_empty() {
        let object = payload_value
            .as_object_mut()
            .ok_or_else(|| CustodyError::Damaged("credentials must be an object".into()))?;
        object.insert(
            "database_secrets".into(),
            serde_json::to_value(&database_secrets).unwrap(),
        );
    }
    let recovered_text = |key: &str| {
        recovered_module
            .as_ref()
            .and_then(|value| value.get(key).and_then(Value::as_str).map(str::to_owned))
    };
    // Module values that differ from the credentials file ride along too,
    // so stripping the settings file loses nothing the server used.
    if let Some(object) = payload_value.as_object_mut() {
        let app_url = object
            .get("app_url")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let own_connector = object
            .get("connector_key")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let credential_text = |key: &str| match key {
            "app_url" => app_url.clone(),
            "connector_key" => own_connector.clone(),
            _ => None,
        };
        if let (Some(producer), app) = (&module_secrets.producer_url, credential_text("app_url")) {
            if app.as_deref() != Some(producer.as_str()) {
                object.insert(
                    "module_producer_url".to_string(),
                    Value::String(producer.clone()),
                );
            }
        }
        if let (Some(connector), own) = (
            &module_secrets.connector_key,
            credential_text("connector_key"),
        ) {
            if own.as_deref() != Some(connector.as_str()) {
                object.insert(
                    "module_connector_key".to_string(),
                    Value::String(connector.clone()),
                );
            }
        }
    }
    let module_secrets = ModuleSecrets {
        producer_url: module_secrets
            .producer_url
            .clone()
            .or_else(|| recovered_text("module_producer_url")),
        connector_key: module_secrets
            .connector_key
            .clone()
            .or_else(|| recovered_text("module_connector_key")),
        ai_key: module_secrets
            .ai_key
            .clone()
            .or_else(|| recovered_text("module_ai_key")),
        migrations_url: module_secrets
            .migrations_url
            .clone()
            .or_else(|| recovered_text("module_migrations_url")),
        worker_url: module_secrets
            .worker_url
            .clone()
            .or_else(|| recovered_text("module_worker_url")),
        embeddings_api_key: module_secrets
            .embeddings_api_key
            .clone()
            .or_else(|| recovered_text("module_embeddings_key")),
    };
    let ai_key = module_secrets.ai_key.clone().or(recovered_ai);
    if let Some(object) = payload_value.as_object_mut() {
        if let Some(ai) = &ai_key {
            object.insert("module_ai_key".to_string(), Value::String(ai.clone()));
        }
        if let Some(url) = &module_secrets.migrations_url {
            object.insert(
                "module_migrations_url".to_string(),
                Value::String(url.clone()),
            );
        }
        if let Some(url) = &module_secrets.worker_url {
            object.insert("module_worker_url".to_string(), Value::String(url.clone()));
        }
        if let Some(key) = &module_secrets.embeddings_api_key {
            object.insert(
                "module_embeddings_key".to_string(),
                Value::String(key.clone()),
            );
        }
    }
    let differing_module = payload_value.get("module_producer_url").is_some()
        || payload_value.get("module_connector_key").is_some();
    let payload = if (!database_secrets.is_empty()
        || differing_module
        || ai_key.is_some()
        || module_secrets.migrations_url.is_some()
        || module_secrets.worker_url.is_some()
        || module_secrets.embeddings_api_key.is_some())
        && payload_value.is_object()
    {
        serde_json::to_vec(&payload_value).unwrap()
    } else {
        plaintext.to_vec()
    };
    // The secret list is complete before anything on disk changes, so the
    // plaintext check runs first. A failure here touches nothing at all.
    let stray: Vec<PathBuf> = find_plaintext(instance_root, &secrets)
        .into_iter()
        .filter(|path| {
            path != &legacy
                && path != &instance_root.join("modules.json")
                && !database_secrets
                    .keys()
                    .any(|name| path == &instance_root.join("database/secrets").join(name))
        })
        .collect();
    if !stray.is_empty() {
        return Err(CustodyError::Damaged(format!(
            "plaintext remains in {}",
            stray
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    // Snapshot the bundle and master an earlier interrupted attempt left, so
    // any failure below can put that only copy back instead of deleting it.
    let bundle_path = instance_root.join(BUNDLE_FILE);
    // Do the settings still hold module values themselves? While they do,
    // the earlier bundle is not the only copy of anything, and a retry
    // through any store can safely replace it without opening it.
    let settings_hold_values = module_secrets.ai_key.is_some()
        || module_secrets.connector_key.is_some()
        || module_secrets.migrations_url.is_some()
        || module_secrets.worker_url.is_some()
        || module_secrets.embeddings_api_key.is_some();
    let previous: Option<(Vec<u8>, [u8; 32])> = match fs::read(&bundle_path) {
        Ok(bytes) => {
            let opened = store.load_master(service).ok().and_then(|master| {
                let previous_bundle: Value = serde_json::from_slice(&bytes).ok()?;
                unwrap_with_master(&previous_bundle, &master)
                    .ok()
                    .map(|_| (bytes.clone(), *master.bytes()))
            });
            match opened {
                Some(snapshot) => Some(snapshot),
                None if settings_hold_values && !instance_root.join("database").exists() => None,
                // Stripped settings or partially removed database role files
                // may leave this bundle as the only copy. Without its master,
                // a different store cannot safely replace it.
                None => {
                    return Err(CustodyError::Damaged(
                        "an earlier key bundle cannot be opened, so setup cannot safely continue"
                            .into(),
                    ))
                }
            }
        }
        Err(_) => None,
    };
    let restore_previous = |store: &mut dyn OsKeyStore| match &previous {
        Some((bytes, master_bytes)) => {
            let _ = write_private(&bundle_path, bytes);
            let _ = store.store_master(service, &MasterKey::from_bytes(*master_bytes));
        }
        None => {
            let _ = fs::remove_file(&bundle_path);
            let _ = store.delete_master(service);
        }
    };
    let master = MasterKey::generate();
    let recovery = RecoveryKey::generate();
    let bundle = wrap_bundle(&master, &recovery, &payload);
    write_private(&bundle_path, &serde_json::to_vec_pretty(&bundle).unwrap())?;
    if leak_plaintext {
        // Negative control only. The runner must catch this copy.
        let _ = fs::write(
            instance_root.join("credentials-plaintext-copy.json"),
            &payload,
        );
    }
    // Everything is checked while the old file still stands, so a failure can
    // be retried and loses nothing.
    let opened = unwrap_with_master(&bundle, &master)?;
    if opened != payload {
        restore_previous(store);
        return Err(CustodyError::Damaged(
            "the new bundle does not hold the credentials".into(),
        ));
    }
    // Only now, with the new bundle verified on disk, does its master
    // replace the old one in the store.
    if let Err(error) = store.store_master(service, &master) {
        restore_previous(store);
        return Err(error);
    }
    // The written leak copy, or a copy written since the first check, still
    // fails the attempt, with the earlier bundle and master put back.
    let remaining: Vec<PathBuf> = find_plaintext(instance_root, &secrets)
        .into_iter()
        .filter(|path| {
            path != &legacy
                && path != &instance_root.join("modules.json")
                && !database_secrets
                    .keys()
                    .any(|name| path == &instance_root.join("database/secrets").join(name))
        })
        .collect();
    if !remaining.is_empty() {
        restore_previous(store);
        return Err(CustodyError::Damaged(format!(
            "plaintext remains in {}",
            remaining
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(Prepared {
        recovery,
        bundle_path,
        legacy,
        instance_root: instance_root.to_path_buf(),
        settings_original: fs::read(instance_root.join("modules.json")).ok(),
        secrets,
        payload,
        database_secrets,
        previous,
    })
}

/// One-time migration of a plaintext credentials file into the key store.
/// The plaintext file is removed. No plaintext copy is left under the instance root.
/// `leak_plaintext` exists only as the runner negative control.
pub fn migrate(
    instance_root: &Path,
    store: &mut dyn OsKeyStore,
    service: &str,
    leak_plaintext: bool,
) -> Result<Prepared, CustodyError> {
    let plaintext = fs::read(instance_root.join(LEGACY_CREDENTIALS))
        .map_err(|e| CustodyError::Io(e.to_string()))?;
    prepare(instance_root, &plaintext, store, service, leak_plaintext)
}

/// Sets up a fresh instance. Wraps the credentials text and removes the plaintext file.
pub fn set_up_instance(
    instance_root: &Path,
    credentials: &[u8],
    store: &mut dyn OsKeyStore,
    service: &str,
) -> Result<Prepared, CustodyError> {
    prepare(instance_root, credentials, store, service, false)
}

/// Prepares a fresh instance without deleting the plaintext file yet, so the
/// caller can point the server settings at the bundle first.
pub fn prepare_instance(
    instance_root: &Path,
    store: &mut dyn OsKeyStore,
    service: &str,
) -> Result<Prepared, CustodyError> {
    let plaintext = fs::read(instance_root.join(LEGACY_CREDENTIALS))
        .map_err(|e| CustodyError::Io(e.to_string()))?;
    prepare(instance_root, &plaintext, store, service, false)
}

pub fn read_bundle(instance_root: &Path) -> Result<Value, CustodyError> {
    let bytes = fs::read(instance_root.join(BUNDLE_FILE))
        .map_err(|e| CustodyError::Unavailable(e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|_| CustodyError::Damaged("bundle not readable".into()))
}
