//! The headless key file and the credential-key bundle.
//!
//! - Key file, `$XDG_CONFIG_HOME/moss/keys/recovery-store`: the recovery key, mode 0600 in a
//!   0700 folder, outside the data folder. Moss reads it at start and unlocks with no prompt.
//! - Bundle, `$XDG_DATA_HOME/moss/keys/credential-keys.json`: the credential keys sealed with a
//!   fresh data key, which is sealed with the recovery key. The 24 words open it on any machine.
//! - Test credential, next to the bundle: an envelope in the app's v1 format, made at setup.
//!   Only the original keys open it, so opening it proves the same keys came back.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use portability::secrets::{resolve_keyring, Env, JsonSecretCipher};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::probe::Keychain;
use crate::recovery::RecoveryKey;

const BUNDLE_KIND: &str = "moss-credential-key-bundle";
const KEY_FILE_KIND: &str = "moss-recovery-store";
const ENCODING_VERSION: u64 = 1;
const TEST_CREDENTIAL: &str = "moss-keystore-test-credential-v1";

pub struct Paths {
    pub key_folder: PathBuf,
    pub key_file: PathBuf,
    pub bundle: PathBuf,
    pub test_credential: PathBuf,
}

impl Paths {
    /// The XDG locations a desktop app uses. A relative or empty variable is ignored, as the
    /// XDG rules say.
    pub fn from_env() -> Paths {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let base = |name: &str, fallback: &str| {
            std::env::var_os(name)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| home.join(fallback))
        };
        Paths::under(
            &base("XDG_CONFIG_HOME", ".config"),
            &base("XDG_DATA_HOME", ".local/share"),
        )
    }

    pub fn under(config: &Path, data: &Path) -> Paths {
        let key_folder = config.join("moss/keys");
        let data_keys = data.join("moss/keys");
        Paths {
            key_file: key_folder.join("recovery-store"),
            key_folder,
            bundle: data_keys.join("credential-keys.json"),
            test_credential: data_keys.join("test-credential.json"),
        }
    }
}

/// The secrets behind the app's AI and connector keyrings, as its environment variables hold
/// them today. No `Debug`, so they cannot reach a log line.
pub struct CredentialKeys {
    ai: String,
    connector: String,
}

impl CredentialKeys {
    pub fn generate() -> Self {
        Self {
            ai: hex::encode(rand::random::<[u8; 32]>()),
            connector: hex::encode(rand::random::<[u8; 32]>()),
        }
    }

    /// Eight hex characters that change if either key changes, to compare two sets on screen
    /// without showing either.
    pub fn fingerprint(&self) -> String {
        let digest = Sha256::new()
            .chain_update(b"moss:credential-keys-fingerprint:v1\0")
            .chain_update(&self.ai)
            .chain_update(b"\0")
            .chain_update(&self.connector)
            .finalize();
        hex::encode(&digest[..4])
    }

    /// The app's AI cipher, built from this secret the way `createAiSecretCipher` builds it.
    fn ai_cipher(&self) -> JsonSecretCipher {
        let env: Env = [
            ("NODE_ENV", "production"),
            ("JARVIS_AI_SECRET_KEY", self.ai.as_str()),
            ("JARVIS_AI_SECRET_KEY_ID", "v1"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
        let keyring = resolve_keyring(
            "JARVIS_AI_SECRET_KEY",
            "JARVIS_AI_SECRET_KEY_ID",
            "JARVIS_AI_SECRET_KEYS",
            "",
            &env,
        )
        .expect("a 64-character secret meets the production rules");
        JsonSecretCipher::new(keyring, "AI secret")
    }

    fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(&json!({ "ai": self.ai, "connector": self.connector })).unwrap()
    }

    fn from_json(bytes: &[u8]) -> Option<Self> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        Some(Self {
            ai: value.get("ai")?.as_str()?.to_string(),
            connector: value.get("connector")?.as_str()?.to_string(),
        })
    }
}

pub struct Unlocked {
    pub installation_id: String,
    pub recovery_key_id: String,
    pub keys: CredentialKeys,
}

pub enum State {
    NotSetUp,
    Unlocked(Unlocked),
    /// The bundle is here, but the key file is not.
    KeyFileMissing {
        needs: String,
    },
    KeyFileDamaged {
        needs: String,
        detail: String,
    },
    /// Other accounts could read the key file or its folder.
    KeyFileExposed {
        needs: String,
    },
    /// The key file belongs to another account, or is not a plain file.
    KeyFileNotOurs {
        detail: String,
    },
    /// A sound key file, but for a different recovery key than the bundle needs.
    KeyFileForAnotherKey {
        has: String,
        needs: String,
    },
    BundleMissing,
    BundleDamaged(String),
    /// The bundle opened, but the test credential did not open with its keys.
    KeysDoNotMatch(String),
}

pub enum RecoverError {
    NotThisSetup {
        typed: String,
        needs: String,
    },
    /// The bundle is missing or damaged, or its keys do not open the test credential.
    Unrecoverable(State),
    Io(String),
}

struct Bundle {
    header_text: String,
    installation_id: String,
    recovery_key_id: String,
    data_key: Value,
    payload: Value,
}

fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// Seals one bundle part. Both parts carry the exact header text as authenticated data, so a
/// part cannot be moved to another bundle. They use different keys, so a swap fails as well.
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
    let field = |name: &str| STANDARD.decode(sealed.get(name)?.as_str()?).ok();
    let nonce = field("nonce").filter(|nonce| nonce.len() == 12)?;
    let sealed = field("sealed")?;
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &sealed, aad })
        .ok()
}

fn read_bundle(paths: &Paths) -> Result<Option<Bundle>, String> {
    let bytes = match fs::read(&paths.bundle) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let outer: Value = serde_json::from_slice(&bytes).map_err(|_| "not readable".to_string())?;
    let header_text = outer
        .get("header")
        .and_then(Value::as_str)
        .ok_or("no header")?
        .to_string();
    let header: Value = serde_json::from_str(&header_text).map_err(|_| "header not readable")?;
    let text = |name: &str| header.get(name).and_then(Value::as_str).map(str::to_string);
    if text("kind").as_deref() != Some(BUNDLE_KIND)
        || header.get("encodingVersion").and_then(Value::as_u64) != Some(ENCODING_VERSION)
    {
        return Err("unknown kind or version".to_string());
    }
    Ok(Some(Bundle {
        installation_id: text("installationId").ok_or("no installation id")?,
        recovery_key_id: text("recoveryKeyId").ok_or("no recovery key id")?,
        data_key: outer.get("dataKey").cloned().ok_or("no data key")?,
        payload: outer.get("payload").cloned().ok_or("no payload")?,
        header_text,
    }))
}

fn open_bundle(bundle: &Bundle, recovery: &RecoveryKey) -> Option<CredentialKeys> {
    let data_key: [u8; 32] = unseal(
        recovery.bytes(),
        bundle.header_text.as_bytes(),
        &bundle.data_key,
    )?
    .try_into()
    .ok()?;
    let payload = unseal(&data_key, bundle.header_text.as_bytes(), &bundle.payload)?;
    CredentialKeys::from_json(&payload)
}

fn test_credential_opens(
    paths: &Paths,
    keys: &CredentialKeys,
    installation_id: &str,
) -> Result<(), String> {
    let text = fs::read_to_string(&paths.test_credential).map_err(|error| error.to_string())?;
    let envelope: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let cipher = keys.ai_cipher();
    let opened = cipher
        .parse_envelope(&envelope)
        .and_then(|envelope| cipher.decrypt_json(&envelope))?;
    let expected =
        |name: &str, want: &str| opened.value.get(name).and_then(Value::as_str) == Some(want);
    if expected("check", TEST_CREDENTIAL) && expected("installationId", installation_id) {
        Ok(())
    } else {
        Err("it opened but holds something else".to_string())
    }
}

/// Writes a file only this account can read, replacing any old one in a single step.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let folder = path.parent().expect("files live in a folder");
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(folder)?;
    let staging = path.with_extension("staging");
    let _ = fs::remove_file(&staging);
    let staged = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staging)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&staging, path)
    })();
    if staged.is_err() {
        let _ = fs::remove_file(&staging);
    }
    staged?;
    File::open(folder)?.sync_all()
}

/// An existing key folder is made private first. A link or plain file in its place is refused.
fn write_key_file(
    paths: &Paths,
    recovery: &RecoveryKey,
    installation_id: &str,
) -> std::io::Result<()> {
    if fs::symlink_metadata(&paths.key_folder).is_ok() {
        make_private(&paths.key_folder, 0o700, true)
            .map_err(|detail| std::io::Error::other(format!("key folder: {detail}")))?;
    }
    let contents = json!({
        "kind": KEY_FILE_KIND,
        "encodingVersion": ENCODING_VERSION,
        "installationId": installation_id,
        "recoveryKeyId": recovery.id(),
        "recoveryKey": STANDARD.encode(recovery.bytes()),
    });
    write_private(
        &paths.key_file,
        &serde_json::to_vec_pretty(&contents).unwrap(),
    )
}

/// Creates the test credential, the bundle and the key file, in that order. A crash before
/// the bundle leaves nothing that blocks a new setup. A crash before the key file leaves a
/// setup the owner's words can open. A failed write removes every file this setup wrote.
/// The caller probes the keychain just before; the file is refused unless that probe allows it.
pub fn set_up(
    paths: &Paths,
    keychain: &Keychain,
    recovery: &RecoveryKey,
    keys: &CredentialKeys,
) -> Result<(), String> {
    if !keychain.allows_key_file() {
        return Err(format!(
            "this computer has a keychain, so the key file is not used ({keychain:?})"
        ));
    }
    // A key file without its bundle may still match a bundle in a backup, so it is never replaced.
    if fs::symlink_metadata(&paths.bundle).is_ok() || fs::symlink_metadata(&paths.key_file).is_ok()
    {
        return Err("Moss is already set up on this computer".to_string());
    }
    let installation_id = hex::encode(rand::random::<[u8; 16]>());
    let header_text = serde_json::to_string(&json!({
        "kind": BUNDLE_KIND,
        "encodingVersion": ENCODING_VERSION,
        "installationId": installation_id,
        "bundleId": hex::encode(rand::random::<[u8; 16]>()),
        "recoveryKeyId": recovery.id(),
        "keyStore": "key-file",
    }))
    .unwrap();
    let data_key: [u8; 32] = rand::random();
    let bundle = json!({
        "header": header_text,
        "dataKey": seal(recovery.bytes(), header_text.as_bytes(), &data_key),
        "payload": seal(&data_key, header_text.as_bytes(), &keys.to_json()),
    });
    let mut check = Map::new();
    check.insert("check".to_string(), json!(TEST_CREDENTIAL));
    check.insert("installationId".to_string(), json!(installation_id));
    let test_credential = keys.ai_cipher().encrypt_json(&check);

    let written = write_private(
        &paths.test_credential,
        &serde_json::to_vec_pretty(&test_credential).unwrap(),
    )
    .and_then(|()| write_private(&paths.bundle, &serde_json::to_vec_pretty(&bundle).unwrap()))
    .and_then(|()| write_key_file(paths, recovery, &installation_id));
    written.map_err(|error| {
        for path in [&paths.key_file, &paths.bundle, &paths.test_credential] {
            let _ = fs::remove_file(path);
        }
        error.to_string()
    })
}

/// Where things stand, read fresh from disk.
pub fn status(paths: &Paths) -> State {
    let bundle = match read_bundle(paths) {
        Ok(Some(bundle)) => bundle,
        Ok(None) if fs::symlink_metadata(&paths.key_file).is_ok() => return State::BundleMissing,
        Ok(None) => return State::NotSetUp,
        Err(detail) => return State::BundleDamaged(detail),
    };
    let needs = bundle.recovery_key_id.clone();
    let file = match fs::symlink_metadata(&paths.key_file) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return State::KeyFileMissing { needs }
        }
        Err(error) => {
            return State::KeyFileDamaged {
                needs,
                detail: error.to_string(),
            }
        }
    };
    let folder = fs::symlink_metadata(&paths.key_folder);
    if !file.file_type().is_file() || file.uid() != current_uid() {
        return State::KeyFileNotOurs {
            detail: "not a plain file owned by this account".to_string(),
        };
    }
    match folder {
        Ok(folder) if folder.is_dir() && folder.uid() == current_uid() => {
            if folder.mode() & 0o077 != 0 || file.mode() & 0o077 != 0 {
                return State::KeyFileExposed { needs };
            }
        }
        _ => {
            return State::KeyFileNotOurs {
                detail: "its folder is not owned by this account".to_string(),
            }
        }
    }

    let recovery = match read_key_file(paths) {
        Ok(recovery) => recovery,
        Err(detail) => return State::KeyFileDamaged { needs, detail },
    };
    if recovery.0 != bundle.installation_id || recovery.1.id() != needs {
        return State::KeyFileForAnotherKey {
            has: recovery.1.id(),
            needs,
        };
    }
    unlock(paths, &bundle, &recovery.1).unwrap_or_else(|state| state)
}

fn read_key_file(paths: &Paths) -> Result<(String, RecoveryKey), String> {
    let bytes = fs::read(&paths.key_file).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "not readable".to_string())?;
    let text = |name: &str| value.get(name).and_then(Value::as_str);
    if text("kind") != Some(KEY_FILE_KIND)
        || value.get("encodingVersion").and_then(Value::as_u64) != Some(ENCODING_VERSION)
    {
        return Err("unknown kind or version".to_string());
    }
    let key: [u8; 32] = text("recoveryKey")
        .and_then(|key| STANDARD.decode(key).ok())
        .and_then(|key| key.try_into().ok())
        .ok_or("no readable key")?;
    let recovery = RecoveryKey::from_bytes(key);
    // The stored name must match the key, which catches a key changed by damage.
    if text("recoveryKeyId") != Some(recovery.id().as_str()) {
        return Err("the key does not match its name".to_string());
    }
    let installation_id = text("installationId")
        .ok_or("no installation id")?
        .to_string();
    Ok((installation_id, recovery))
}

fn unlock(paths: &Paths, bundle: &Bundle, recovery: &RecoveryKey) -> Result<State, State> {
    let keys = open_bundle(bundle, recovery)
        .ok_or_else(|| State::BundleDamaged("it failed its safety check".to_string()))?;
    test_credential_opens(paths, &keys, &bundle.installation_id).map_err(State::KeysDoNotMatch)?;
    Ok(State::Unlocked(Unlocked {
        installation_id: bundle.installation_id.clone(),
        recovery_key_id: bundle.recovery_key_id.clone(),
        keys,
    }))
}

/// Opens the bundle with the owner's words and writes a fresh key file. A damaged key file is
/// kept beside the new one, private, rather than deleted.
pub fn recover(paths: &Paths, recovery: &RecoveryKey) -> Result<Unlocked, RecoverError> {
    let bundle = match read_bundle(paths) {
        Ok(Some(bundle)) => bundle,
        Ok(None) => return Err(RecoverError::Unrecoverable(State::BundleMissing)),
        Err(detail) => return Err(RecoverError::Unrecoverable(State::BundleDamaged(detail))),
    };
    if recovery.id() != bundle.recovery_key_id {
        return Err(RecoverError::NotThisSetup {
            typed: recovery.id(),
            needs: bundle.recovery_key_id,
        });
    }
    let unlocked = match unlock(paths, &bundle, recovery) {
        Ok(State::Unlocked(unlocked)) => unlocked,
        Ok(other) | Err(other) => return Err(RecoverError::Unrecoverable(other)),
    };
    if fs::symlink_metadata(&paths.key_folder).is_ok() {
        make_private(&paths.key_folder, 0o700, true)
            .map_err(|detail| RecoverError::Io(format!("key folder: {detail}")))?;
    }
    if fs::symlink_metadata(&paths.key_file).is_ok() {
        let aside =
            move_aside(&paths.key_file).map_err(|error| RecoverError::Io(error.to_string()))?;
        let _ = fs::set_permissions(&aside, fs::Permissions::from_mode(0o600));
    }
    write_key_file(paths, recovery, &unlocked.installation_id)
        .map_err(|error| RecoverError::Io(error.to_string()))?;
    Ok(unlocked)
}

/// Makes the key folder and file private to this account again.
pub fn secure(paths: &Paths) -> Result<(), String> {
    make_private(&paths.key_folder, 0o700, true)?;
    make_private(&paths.key_file, 0o600, false)
}

/// The owner check and the change act on the opened path. A link is refused when it is
/// opened, so a path swapped for a link after the check cannot redirect the change, and a
/// pipe in its place cannot block the open.
fn make_private(path: &Path, mode: u32, folder: bool) -> Result<(), String> {
    let opened = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| error.to_string())?;
    let metadata = opened.metadata().map_err(|error| error.to_string())?;
    if metadata.uid() != current_uid() {
        return Err("it belongs to another account".to_string());
    }
    if folder != metadata.is_dir() || !(folder || metadata.is_file()) {
        return Err(format!(
            "it is not a {}",
            if folder { "folder" } else { "plain file" }
        ));
    }
    opened
        .set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|error| error.to_string())
}

/// Moves a file to an unused `replaced-<seconds>-<n>` name. Linking fails rather than
/// replace an earlier kept file.
fn move_aside(path: &Path) -> std::io::Result<PathBuf> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|t| t.as_secs())
        .unwrap_or(0);
    let mut n = 0;
    loop {
        let aside = path.with_extension(format!("replaced-{stamp}-{n}"));
        match fs::hard_link(path, &aside) {
            Ok(()) => break fs::remove_file(path).map(|()| aside),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => n += 1,
            Err(error) => break Err(error),
        }
    }
}
