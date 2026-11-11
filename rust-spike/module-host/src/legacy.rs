//! Release-frozen legacy identities. Downloaded packages cannot extend this inventory.
use crate::{archive::Package, manifest::Ledger};
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};
#[derive(Deserialize)]
pub struct File {
    pub module: String,
    pub path: String,
    pub raw: String,
    pub checksum: String,
    pub ledger: Ledger,
}
#[derive(Deserialize)]
struct Inventory {
    tables: BTreeMap<String, Vec<String>>,
    files: Vec<File>,
}
fn inventory() -> &'static Inventory {
    static DATA: OnceLock<Inventory> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../inventory/legacy.data"))
            .expect("compiled migration inventory")
    })
}
pub fn has_ledger(module: &str, ledger: &Ledger) -> bool {
    inventory()
        .files
        .iter()
        .any(|f| f.module == module && &f.ledger == ledger)
}
pub fn tables(module: &str) -> &[String] {
    inventory()
        .tables
        .get(module)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
pub fn owns(module: &str, table: &str) -> bool {
    inventory()
        .tables
        .get(module)
        .is_some_and(|t| t.iter().any(|t| t == table))
}
/// Reviewed pre-package sharing identity. It cannot be chosen by downloaded SQL.
pub fn sharing(module: &str, table: &str, resource: &str, key: &str) -> bool {
    matches!(
        (module, table, resource, key),
        ("calendar", "app.calendar_events", "calendar_event", "id")
            | ("email", "app.email_messages", "email_message", "id")
    )
}
pub fn entry(module: &str, path: &str) -> Option<&'static File> {
    inventory()
        .files
        .iter()
        .find(|f| f.module == module && f.path == path)
}
pub fn hashes() -> BTreeMap<(String, String), String> {
    inventory()
        .files
        .iter()
        .map(|f| ((f.module.clone(), f.path.clone()), f.raw.clone()))
        .collect()
}
pub fn version(path: &str) -> Result<&str> {
    let name = path
        .strip_prefix("sql/")
        .context("Invalid migration path")?;
    let version = name.split('_').next().unwrap_or("");
    ensure!(
        !version.is_empty()
            && (version.bytes().all(|b| b.is_ascii_digit())
                || inventory().files.iter().any(|f| f.path == path)),
        "Migrations need a numeric prefix"
    );
    Ok(version)
}
/// Numeric order with a frozen legacy suffix (0229 < 0229a < 0230).
/// Manifest validation additionally binds suffixes to the owning release inventory.
pub fn order(path: &str) -> Result<(u64, &str)> {
    let version = version(path)?;
    let split = version
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(version.len());
    Ok((version[..split].parse()?, &version[split..]))
}
pub async fn applied(
    tx: &tokio_postgres::Transaction<'_>,
    p: &Package,
    path: &str,
) -> Result<Option<String>> {
    let version = version(path)?;
    let row=match p.manifest.database.ledger {
        Ledger::Module=>tx.query_opt("SELECT checksum FROM moss_modules.migrations WHERE module_id=$1 AND path=$2",&[&p.manifest.id,&path]).await?,
        Ledger::CoreLegacy=>tx.query_opt("SELECT checksum FROM app.schema_migrations WHERE version=$1",&[&version]).await?,
        Ledger::ModuleLegacy=>tx.query_opt("SELECT checksum FROM app.module_schema_migrations WHERE module_id=$1 AND version=$2",&[&p.manifest.id,&version]).await?,
    };
    Ok(row.map(|r| r.get(0)))
}
pub fn checksum(p: &Package, path: &str) -> Result<String> {
    let raw = crate::trust::digest(&p.files[path]);
    if let Some(f) = entry(&p.manifest.id, path).filter(|f| f.raw == raw) {
        ensure!(
            f.ledger == p.manifest.database.ledger,
            "An inventory migration must keep its original ledger"
        );
        return Ok(f.checksum.clone());
    }
    Ok(if p.manifest.database.ledger == Ledger::ModuleLegacy {
        crate::trust::digest(String::from_utf8_lossy(&p.files[path]).as_bytes())
    } else {
        raw
    })
}
pub async fn record(
    tx: &tokio_postgres::Transaction<'_>,
    p: &Package,
    path: &str,
    checksum: &str,
) -> Result<()> {
    let version = version(path)?;
    let name = &path[4..];
    match p.manifest.database.ledger {
        Ledger::Module => {}
        Ledger::CoreLegacy => {
            tx.execute(
                "INSERT INTO app.schema_migrations(version,name,checksum) VALUES($1,$2,$3)",
                &[&version, &name, &checksum],
            )
            .await?;
        }
        Ledger::ModuleLegacy => {
            tx.execute("INSERT INTO app.module_schema_migrations(module_id,version,name,checksum) VALUES($1,$2,$3,$4)",&[&p.manifest.id,&version,&name,&checksum]).await?;
        }
    }
    tx.execute("INSERT INTO moss_modules.migrations(module_id,path,checksum) VALUES($1,$2,$3) ON CONFLICT(module_id,path) DO NOTHING",&[&p.manifest.id,&path,&checksum]).await?;
    Ok(())
}

/// Only exact release-inventory SQL can invoke a compiled backfill.
pub async fn backfill(tx: &tokio_postgres::Transaction<'_>, p: &Package, path: &str) -> Result<()> {
    let sql = std::str::from_utf8(&p.files[path])?;
    if !sql
        .lines()
        .any(|line| line.starts_with("-- moss:backfill "))
    {
        return Ok(());
    }
    ensure!(
        entry(&p.manifest.id, path).is_some_and(|f| f.raw == crate::trust::digest(&p.files[path])),
        "Downloaded backfill code is not executable"
    );
    crate::backfills::run(tx, path).await
}
