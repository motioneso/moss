//! Static artifact assembly consumes signed publisher output; it never rewrites that output.
use crate::{
    artifacts::{self, catalog, configuration},
    read_bounded,
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    archive::{Package, MAX_PACKAGE},
    registry::{self, Catalog, Channel, ModuleList, SeenRegistry, MAX_INDEX},
    trust,
};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleEntry {
    pub id: String,
    pub version: semver::Version,
    pub digest: String,
    pub publisher_key: String,
    pub signature: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    pub registry: String,
    pub index_digest: String,
    pub serial: u64,
    pub signing_key: String,
    pub default: Vec<BundleEntry>,
    pub optional: Vec<BundleEntry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub default: ModuleList,
    pub optional: ModuleList,
}
struct Snapshot {
    catalog: Catalog,
    files: BTreeMap<String, Vec<u8>>,
}
impl Snapshot {
    fn open(config_path: &Path) -> Result<Self> {
        let config = configuration(config_path)?;
        let catalog = catalog(&config)?;
        let mut files = BTreeMap::new();
        // Read each source file once, then authenticate the copied metadata against the catalog.
        for (name, cap) in [
            ("registry.json", 1024 * 1024),
            ("registry.json.sig", 4096),
            ("index.json", MAX_INDEX),
            ("index.json.sig", 4096),
        ] {
            files.insert(name.into(), catalog.source.fetch(name, cap)?);
        }
        let reopened = trust::TrustedRegistry::open(
            &files["registry.json"],
            std::str::from_utf8(&files["registry.json.sig"])?,
            &config.root_key,
            &config.first_party_key,
        )?;
        ensure!(
            serde_json::to_vec(&reopened.identity)? == serde_json::to_vec(&catalog.trust.identity)?,
            "Registry changed during read"
        );
        trust::verify(
            &catalog.trust.identity.index_keys[&catalog.index.signing_key],
            &files["index.json"],
            std::str::from_utf8(&files["index.json.sig"])?,
        )?;
        let copied: registry::Index = serde_json::from_slice(&files["index.json"])?;
        ensure!(
            serde_json::to_vec(&copied)? == serde_json::to_vec(&catalog.index)?,
            "Index changed during read"
        );
        for artifact in &catalog.index.modules {
            let name = format!("packages/{}.mosspkg", artifact.digest);
            let bytes = catalog.source.fetch(&name, artifact.size)?;
            ensure!(
                bytes.len() as u64 == artifact.size,
                "Package size does not match"
            );
            let package = Package::read_for_review(&bytes, &artifact.digest)?;
            registry::compare_manifest(&package.manifest, artifact)?;
            // Structural archive/index validation only: historical versions need not run on
            // the current host. Install-time SQL/import validation remains in verify/publish.
            let _ = package;
            let sig_name = format!("{name}.sig");
            let signature = catalog.source.fetch(&sig_name, 4096)?;
            catalog.trust.verify_package(
                &artifact.publisher_key,
                &artifact.id,
                &artifact.digest,
                std::str::from_utf8(&signature)?,
            )?;
            files.insert(name, bytes);
            files.insert(sig_name, signature);
        }
        // Optional media is content addressed. Do not copy arbitrary files from key storage.
        let media = config.registry_path.join("media");
        if media.exists() {
            ensure!(
                fs::symlink_metadata(&media)?.is_dir(),
                "Media must be a regular folder"
            );
            for entry in fs::read_dir(&media)? {
                let path = entry?.path();
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .context("Invalid media name")?;
                let (digest, ext) = name.split_once('.').context("Media must be digest named")?;
                ensure!(
                    trust::valid_digest(digest)
                        && !ext.is_empty()
                        && ext
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
                    "Media must be digest named"
                );
                let bytes = catalog
                    .source
                    .fetch(&format!("media/{name}"), MAX_PACKAGE)?;
                ensure!(
                    trust::digest(&bytes) == digest,
                    "Media digest does not match"
                );
                files.insert(format!("media/{name}"), bytes);
            }
        }
        let bundle_path = config.registry_path.join("bundle.json");
        let bundle_sig_path = config.registry_path.join("bundle.json.sig");
        let bundle_present = fs::symlink_metadata(&bundle_path)
            .map(|_| true)
            .or_else(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Ok(false)
                } else {
                    Err(e)
                }
            })?;
        let sig_present = fs::symlink_metadata(&bundle_sig_path)
            .map(|_| true)
            .or_else(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Ok(false)
                } else {
                    Err(e)
                }
            })?;
        ensure!(
            bundle_present == sig_present,
            "Bundle and signature must both exist"
        );
        let mut snapshot = Self { catalog, files };
        if bundle_present {
            let bytes = snapshot.catalog.source.fetch("bundle.json", MAX_INDEX)?;
            let signature = snapshot.catalog.source.fetch("bundle.json.sig", 4096)?;
            snapshot.verify_bundle(&bytes, &signature)?;
            snapshot.files.insert("bundle.json".into(), bytes);
            snapshot.files.insert("bundle.json.sig".into(), signature);
        }
        Ok(snapshot)
    }
    fn verify_bundle(&self, bytes: &[u8], signature: &[u8]) -> Result<()> {
        let bundle: Bundle = serde_json::from_slice(bytes)?;
        ensure!(
            bundle.signing_key == self.catalog.index.signing_key,
            "Wrong bundle signing key"
        );
        trust::verify(
            &self.catalog.trust.identity.index_keys[&bundle.signing_key],
            bytes,
            std::str::from_utf8(signature)?,
        )?;
        ensure!(
            bundle.registry == self.catalog.trust.identity.id
                && bundle.index_digest == trust::digest(&self.files["index.json"])
                && bundle.serial == self.catalog.index.serial,
            "Bundle does not match signed index"
        );
        let mut ids = BTreeSet::new();
        for entry in bundle.default.iter().chain(&bundle.optional) {
            ensure!(ids.insert(&entry.id), "Repeated bundle module");
            let artifact = self
                .catalog
                .index
                .modules
                .iter()
                .find(|a| a.id == entry.id && a.version == entry.version)
                .context("Bundle version is missing")?;
            ensure!(
                entry.digest == artifact.digest
                    && entry.publisher_key == artifact.publisher_key
                    && entry.signature == artifact.signature,
                "Bundle package does not match signed index"
            );
        }
        Ok(())
    }
    fn write(self, destination: &Path) -> Result<Value> {
        // create_dir refuses an existing destination, including symlinks. Nothing is overwritten.
        fs::create_dir(destination).context("Output folder already exists or cannot be created")?;
        let result = (|| -> Result<()> {
            for (name, bytes) in &self.files {
                let path = destination.join(name);
                fs::create_dir_all(path.parent().context("Missing parent")?)?;
                artifacts::write_new(&path, bytes)?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(destination);
        }
        result?;
        Ok(
            json!({"registry":self.catalog.trust.identity.id,"serial":self.catalog.index.serial,"files":self.files.len()}),
        )
    }
}
fn conflicts(primary: &Catalog, others: &[String]) -> Result<()> {
    let catalogs = others
        .iter()
        .map(|p| catalog(&configuration(Path::new(p))?))
        .collect::<Result<Vec<_>>>()?;
    let all: Vec<_> = std::iter::once(primary).chain(catalogs.iter()).collect();
    let ids: BTreeSet<_> = all
        .iter()
        .flat_map(|c| c.index.modules.iter().map(|a| a.id.as_str()))
        .collect();
    for id in ids {
        registry::same_publisher(&all, id)?;
    }
    Ok(())
}
pub fn mirror(config: &Path, output: &Path, others: &[String]) -> Result<Value> {
    let snapshot = Snapshot::open(config)?;
    conflicts(&snapshot.catalog, others)?;
    snapshot.write(output)
}
pub fn verify(config: &Path, others: &[String]) -> Result<Value> {
    let snapshot = Snapshot::open(config)?;
    conflicts(&snapshot.catalog, others)?;
    ensure!(
        snapshot.catalog.index.expires > chrono::Utc::now(),
        "The registry index has expired"
    );
    Ok(
        json!({"registry":snapshot.catalog.trust.identity.id,"serial":snapshot.catalog.index.serial,"files":snapshot.files.len()}),
    )
}
pub fn assemble(config: &Path, selection: &Path, key: &Path, output: &Path) -> Result<Value> {
    let mut snapshot = Snapshot::open(config)?;
    ensure!(
        snapshot.catalog.index.expires > chrono::Utc::now(),
        "The registry index has expired"
    );
    let selection: Selection = serde_json::from_slice(&read_bounded(selection, 1024 * 1024)?)?;
    let mut ids = BTreeSet::new();
    let mut seen = SeenRegistry::default();
    seen.accept(
        &snapshot.catalog.index,
        &snapshot.files["index.json"],
        &snapshot.catalog.trust,
    )?;
    let resolve = |list: ModuleList, ids: &mut BTreeSet<String>| -> Result<Vec<BundleEntry>> {
        ModuleList::parse(&serde_json::to_vec(&list)?)?;
        let mut entries = Vec::new();
        for pin in list.modules {
            ensure!(
                pin.registry == snapshot.catalog.trust.identity.id && ids.insert(pin.id.clone()),
                "Wrong registry or repeated bundle module"
            );
            let a = snapshot
                .catalog
                .index
                .modules
                .iter()
                .filter(|a| {
                    a.id == pin.id
                        && a.channel == Channel::Stable
                        && pin.version.as_ref().is_none_or(|v| v == &a.version)
                })
                .max_by_key(|a| &a.version)
                .context("Selected module version is missing")?;
            let public = &snapshot
                .catalog
                .trust
                .publisher(&a.publisher_key, &a.id)?
                .key;
            ensure!(
                !seen.blocks_package(&a.digest, &a.publisher_key, public),
                "Selected module is blocked"
            );
            entries.push(BundleEntry {
                id: a.id.clone(),
                version: a.version.clone(),
                digest: a.digest.clone(),
                publisher_key: a.publisher_key.clone(),
                signature: a.signature.clone(),
            });
        }
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(entries)
    };
    let bundle = Bundle {
        registry: snapshot.catalog.trust.identity.id.clone(),
        index_digest: trust::digest(&snapshot.files["index.json"]),
        serial: snapshot.catalog.index.serial,
        signing_key: snapshot.catalog.index.signing_key.clone(),
        default: resolve(selection.default, &mut ids)?,
        optional: resolve(selection.optional, &mut ids)?,
    };
    let bytes = serde_json::to_vec(&bundle)?;
    ensure!(bytes.len() as u64 <= MAX_INDEX, "Bundle is too large");
    let key = Ed25519KeyPair::from_pkcs8(&read_bounded(key, 4096)?)
        .map_err(|_| anyhow::anyhow!("Invalid index signing key"))?;
    ensure!(
        STANDARD.encode(key.public_key().as_ref())
            == snapshot.catalog.trust.identity.index_keys[&bundle.signing_key],
        "Wrong index signing key"
    );
    let signature = STANDARD.encode(key.sign(&bytes).as_ref()).into_bytes();
    snapshot.verify_bundle(&bytes, &signature)?;
    snapshot.files.insert("bundle.json".into(), bytes);
    snapshot.files.insert("bundle.json.sig".into(), signature);
    snapshot.write(output)
}
