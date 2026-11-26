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
    fs::write(path, bytes).map_err(|e| CustodyError::Io(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
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

fn secret_values(credentials: &[u8]) -> Vec<Vec<u8>> {
    let Ok(value) = serde_json::from_slice::<Value>(credentials) else {
        return vec![credentials.to_vec()];
    };
    let mut out = Vec::new();
    if let Some(object) = value.as_object() {
        for value in object.values() {
            if let Some(text) = value.as_str() {
                if text.len() >= 8 {
                    out.push(text.as_bytes().to_vec());
                }
            }
        }
    }
    if out.is_empty() {
        out.push(credentials.to_vec());
    }
    out
}

pub struct Migration {
    pub recovery: RecoveryKey,
    pub bundle_path: PathBuf,
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
    let legacy = instance_root.join(LEGACY_CREDENTIALS);
    let plaintext = fs::read(&legacy).map_err(|e| CustodyError::Io(e.to_string()))?;
    let secrets = secret_values(&plaintext);
    let master = MasterKey::generate();
    let recovery = RecoveryKey::generate();
    let bundle = wrap_bundle(&master, &recovery, &plaintext);
    store.store_master(service, &master)?;
    let bundle_path = instance_root.join(BUNDLE_FILE);
    write_private(&bundle_path, &serde_json::to_vec_pretty(&bundle).unwrap())?;
    if leak_plaintext {
        // Negative control only. The runner must catch this copy.
        let _ = fs::write(
            instance_root.join("credentials-plaintext-copy.json"),
            &plaintext,
        );
    }
    fs::remove_file(&legacy).map_err(|e| CustodyError::Io(e.to_string()))?;
    let hits = find_plaintext(instance_root, &secrets);
    if !hits.is_empty() {
        return Err(CustodyError::Damaged(format!(
            "plaintext remains in {}",
            hits.iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    Ok(Migration {
        recovery,
        bundle_path,
    })
}

/// Sets up a fresh instance. Wraps the credentials text and removes the plaintext file.
pub fn set_up_instance(
    instance_root: &Path,
    credentials: &[u8],
    store: &mut dyn OsKeyStore,
    service: &str,
) -> Result<Migration, CustodyError> {
    let secrets = secret_values(credentials);
    let master = MasterKey::generate();
    let recovery = RecoveryKey::generate();
    let bundle = wrap_bundle(&master, &recovery, credentials);
    store.store_master(service, &master)?;
    let bundle_path = instance_root.join(BUNDLE_FILE);
    write_private(&bundle_path, &serde_json::to_vec_pretty(&bundle).unwrap())?;
    let legacy = instance_root.join(LEGACY_CREDENTIALS);
    if legacy.exists() {
        fs::remove_file(&legacy).map_err(|e| CustodyError::Io(e.to_string()))?;
    }
    if !find_plaintext(instance_root, &secrets).is_empty() {
        return Err(CustodyError::Damaged(
            "plaintext remains after setup".into(),
        ));
    }
    Ok(Migration {
        recovery,
        bundle_path,
    })
}

pub fn read_bundle(instance_root: &Path) -> Result<Value, CustodyError> {
    let bytes = fs::read(instance_root.join(BUNDLE_FILE))
        .map_err(|e| CustodyError::Unavailable(e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|_| CustodyError::Damaged("bundle not readable".into()))
}
