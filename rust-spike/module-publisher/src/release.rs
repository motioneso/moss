//! First-party release assembly. Human dispatch authorizes an exact public review report.
//! The legacy TypeScript registry and its signing keys are never read here.
use crate::{artifacts, read_bounded, registry_artifacts, Configuration, Prepared, Submission};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    archive::{Package, MAX_PACKAGE},
    registry::{Index, ModuleList, ModulePin},
    trust,
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

fn signed(folder: &Path, name: &str, bytes: &[u8], key: &Ed25519KeyPair) -> Result<()> {
    fs::write(folder.join(name), bytes)?;
    fs::write(
        folder.join(format!("{name}.sig")),
        STANDARD.encode(key.sign(bytes).as_ref()),
    )?;
    Ok(())
}
fn credentials(dry_run: bool) -> Result<(String, Vec<u8>)> {
    if dry_run {
        return Ok((
            "generated-ci".into(),
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| anyhow::anyhow!("Could not generate CI signing key"))?
                .as_ref()
                .to_vec(),
        ));
    }
    let id = std::env::var("MOSS_RUST_REGISTRY_SIGNING_KEY_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .context(
            "Missing MOSS_RUST_REGISTRY_SIGNING_KEY_ID; Rust registry publication is disabled",
        )?;
    ensure!(
        moss_module_host::manifest::identifier(&id),
        "Invalid Rust signing key identifier"
    );
    let encoded = std::env::var("MOSS_RUST_REGISTRY_SIGNING_PRIVATE_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .context(
            "Missing MOSS_RUST_REGISTRY_SIGNING_PRIVATE_KEY; Rust registry publication is disabled",
        )?;
    let key = STANDARD.decode(encoded.trim()).map_err(|_| {
        anyhow::anyhow!("Invalid Rust signing key encoding (expected base64 PKCS#8)")
    })?;
    Ok((id, key))
}

pub fn build(input: &Path, output: &Path, previous: Option<&Path>, dry_run: bool) -> Result<Value> {
    let (key_id, pkcs8) = credentials(dry_run)?;
    let key = Ed25519KeyPair::from_pkcs8(&pkcs8)
        .map_err(|_| anyhow::anyhow!("Invalid Rust signing key"))?;
    let public = STANDARD.encode(key.public_key().as_ref());
    ensure!(!output.exists(), "Release output already exists");
    let parent = output.parent().context("Release output needs a parent")?;
    let scratch = tempfile::tempdir_in(parent)?;
    let stage = scratch.path().join("stage");
    let config_path = scratch.path().join("pipeline.json");
    let config_json = json!({"registryPath":stage,"registryId":"moss","rootKey":public,"firstPartyKey":public,"mossVersion":"0.1.0","policy":"moss","reviewerKeys":{"release-owner":public}});
    let config: Configuration = serde_json::from_value(config_json.clone())?;
    fs::write(&config_path, serde_json::to_vec(&config_json)?)?;
    let previous_digest = if let Some(previous) = previous {
        // Part 4's mirror authenticates all old bytes before we retain its history.
        let old_config = scratch.path().join("previous.json");
        let mut old = config_json.clone();
        old["registryPath"] = json!(previous);
        fs::write(&old_config, serde_json::to_vec(&old)?)?;
        registry_artifacts::mirror(&old_config, &stage, &[])?;
        let digest = trust::digest(&read_bounded(
            &stage.join("index.json"),
            moss_module_host::registry::MAX_INDEX,
        )?);
        // Assembly expects no previous bundle. Package/index history and revocations stay.
        for name in ["bundle.json", "bundle.json.sig"] {
            if stage.join(name).exists() {
                fs::remove_file(stage.join(name))?;
            }
        }
        Some(digest)
    } else {
        fs::create_dir(&stage)?;
        fs::create_dir(stage.join("packages"))?;
        let identity = json!({"id":"moss","name":"Moss Rust modules","rootFingerprint":trust::digest(key.public_key().as_ref()),"indexKeys":{key_id.clone():public},"publishers":{"first-party":{"key":public,"prefix":""}}});
        signed(
            &stage,
            "registry.json",
            &serde_json::to_vec(&identity)?,
            &key,
        )?;
        let index = Index {
            publish_reviews: Default::default(),
            serial: 0,
            expires: chrono::Utc::now() + chrono::Duration::days(7),
            signing_key: key_id.clone(),
            modules: vec![],
            revoked: vec![],
        };
        signed(&stage, "index.json", &serde_json::to_vec(&index)?, &key)?;
        None
    };
    let base = artifacts::catalog(&config)?;
    ensure!(
        base.trust.identity.id == "moss"
            && base.trust.identity.index_keys.get(&key_id) == Some(&public),
        "Release signing key is not authorized by the saved registry"
    );
    let mut renewed = base.index;
    renewed.serial = renewed
        .serial
        .checked_add(1)
        .context("Index serial exhausted")?;
    renewed.expires = chrono::Utc::now() + chrono::Duration::days(7);
    signed(&stage, "index.json", &serde_json::to_vec(&renewed)?, &key)?;

    let mut candidates = BTreeMap::new();
    for entry in fs::read_dir(input)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("mosspkg") {
            continue;
        }
        ensure!(
            fs::symlink_metadata(&path)?.is_file(),
            "Package input must be a regular file"
        );
        let bytes = read_bounded(&path, MAX_PACKAGE)?;
        let digest = trust::digest(&bytes);
        let package = Package::read(&bytes, &digest, &config.moss_version)?;
        ensure!(
            !package.manifest.id.contains('.'),
            "Release accepts first-party packages only"
        );
        artifacts::validate(&package)?;
        let id = package.manifest.id.clone();
        ensure!(
            candidates.insert(id, (path, bytes, package)).is_none(),
            "Repeated release module"
        );
    }
    ensure!(!candidates.is_empty(), "No first-party packages supplied");
    // A release cannot quietly drop a previously bundled module.
    for id in renewed
        .modules
        .iter()
        .map(|a| &a.id)
        .collect::<BTreeSet<_>>()
    {
        ensure!(
            candidates.contains_key(id),
            "A previously published module is missing from this release"
        );
    }
    let mut report = Vec::new();
    for (id, (path, _, package)) in &candidates {
        if renewed.modules.iter().any(|a| {
            a.id == *id && a.version == package.manifest.version && a.digest == package.digest
        }) {
            continue;
        }
        let submission = Submission {
            package_path: path.clone(),
            publisher_key: "first-party".into(),
            signature: STANDARD.encode(key.sign(package.digest.as_bytes()).as_ref()),
        };
        let prepared = Prepared::open(&config, &submission)?;
        report.push(json!({"id":id,"version":package.manifest.version,"digest":package.digest,"previousDigest":prepared.request().previous_digest,"diff":prepared.request().diff}));
    }
    let review = json!({"firstPartyKey":public,"keyId":key_id,"previousIndexDigest":previous_digest,"changes":report});
    let review_bytes = serde_json::to_vec(&review)?;
    let approved_digest = trust::digest(&review_bytes);
    if !dry_run && !report.is_empty() {
        eprintln!(
            "Release review report: {}",
            serde_json::to_string_pretty(&review)?
        );
        ensure!(std::env::var("MOSS_RUST_REGISTRY_APPROVED_REPORT").ok().as_deref()==Some(approved_digest.as_str()),
            "Human approval required: inspect the report above and dispatch with this exact report digest: {approved_digest}");
    }
    let mut defaults = Vec::new();
    let mut optional = Vec::new();
    for (id, (path, bytes, package)) in &candidates {
        let signature = STANDARD.encode(key.sign(package.digest.as_bytes()).as_ref());
        if !renewed.modules.iter().any(|a| {
            a.id == *id && a.version == package.manifest.version && a.digest == package.digest
        }) {
            let submission = Submission {
                package_path: path.clone(),
                publisher_key: "first-party".into(),
                signature: signature.clone(),
            };
            let prepared = Prepared::open(&config, &submission)?;
            let request = prepared.request().clone();
            let approval = moss_module_host::registry_review::HumanApproval {
                signature: STANDARD.encode(key.sign(&crate::approval_bytes(&request)?).as_ref()),
                request,
                reviewer: "release-owner".into(),
            };
            let published = prepared.publish(Some(approval), &pkcs8)?;
            signed(&stage, "index.json", published.index.as_bytes(), &key)?;
        }
        let name = format!("{}.mosspkg", package.digest);
        let blob = stage.join("packages").join(&name);
        if !blob.exists() {
            fs::write(&blob, bytes)?;
        }
        fs::write(
            stage.join("packages").join(format!("{name}.sig")),
            &signature,
        )?;
        let pin = ModulePin {
            id: id.clone(),
            registry: "moss".into(),
            version: Some(package.manifest.version.clone()),
        };
        if package
            .manifest
            .lifecycle
            .as_ref()
            .is_some_and(|l| l.required)
            && !matches!(id.as_str(), "finance" | "meals")
        {
            defaults.push(pin);
        } else {
            optional.push(pin);
        }
    }
    let selection =
        json!({"default":ModuleList {modules:defaults},"optional":ModuleList {modules:optional}});
    let selection_path = scratch.path().join("selection.json");
    fs::write(&selection_path, serde_json::to_vec(&selection)?)?;
    let complete = scratch.path().join("complete");
    fs::create_dir(&complete)?;
    registry_artifacts::assemble_with_key(
        &config_path,
        &selection_path,
        &pkcs8,
        &complete.join("registry"),
    )?;
    let mut final_config = config_json;
    final_config["registryPath"] = json!(complete.join("registry"));
    let final_path = scratch.path().join("final.json");
    fs::write(&final_path, serde_json::to_vec(&final_config)?)?;
    registry_artifacts::verify(&final_path, &[])?;
    // A second verified mirror is the deployable snapshot; no staged private files enter it.
    registry_artifacts::mirror(&final_path, &complete.join("mirror"), &[])?;
    fs::remove_dir_all(complete.join("mirror"))?;
    fs::write(complete.join("review.json"), &review_bytes)?;
    compile_bundle(&complete, &public)?;
    fs::rename(&complete, output)?;
    Ok(
        json!({"reviewDigest":approved_digest,"rootKey":public,"registry":"moss","packages":candidates.len(),"dryRun":dry_run}),
    )
}

fn compile_bundle(folder: &Path, key: &str) -> Result<()> {
    let bundle: registry_artifacts::Bundle =
        serde_json::from_slice(&fs::read(folder.join("registry/bundle.json"))?)?;
    let mut source=format!("pub fn release() -> moss_module_host::bundle::Bundle<'static> {{ moss_module_host::bundle::Bundle {{ registry: {:?}, first_party_key: {:?}, packages: &[\n",bundle.registry,key);
    for (entries, default) in [(&bundle.default, true), (&bundle.optional, false)] {
        for entry in entries {
            source+=&format!("moss_module_host::bundle::BundleItem {{ package: moss_module_host::bundle::BundledPackage {{ id: {:?}, digest: {:?}, signature: {:?} }}, bytes: include_bytes!({:?}), default: {} }},\n",entry.id,entry.digest,entry.signature,format!("registry/packages/{}.mosspkg",entry.digest),default);
        }
    }
    source += "] } }\n";
    fs::write(folder.join("compiled_bundle.rs"), source)?;
    Ok(())
}
