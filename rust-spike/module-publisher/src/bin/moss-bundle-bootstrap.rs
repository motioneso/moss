//! Stand-in only. Phase 7 owns real installer/setup and database provisioning.
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use moss_module_host::{
    lifecycle::FileLifecycle,
    local::LocalPorts,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use std::{collections::BTreeSet, path::Path, sync::Arc};
mod compiled {
    include!(concat!(env!("OUT_DIR"), "/compiled_bundle.rs"));
}
struct FileCatalog(vault::Root);
impl CatalogStore for FileCatalog {
    fn load(&self) -> Result<State> {
        match self.0.read("catalog.json") {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(vault::VaultError::NotFound(_)) => Ok(State::default()),
            Err(e) => Err(e.into()),
        }
    }
    fn commit(&self, expected: u64, next: &State) -> Result<()> {
        ensure!(self.load()?.revision == expected, "Stale stand-in catalog");
        self.0.write("catalog.json", &serde_json::to_vec(next)?)?;
        Ok(())
    }
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(
        matches!(args.len(), 2 | 3),
        "Usage: moss-bundle-bootstrap DATA ADMIN_UUID [--postgres]"
    );
    let bundle = compiled::release();
    ensure!(
        !bundle.packages.is_empty(),
        "Build this stand-in with MOSS_COMPILED_BUNDLE from moss release"
    );
    let data = Path::new(&args[0]);
    let actor: uuid::Uuid = args[1].parse()?;
    let access = AccessContext::new(actor, "bundle-bootstrap");
    let (catalog, lifecycle): (
        Arc<dyn CatalogStore>,
        Arc<dyn moss_module_host::store::Lifecycle>,
    ) = if args.len() == 3 {
        ensure!(args[2] == "--postgres", "Unknown bootstrap option");
        use safety_core::{
            db::{Database, RuntimeRole},
            secret::{Secret, SecretCipher},
        };
        let url = std::env::var("MOSS_BUNDLE_APP_URL").context("Missing MOSS_BUNDLE_APP_URL")?;
        let migrations = std::env::var("MOSS_BUNDLE_MIGRATIONS_URL")
            .context("Missing MOSS_BUNDLE_MIGRATIONS_URL")?;
        let runtime = tokio::runtime::Runtime::new()?;
        let database = runtime
            .block_on(Database::connect(&url, 4, RuntimeRole::App))
            .map_err(|_| anyhow::anyhow!("Could not open bootstrap runtime database"))?;
        // Use the same standard keyring names as the host; never log their values.
        let keyring = [
            "NODE_ENV",
            "JARVIS_CONNECTOR_SECRET_KEY",
            "MOSS_CONNECTOR_SECRET_KEY",
            "JARVIS_CONNECTOR_SECRET_KEY_ID",
            "MOSS_CONNECTOR_SECRET_KEY_ID",
            "JARVIS_CONNECTOR_SECRET_KEYS",
            "MOSS_CONNECTOR_SECRET_KEYS",
        ]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name.into(), value)))
        .collect();
        let cipher = Arc::new(
            SecretCipher::connectors(&keyring)
                .map_err(|_| anyhow::anyhow!("Invalid host catalog keyring"))?,
        );
        (
            Arc::new(
                moss_module_host::postgres::PostgresCatalog::new(database.clone(), access.clone())?
                    .with_cipher(cipher.clone()),
            ),
            Arc::new(
                moss_module_host::migrations::PostgresLifecycle::new(
                    Secret::new(migrations),
                    database,
                    data,
                )?
                .with_cipher(cipher),
            ),
        )
    } else {
        (
            Arc::new(FileCatalog(vault::Root::create(&data.join("stand-in"))?)),
            Arc::new(FileLifecycle::new(data, BTreeSet::from([actor]))?),
        )
    };
    let installer = Installer::new(
        data,
        catalog.clone(),
        lifecycle,
        Host::new(Limits::default())?,
        Arc::new(LocalPorts::new(data)?),
        "0.1.0".parse()?,
        LegacyInventory::default(),
    )?;
    bundle.bootstrap(&installer, &access)?;
    let state = catalog.load()?;
    let installed: Vec<_> = installer
        .installed_for(&access)?
        .into_iter()
        .map(|m| m.manifest.id)
        .collect();
    let cached: Vec<_> = bundle
        .packages
        .iter()
        .filter(|p| installer.read_package(p.package.digest).is_ok())
        .map(|p| p.package.id)
        .collect();
    println!(
        "{}",
        serde_json::json!({"installed":installed,"cached":cached,"registryObserved":!state.registries.is_empty()})
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
