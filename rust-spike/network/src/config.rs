use crate::policy::Policy;
use safety_core::{
    auth::SessionCookies,
    db::{Database, RuntimeRole},
    http::Platform,
    origin::TrustedOrigins,
    secret::SecretCipher,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub listen: SocketAddr,
    pub origins: Vec<String>,
    #[serde(default)]
    pub sharing: bool,
    pub certificate: PathBuf,
    pub private_key: PathBuf,
    pub credentials: PathBuf,
}

impl Config {
    pub fn read(path: &Path) -> Result<Self, String> {
        let bytes = private_read(path)?;
        let config: Self =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid network configuration")?;
        config.policy()?;
        Ok(config)
    }

    pub fn local_origin(&self) -> Option<&str> {
        self.origins
            .iter()
            .find(|origin| {
                url::Url::parse(origin)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
                    .is_some_and(|host| {
                        host == "localhost"
                            || host
                                .trim_matches(['[', ']'])
                                .parse::<std::net::IpAddr>()
                                .is_ok_and(crate::policy::loopback)
                    })
            })
            .map(String::as_str)
    }

    pub fn policy(&self) -> Result<Policy, String> {
        let origins: Vec<&str> = self.origins.iter().map(String::as_str).collect();
        let policy = Policy::new(&origins, self.sharing).map_err(str::to_owned)?;
        // Binding all interfaces lets the switch take effect without restarting. Every
        // request is still checked, including existing keep-alive connections.
        if self.listen.ip().is_multicast() {
            return Err("A multicast listener is not supported".into());
        }
        if !self.origins.iter().any(|origin| {
            let h: axum::http::HeaderMap = [(
                axum::http::header::HOST,
                origin.trim_start_matches("https://").parse().unwrap(),
            )]
            .into_iter()
            .collect();
            policy.local_authority(&h)
        }) {
            return Err("Keep a loopback origin for local owner setup and recovery".into());
        }
        if self.origins.iter().any(|o| {
            url::Url::parse(o)
                .ok()
                .and_then(|u| u.port_or_known_default())
                != Some(self.listen.port())
        }) {
            return Err("Every trusted origin must use the listener's port".into());
        }
        Ok(policy)
    }

    pub fn write(&self, path: &Path) -> Result<(), String> {
        let bytes =
            serde_json::to_vec_pretty(self).map_err(|_| "Cannot encode network configuration")?;
        private_write(path, &bytes)
    }

    pub async fn platform(&self) -> Result<Arc<Platform>, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Credentials {
            app_url: String,
            auth_url: String,
            auth_secret: String,
            connector_key: String,
        }
        let raw = private_read(&self.credentials)?;
        // A wrapped key bundle holds the same credentials with no plaintext. A locked
        // key store refuses to start with that reason.
        let plain: Vec<u8> = if is_bundle(&raw) {
            let instance = self
                .credentials
                .parent()
                .and_then(|f| f.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "default".into());
            let root = self
                .credentials
                .parent()
                .map(|f| f.to_path_buf())
                .unwrap_or_default();
            // Only a key file the owner recorded at setup counts. An environment
            // setting on its own never unlocks a desktop server from a plain file.
            let recorded = keystore::custody::recorded_key_file(&root);
            let env_path = std::env::var_os("MOSS_KEY_FILE").map(std::path::PathBuf::from);
            let key_file = match (&recorded, &env_path) {
                (Some(recorded), Some(env)) if recorded == env => Some(recorded.clone()),
                (Some(recorded), None) => Some(recorded.clone()),
                _ => None,
            };
            let store = keystore::platform::platform_store();
            open_bundle_credentials(
                &raw,
                store.as_ref(),
                &keystore::platform::service_name(&instance),
                key_file.as_deref(),
            )?
        } else {
            raw
        };
        let c: Credentials =
            serde_json::from_slice(&plain).map_err(|_| "Invalid credential file")?;
        if c.auth_secret.len() < 32 {
            return Err("The session signing secret needs at least thirty-two characters".into());
        }
        let mut env = std::collections::HashMap::new();
        env.insert("BETTER_AUTH_SECRET".into(), c.auth_secret);
        // Select Secure cookies for native TLS; no proxy headers are trusted.
        env.insert("JARVIS_TRUST_PROXY".into(), "loopback".into());
        env.insert("JARVIS_CONNECTOR_SECRET_KEY".into(), c.connector_key);
        env.insert("JARVIS_AUTH_BASE_URL".into(), self.origins[0].clone());
        env.insert("JARVIS_AUTH_TRUSTED_ORIGINS".into(), self.origins.join(","));
        let app = Database::connect(&c.app_url, 8, RuntimeRole::App)
            .await
            .map_err(|_| "Cannot connect using the app runtime role")?;
        let auth = Database::connect(&c.auth_url, 4, RuntimeRole::Auth)
            .await
            .map_err(|_| "Cannot connect using the auth runtime role")?;
        Ok(Arc::new(Platform {
            app,
            auth,
            sessions: SessionCookies::from_env(&env)?,
            connectors: SecretCipher::connectors(&env).map_err(|_| "Invalid connector key")?,
            origins: TrustedOrigins::from_env(&env, self.listen.port())?,
        }))
    }
}

/// These files live outside exports and must have owner-only permissions on Unix.
pub fn private_read(path: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Cannot read a required private file")?;
    if !meta.is_file() || meta.len() > 1_048_576 {
        return Err("Expected a regular private file under one megabyte".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err("Private files need owner-only permissions".into());
        }
    }
    fs::read(path).map_err(|_| "Cannot read a required private file".into())
}

pub fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("A private file needs a parent folder")?;
    let tmp = parent.join(format!(".moss-{}.tmp", uuid::Uuid::new_v4()));
    let mut keep_tmp = false;
    let result: Result<(), String> = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|_| "Cannot create private configuration".to_owned())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot save private configuration".to_owned())?;
        // Windows refuses to rename a file that is still open.
        drop(file);
        // A scanner or indexer can hold the new file for a moment on Windows.
        let mut tries = 0;
        loop {
            match fs::rename(&tmp, path) {
                Ok(()) => break Ok(()),
                Err(e) if cfg!(windows) && tries < 20 => {
                    tries += 1;
                    let _ = e;
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                // Windows can keep refusing to replace a file a scanner holds. Write in place,
                // and keep the complete temporary copy if that write fails.
                Err(e) if cfg!(windows) => {
                    break fs::write(path, bytes).map_err(|w| {
                        keep_tmp = true;
                        format!("Cannot replace private configuration ({e}; {w})")
                    });
                }
                Err(e) => break Err(format!("Cannot replace private configuration ({e})")),
            }
        }
    })();
    // Also covers the in-place fallback, which leaves the temporary copy behind.
    if !keep_tmp {
        let _ = fs::remove_file(tmp);
    }
    result
}

/// Whether these bytes are a wrapped key custody bundle, read from its own header.
pub fn is_bundle(raw: &[u8]) -> bool {
    let Ok(bundle) = serde_json::from_slice::<serde_json::Value>(raw) else {
        return false;
    };
    let Some(header) = bundle.get("header").and_then(serde_json::Value::as_str) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(header)
        .map(|header| {
            header.get("kind").and_then(serde_json::Value::as_str)
                == Some("moss-key-custody-bundle")
        })
        .unwrap_or(false)
}

/// Opens wrapped bundle credentials with a key store. A locked store refuses.
pub fn open_bundle_credentials(
    raw: &[u8],
    store: &dyn keystore::custody::OsKeyStore,
    service: &str,
    key_file: Option<&Path>,
) -> Result<Vec<u8>, String> {
    let bundle: serde_json::Value =
        serde_json::from_slice(raw).map_err(|_| "Invalid credential file")?;
    let master = keystore::custody::load_master(store, service, key_file)
        .map_err(|e| format!("{}: {}", e.code(), e.reason()))?;
    keystore::custody::unwrap_with_master(&bundle, &master)
        .map_err(|e| format!("{}: {}", e.code(), e.reason()))
}

impl Config {
    /// The module secrets from the credentials, opening a wrapped bundle if
    /// present: connector key, module AI key if any, and the app address that
    /// the module settings used to repeat as their producer address.
    pub fn module_secrets(&self) -> Result<(String, Option<String>, String), String> {
        #[derive(Deserialize)]
        struct OnlyKeys {
            connector_key: String,
            #[serde(default)]
            module_ai_key: Option<String>,
            app_url: String,
        }
        let raw = private_read(&self.credentials)?;
        let plain = if is_bundle(&raw) {
            let instance = self
                .credentials
                .parent()
                .and_then(|f| f.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "default".into());
            let root = self
                .credentials
                .parent()
                .map(|f| f.to_path_buf())
                .unwrap_or_default();
            let key_file = keystore::custody::recorded_key_file(&root);
            let store = keystore::platform::platform_store();
            open_bundle_credentials(
                &raw,
                store.as_ref(),
                &keystore::platform::service_name(&instance),
                key_file.as_deref(),
            )?
        } else {
            raw
        };
        let parsed: OnlyKeys =
            serde_json::from_slice(&plain).map_err(|_| "Invalid credential file")?;
        Ok((parsed.connector_key, parsed.module_ai_key, parsed.app_url))
    }

    /// The connector key from the credentials, opening a wrapped bundle if present.
    pub fn connector_key(&self) -> Result<String, String> {
        Ok(self.module_secrets()?.0)
    }
}

#[cfg(test)]
mod custody_tests {
    use super::*;
    use keystore::custody::{wrap_bundle, FakeMode, MasterKey, MemoryStore, OsKeyStore};
    use keystore::recovery::RecoveryKey;

    #[test]
    fn bundle_is_recognised_and_locked_store_refuses() {
        let creds = br#"{"app_url":"x","auth_url":"y","auth_secret":"z","connector_key":"k"}"#;
        assert!(!is_bundle(creds));
        let master = MasterKey::generate();
        let bundle = wrap_bundle(&master, &RecoveryKey::generate(), creds);
        let raw = serde_json::to_vec(&bundle).unwrap();
        assert!(is_bundle(&raw));
        let mut store = MemoryStore::new(FakeMode::Working);
        store.store_master("svc", &master).unwrap();
        assert_eq!(
            open_bundle_credentials(&raw, &store, "svc", None).unwrap(),
            creds
        );
        let locked = MemoryStore::new(FakeMode::Locked);
        let error = open_bundle_credentials(&raw, &locked, "svc", None).unwrap_err();
        assert!(error.starts_with("app_keystore_locked"), "{error}");
    }
}
