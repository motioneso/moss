//! M5 new-computer restore. Part 10 calls `Flow::new` via the `restore` shell action.
use moss_backup::restore::Failure;
use moss_network::config::{private_write, Config};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Flow {
    pub destination: PathBuf,
    install: PathBuf,
    selected: Option<PathBuf>,
    facts: Value,
}
impl Flow {
    pub fn new(data: &Path, install: &Path) -> Self {
        let data = std::path::absolute(data).unwrap_or_else(|_| data.into());
        Self {
            destination: data
                .join("servers")
                .join(format!("restored-{}", uuid::Uuid::new_v4().simple())),
            install: std::path::absolute(install).unwrap_or_else(|_| install.into()),
            selected: None,
            facts: Value::Null,
        }
    }
    pub fn state(&self) -> Value {
        json!({"screen": "restore", "facts": self.facts, "destination": self.destination})
    }
    pub fn select(&mut self, path: PathBuf) -> Value {
        self.selected = None;
        self.facts = Value::Null;
        match moss_backup::restore::inspect(&path) {
            Ok(facts) => {
                self.facts = facts;
                self.selected = Some(path);
                self.state()
            }
            Err(error) => self.problem(error),
        }
    }
    pub fn problem(&self, error: Failure) -> Value {
        let mut state = self.state();
        state["code"] = json!(error.code());
        state["error"] = json!(error.reason());
        state
    }
    pub fn run(&self, words: &[String], event: impl Fn(&str)) -> Value {
        let Some(path) = self.selected.as_ref() else {
            return self.problem(Failure::Damaged);
        };
        let parent = self.destination.parent().unwrap();
        if crate::store::private_dir(parent.parent().unwrap())
            .and_then(|_| crate::store::private_dir(parent))
            .is_err()
        {
            return self.problem(Failure::Destination);
        }
        let bundle = match bundled_db::cluster::Bundle::new(&self.install.join("postgres")) {
            Ok(bundle) => bundle,
            Err(_) => return self.problem(Failure::Restore),
        };
        match moss_backup::restore::restore(
            path,
            words,
            &self.destination,
            &bundle,
            |stage, credentials| self.prepare(stage, credentials),
            event,
        ) {
            Ok(report) => json!({"screen": "restore-done", "destination": self.destination,
                "id": format!("local:{}", self.destination.file_name().unwrap().to_string_lossy()),
                "files": report.files, "rows": report.rows}),
            Err(error) => self.problem(error),
        }
    }
    fn prepare(&self, stage: &Path, credentials: &mut Value) -> Result<(), String> {
        let old = Config::read(&stage.join("network.json"))?;
        let old_root = old.credentials.parent().ok_or("missing old root")?;
        // Rebase instance-owned module paths. External linked folders keep their identity.
        let module_path = stage.join("modules.json");
        if module_path.is_file() {
            let mut settings: Value =
                serde_json::from_slice(&std::fs::read(&module_path).map_err(|e| e.to_string())?)
                    .map_err(|_| "invalid module settings")?;
            rebase(&mut settings, old_root, &self.destination);
            private_write(&module_path, settings.to_string().as_bytes())?;
        }
        rebase(credentials, old_root, &self.destination);
        // A restored computer starts private. It never inherits an old machine's listener,
        // TLS identity, firewall approval, background service, or sharing opt-in.
        let listener =
            std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "no local port")?;
        let port = listener.local_addr().map_err(|_| "no local port")?.port();
        let origins = vec![
            format!("https://localhost:{port}"),
            format!("https://127.0.0.1:{port}"),
        ];
        let tls = stage.join("tls");
        if tls.exists() {
            std::fs::remove_dir_all(&tls).map_err(|_| "cannot replace old identity")?;
        }
        let command = moss_launcher::runtime::command(&self.install, "openssl");
        moss_network::tls::local_certificate_with_command(&tls, &origins, command)?;
        Config {
            listen: ([127, 0, 0, 1], port).into(),
            origins,
            sharing: false,
            certificate: self.destination.join("tls/certificate.pem"),
            private_key: self.destination.join("tls/key.pem"),
            credentials: self.destination.join(keystore::custody::BUNDLE_FILE),
        }
        .write(&stage.join("network.json"))
    }
}
fn rebase(value: &mut Value, old: &Path, new: &Path) {
    match value {
        Value::String(text) => {
            if let Ok(suffix) = Path::new(text).strip_prefix(old) {
                *text = new.join(suffix).to_string_lossy().into_owned();
            }
        }
        Value::Array(values) => {
            for value in values {
                rebase(value, old, new);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                rebase(value, old, new);
            }
        }
        _ => (),
    }
}
