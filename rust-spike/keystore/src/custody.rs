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
            FakeMode::Missing => Err(CustodyError::Unavailable("no key store".into())),
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
            .ok_or_else(|| CustodyError::Unavailable("no master key in the key store".into()))
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

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), CustodyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| CustodyError::Io(e.to_string()))?;
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
            .map_err(|e| CustodyError::Io(e.to_string()))?;
        use std::io::Write;
        file.write_all(bytes)
            .map_err(|e| CustodyError::Io(e.to_string()))?;
        file.sync_all()
            .map_err(|e| CustodyError::Io(e.to_string()))?;
        drop(file);
        fs::rename(&staging, path).map_err(|e| CustodyError::Io(e.to_string()))
    })();
    if written.is_err() {
        let _ = fs::remove_file(&staging);
    }
    written
}

/// Records the owner's headless key-file choice beside the bundle. The file itself
/// lives outside the instance root, where setup chose it.
pub fn record_key_file_choice(instance_root: &Path, key_file: &Path) -> Result<(), CustodyError> {
    let body = json!({ "kind": "moss-key-file-choice", "path": key_file.display().to_string() });
    write_private(
        &instance_root.join("key-file-choice.json"),
        &serde_json::to_vec_pretty(&body).unwrap(),
    )
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
        Ok(())
    }
}

/// Sets up a headless instance whose master key lives in the chosen key file.
/// Records the choice beside the bundle, so a later server start honours only
/// that recorded file.
pub fn set_up_headless(
    instance_root: &Path,
    credentials: &[u8],
    key_file: &Path,
) -> Result<Migration, CustodyError> {
    let mut store = KeyFileStore::new(key_file.to_path_buf());
    let prepared = prepare(instance_root, credentials, &mut store, "headless", false)?;
    record_key_file_choice(instance_root, key_file)?;
    prepared.commit()
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
        Err(error) => {
            if desktop_session {
                SetupRoute::Stop(error)
            } else {
                SetupRoute::KeyFileChoice
            }
        }
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
        Err(CustodyError::Locked) => Err(CustodyError::Locked),
        Err(error) => match key_file {
            Some(path) => read_key_file(path),
            None => Err(error),
        },
    }
}

/// Finds files under `root` that contain any of the secret byte strings.
pub fn find_plaintext(root: &Path, secrets: &[Vec<u8>]) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = fs::read(&path) {
                if secrets.iter().any(|secret| {
                    !secret.is_empty()
                        && bytes.windows(secret.len()).any(|w| w == secret.as_slice())
                }) {
                    hits.push(path);
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

fn secret_values(credentials: &[u8]) -> Vec<Vec<u8>> {
    let mut out = vec![credentials.to_vec()];
    if let Ok(value) = serde_json::from_slice::<Value>(credentials) {
        collect_leaves(&value, &mut out);
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
    for key in ["connector_key", "ai_key", "producer_url"] {
        if let Some(removed) = object.get(key).cloned() {
            collect_leaves(&removed, secrets);
        }
    }
    found.ai_key = object
        .get("ai_key")
        .and_then(Value::as_str)
        .map(str::to_owned);
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
    for key in ["connector_key", "ai_key", "producer_url"] {
        changed |= object.remove(key).is_some();
    }
    if changed {
        write_private(&path, &serde_json::to_vec_pretty(&value).unwrap())?;
    }
    Ok(())
}

#[derive(Default)]
struct ModuleSecrets {
    ai_key: Option<String>,
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
    /// Deletes the old plaintext file. Call only once the server settings
    /// point at the bundle, or when there are no server settings to update.
    pub fn commit(self) -> Result<Migration, CustodyError> {
        if self.legacy.exists() {
            fs::remove_file(&self.legacy).map_err(|e| CustodyError::Io(e.to_string()))?;
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
    let ai_key = module_secrets.ai_key.clone().or(recovered_ai);
    if let (Some(object), Some(ai)) = (payload_value.as_object_mut(), &ai_key) {
        object.insert("module_ai_key".to_string(), Value::String(ai.clone()));
    }
    let payload = if ai_key.is_some() && payload_value.is_object() {
        serde_json::to_vec(&payload_value).unwrap()
    } else {
        plaintext.to_vec()
    };
    let master = MasterKey::generate();
    let recovery = RecoveryKey::generate();
    let bundle = wrap_bundle(&master, &recovery, &payload);
    store.store_master(service, &master)?;
    let bundle_path = instance_root.join(BUNDLE_FILE);
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
        let _ = fs::remove_file(&bundle_path);
        return Err(CustodyError::Damaged(
            "the new bundle does not hold the credentials".into(),
        ));
    }
    let remaining: Vec<PathBuf> = find_plaintext(instance_root, &secrets)
        .into_iter()
        .filter(|path| path != &legacy && path != &instance_root.join("modules.json"))
        .collect();
    if !remaining.is_empty() {
        let _ = fs::remove_file(&bundle_path);
        let _ = store.delete_master(service);
        return Err(CustodyError::Damaged(format!(
            "plaintext remains in {}",
            remaining
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    strip_module_secrets(instance_root)?;
    let after_strip: Vec<PathBuf> = find_plaintext(instance_root, &secrets)
        .into_iter()
        .filter(|path| path != &legacy)
        .collect();
    if !after_strip.is_empty() {
        return Err(CustodyError::Damaged(format!(
            "plaintext remains in {}",
            after_strip
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
) -> Result<Migration, CustodyError> {
    let plaintext = fs::read(instance_root.join(LEGACY_CREDENTIALS))
        .map_err(|e| CustodyError::Io(e.to_string()))?;
    prepare(instance_root, &plaintext, store, service, leak_plaintext)?.commit()
}

/// Sets up a fresh instance. Wraps the credentials text and removes the plaintext file.
pub fn set_up_instance(
    instance_root: &Path,
    credentials: &[u8],
    store: &mut dyn OsKeyStore,
    service: &str,
) -> Result<Migration, CustodyError> {
    prepare(instance_root, credentials, store, service, false)?.commit()
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
