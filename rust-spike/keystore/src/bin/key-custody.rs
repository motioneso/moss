//! Command line driver for the key custody runner. Test values only.
//!
//! Modes choose a stand-in key store, so the runner works the same on every system.
//! The platform mode uses the real operating system key store.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use keystore::custody::{
    load_master, migrate, read_bundle, restore_with_words, set_up_instance, setup_route,
    start_gate, write_key_file, CustodyError, FakeMode, MemoryStore, OsKeyStore, SetupRoute,
};
use keystore::platform::{platform_store, service_name};
use keystore::recovery::split_pasted;

fn arg<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|w| w[0] == name)
        .map(|w| w[1].as_str())
}

fn fail(error: CustodyError) -> ExitCode {
    eprintln!("{}: {}", error.code(), error.reason());
    println!("code={}", error.code());
    println!("reason={}", error.reason());
    ExitCode::from(3)
}

fn store_for(mode: &str) -> Result<Box<dyn OsKeyStore>, CustodyError> {
    Ok(match mode {
        "working" => Box::new(MemoryStore::new(FakeMode::Working)),
        "locked" => Box::new(MemoryStore::new(FakeMode::Locked)),
        "missing" => Box::new(MemoryStore::new(FakeMode::Missing)),
        "broken" => Box::new(MemoryStore::new(FakeMode::Broken)),
        "platform" => platform_store(),
        _ => return Err(CustodyError::Unavailable(format!("unknown mode {mode}"))),
    })
}

// The stand-in store must survive between commands in one runner run. It keeps its
// test master key in a state file beside the instance root, never inside it.
struct FileFakeStore {
    mode: FakeMode,
    path: PathBuf,
}

impl FileFakeStore {
    fn gate(&self) -> Result<(), CustodyError> {
        match self.mode {
            FakeMode::Working => Ok(()),
            FakeMode::Locked => Err(CustodyError::Locked),
            FakeMode::Missing => Err(CustodyError::Unavailable("no key store".into())),
            FakeMode::Broken => Err(CustodyError::Unavailable("key store did not answer".into())),
        }
    }
}

impl OsKeyStore for FileFakeStore {
    fn store_master(
        &mut self,
        _s: &str,
        master: &keystore::custody::MasterKey,
    ) -> Result<(), CustodyError> {
        self.gate()?;
        use base64::Engine;
        std::fs::write(
            &self.path,
            base64::engine::general_purpose::STANDARD.encode(master.bytes()),
        )
        .map_err(|e| CustodyError::Io(e.to_string()))
    }
    fn load_master(&self, _s: &str) -> Result<keystore::custody::MasterKey, CustodyError> {
        self.gate()?;
        use base64::Engine;
        let text =
            std::fs::read(&self.path).map_err(|e| CustodyError::Unavailable(e.to_string()))?;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(text.trim_ascii())
            .map_err(|_| CustodyError::Damaged("fake store damaged".into()))?;
        let bytes: [u8; 32] = raw
            .try_into()
            .map_err(|_| CustodyError::Damaged("fake master has the wrong size".into()))?;
        Ok(keystore::custody::MasterKey::from_bytes(bytes))
    }
    fn delete_master(&mut self, _s: &str) -> Result<(), CustodyError> {
        self.gate()?;
        let _ = std::fs::remove_file(&self.path);
        Ok(())
    }
    fn probe(&self) -> Result<(), CustodyError> {
        self.gate()
    }
}

fn load_fake(mode: &str, root: &Path) -> FileFakeStore {
    let mode = match mode {
        "locked" => FakeMode::Locked,
        "missing" => FakeMode::Missing,
        "broken" => FakeMode::Broken,
        _ => FakeMode::Working,
    };
    let state_dir = root
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| root.to_path_buf());
    FileFakeStore {
        mode,
        path: state_dir.join(format!(
            ".fake-keystore-{}",
            root.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "instance".into())
        )),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        eprintln!("usage: key-custody <setup|migrate|start|recover|probe|platform-smoke|setup-headless> --root DIR --mode MODE");
        return ExitCode::from(2);
    };
    let root = PathBuf::from(arg(&args, "--root").unwrap_or("."));
    let mode = arg(&args, "--mode").unwrap_or("working");
    let service = service_name(arg(&args, "--instance").unwrap_or("default"));
    let desktop = arg(&args, "--session").unwrap_or("desktop") == "desktop";

    match command {
        "probe" => {
            let store = match store_for(mode) {
                Ok(store) => store,
                Err(error) => return fail(error),
            };
            match setup_route(desktop, store.probe()) {
                SetupRoute::OsStore => {
                    println!("route=os-store");
                    ExitCode::SUCCESS
                }
                SetupRoute::KeyFileChoice => {
                    println!("route=key-file-choice");
                    ExitCode::SUCCESS
                }
                SetupRoute::Stop(error) => {
                    println!("route=stop");
                    println!("offers_key_file=false");
                    fail(error)
                }
            }
        }
        "migrate" | "setup" => {
            let leak = args.iter().any(|a| a == "--leak-plaintext");
            let mut store = if mode == "platform" {
                platform_store()
            } else {
                Box::new(load_fake(mode, &root)) as Box<dyn OsKeyStore>
            };
            let result = if command == "migrate" {
                migrate(&root, store.as_mut(), &service, leak)
            } else {
                let credentials = std::fs::read(root.join("credentials.json")).unwrap_or_default();
                set_up_instance(&root, &credentials, store.as_mut(), &service)
            };
            match result {
                Ok(migration) => {
                    let words: Vec<&str> = migration.recovery.words();
                    println!("words={}", words.join(" "));
                    println!("bundle={}", migration.bundle_path.display());
                    println!(
                        "credentials_exists={}",
                        root.join("credentials.json").exists()
                    );
                    ExitCode::SUCCESS
                }
                Err(error) => fail(error),
            }
        }
        "start" => {
            let store = if mode == "platform" {
                platform_store()
            } else {
                Box::new(load_fake(mode, &root)) as Box<dyn OsKeyStore>
            };
            let key_file = arg(&args, "--key-file")
                .map(PathBuf::from)
                .or_else(|| keystore::custody::recorded_key_file(&root));
            let loaded = if mode == "locked" {
                start_gate(store.as_ref(), &service).map(|_| ())
            } else {
                load_master(store.as_ref(), &service, key_file.as_deref()).and_then(|master| {
                    let bundle = read_bundle(&root)?;
                    keystore::custody::unwrap_with_master(&bundle, &master).map(|_| ())
                })
            };
            match loaded {
                Ok(()) => {
                    println!("started=true");
                    ExitCode::SUCCESS
                }
                Err(error) => fail(error),
            }
        }
        "recover" => {
            let bundle = match read_bundle(&root) {
                Ok(bundle) => bundle,
                Err(error) => return fail(error),
            };
            let typed = split_pasted(arg(&args, "--words").unwrap_or(""));
            match restore_with_words(&bundle, &typed) {
                Ok(credentials) => {
                    println!("restored=true");
                    println!("credentials_bytes={}", credentials.len());
                    ExitCode::SUCCESS
                }
                Err(error) => fail(error),
            }
        }
        "setup-headless" => {
            // Real headless setup: the bundle's master key goes to the chosen
            // file, and the choice is recorded beside the bundle.
            let key_file = PathBuf::from(arg(&args, "--key-file").unwrap_or("master.key"));
            let credentials = std::fs::read(root.join("credentials.json")).unwrap_or_default();
            match keystore::custody::set_up_headless(&root, &credentials, &key_file) {
                Ok(migration) => {
                    println!("words={}", migration.recovery.words().join(" "));
                    println!("bundle={}", migration.bundle_path.display());
                    println!("key_file_choice={}", key_file.display());
                    ExitCode::SUCCESS
                }
                Err(error) => fail(error),
            }
        }
        "choose-key-file" => {
            // Records the owner's headless setup choice. No key is made here.
            let path = PathBuf::from(arg(&args, "--key-file").unwrap_or("master.key"));
            match keystore::custody::record_key_file_choice(&root, &path) {
                Ok(()) => {
                    println!("key_file_choice={}", path.display());
                    match keystore::custody::recorded_key_file(&root) {
                        Some(recorded) if recorded == path => ExitCode::SUCCESS,
                        _ => fail(CustodyError::Damaged(
                            "the key-file choice was not recorded".into(),
                        )),
                    }
                }
                Err(error) => fail(error),
            }
        }
        "make-key-file" => {
            let master = keystore::custody::MasterKey::generate();
            let path = PathBuf::from(arg(&args, "--key-file").unwrap_or("master.key"));
            match write_key_file(&path, &master) {
                Ok(()) => {
                    println!("key_file={}", path.display());
                    ExitCode::SUCCESS
                }
                Err(error) => fail(error),
            }
        }
        "platform-smoke" => {
            let mut store = platform_store();
            let master = keystore::custody::MasterKey::generate();
            let probe = store.probe();
            match probe {
                Err(error) => {
                    println!("platform=unavailable");
                    fail(error)
                }
                Ok(()) => {
                    let stored = store.store_master(&service, &master).and_then(|()| {
                        let loaded = store.load_master(&service)?;
                        if loaded.bytes() != master.bytes() {
                            return Err(CustodyError::Damaged(
                                "master key changed in the key store".into(),
                            ));
                        }
                        store.delete_master(&service)
                    });
                    match stored {
                        Ok(()) => {
                            println!("platform=working");
                            ExitCode::SUCCESS
                        }
                        Err(error) => fail(error),
                    }
                }
            }
        }
        _ => {
            eprintln!("unknown command {command}");
            ExitCode::from(2)
        }
    }
}
