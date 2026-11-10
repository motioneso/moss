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
        let c: Credentials = serde_json::from_slice(&private_read(&self.credentials)?)
            .map_err(|_| "Invalid credential file")?;
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
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .map_err(|_| "Cannot create private configuration")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot save private configuration")?;
        // Windows refuses to rename a file that is still open.
        drop(file);
        fs::rename(&tmp, path).map_err(|_| "Cannot replace private configuration")
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result.map_err(str::to_owned)
}
