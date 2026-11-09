//! Where the app keeps its server list, certificate pins and per-server web profiles.

use moss_network::config::{private_read, private_write};
use moss_network::instance::NETWORK_FILE;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const LOCAL_PREFIX: &str = "local:";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remote {
    pub id: String,
    pub name: String,
    pub origin: String,
    /// Leaf certificate fingerprint the user confirmed against the Sharing screen.
    pub pin: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Servers {
    /// Absent until the user makes the first-run choice.
    pub last: Option<String>,
    pub remotes: Vec<Remote>,
}

/// A saved or discovered server, by what the app needs to reach it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Local { instance: String, folder: PathBuf },
    Remote(Remote),
}

impl Target {
    pub fn id(&self) -> String {
        match self {
            Target::Local { instance, .. } => format!("{LOCAL_PREFIX}{instance}"),
            Target::Remote(r) => r.id.clone(),
        }
    }

    pub fn name(&self) -> String {
        match self {
            Target::Local { instance, .. } if instance == "default" => "This computer".into(),
            Target::Local { instance, .. } => format!("This computer ({instance})"),
            Target::Remote(r) => r.name.clone(),
        }
    }
}

pub struct Store {
    pub data: PathBuf,
}

impl Store {
    pub fn new(data: PathBuf) -> Self {
        Self { data }
    }

    fn app_dir(&self) -> PathBuf {
        self.data.join("app")
    }

    pub fn servers_dir(&self) -> PathBuf {
        self.data.join("servers")
    }

    pub fn instance_folder(&self, instance: &str) -> PathBuf {
        self.servers_dir().join(instance)
    }

    pub fn load(&self) -> Result<Servers, String> {
        let path = self.app_dir().join("servers.json");
        if !path.exists() {
            return Ok(Servers::default());
        }
        serde_json::from_slice(&private_read(&path)?).map_err(|_| "Invalid server list".into())
    }

    pub fn save(&self, servers: &Servers) -> Result<(), String> {
        private_dir(&self.data)?;
        private_dir(&self.app_dir())?;
        let bytes = serde_json::to_vec_pretty(servers).map_err(|_| "Cannot encode server list")?;
        private_write(&self.app_dir().join("servers.json"), &bytes)
    }

    /// Local instances are found on disk; remote servers come from the saved list.
    pub fn targets(&self, servers: &Servers) -> Vec<Target> {
        let mut locals: Vec<Target> = std::fs::read_dir(self.servers_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().join(NETWORK_FILE).is_file())
            .filter_map(|e| {
                let instance = e.file_name().to_str()?.to_owned();
                valid_instance(&instance).then(|| Target::Local {
                    folder: e.path(),
                    instance,
                })
            })
            .collect();
        locals.sort_by_key(|t| t.id());
        locals.extend(servers.remotes.iter().cloned().map(Target::Remote));
        locals
    }

    pub fn find(&self, servers: &Servers, id: &str) -> Option<Target> {
        if let Some(instance) = id.strip_prefix(LOCAL_PREFIX) {
            return valid_instance(instance).then(|| Target::Local {
                instance: instance.to_owned(),
                folder: self.instance_folder(instance),
            });
        }
        servers
            .remotes
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .map(Target::Remote)
    }

    /// One web profile per server, so sessions on two servers never share a cookie jar.
    pub fn profile(&self, id: &str) -> Result<PathBuf, String> {
        let name: String = id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let profiles = self.app_dir().join("profiles");
        private_dir(&self.data)?;
        private_dir(&self.app_dir())?;
        private_dir(&profiles)?;
        let dir = profiles.join(name);
        private_dir(&dir)?;
        Ok(dir)
    }

    pub fn remove_profile(&self, id: &str) {
        if let Ok(dir) = self.profile(id) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

pub fn local_id(instance: &str) -> String {
    format!("{LOCAL_PREFIX}{instance}")
}

fn valid_instance(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Creates a folder only its owner can enter, or checks an existing one is a real folder.
pub fn private_dir(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err("Expected a private folder".into()),
        Err(_) => {
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(path)
                .map_err(|_| "Cannot create a private folder".into())
        }
    }
}

/// `$XDG_DATA_HOME/moss`, else `~/.local/share/moss`. macOS and Windows follow in Phase 7.
pub fn default_data_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(xdg).join("moss"));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/moss"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("moss-app-store-{}", uuid::Uuid::new_v4()));
        private_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn list_round_trips_owner_only_and_finds_local_instances() {
        let dir = scratch();
        let store = Store::new(dir.clone());
        assert_eq!(store.load().unwrap(), Servers::default());
        let remote = Remote {
            id: "r1".into(),
            name: "192.168.1.20".into(),
            origin: "https://192.168.1.20:5201".into(),
            pin: "AB".into(),
        };
        let servers = Servers {
            last: Some(remote.id.clone()),
            remotes: vec![remote.clone()],
        };
        store.save(&servers).unwrap();
        assert_eq!(store.load().unwrap(), servers);

        private_dir(&store.servers_dir()).unwrap();
        for name in ["default", "bad name", "spare"] {
            let folder = store.instance_folder(name);
            private_dir(&folder).unwrap();
            if name != "spare" {
                std::fs::write(folder.join(NETWORK_FILE), b"{}").unwrap();
            }
        }
        let ids: Vec<_> = store.targets(&servers).iter().map(Target::id).collect();
        assert_eq!(ids, ["local:default", "r1"]);
        assert_eq!(store.find(&servers, "local:../x"), None);
        assert_eq!(store.find(&servers, "r1"), Some(Target::Remote(remote)));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let profile = store.profile("local:default").unwrap();
            assert!(profile.ends_with("local_default"));
            let mode = std::fs::metadata(profile).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
