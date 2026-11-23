//! Review proposals are recomputed from authenticated package and registry bytes on every run.
pub mod artifacts;
pub mod registry_artifacts;
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
pub use moss_module_host::registry_review::ReviewRequest;
use moss_module_host::{
    archive::{Package, MAX_PACKAGE},
    manifest::Manifest,
    registry::{Artifact, Catalog, Channel, Index, SeenRegistry, Source, MAX_INDEX},
    registry_review::{HumanApproval, PublishDiff, PublishReview},
    runtime::{Host, Limits},
    sql::{self, LegacyInventory},
    trust,
};
use ring::signature::{Ed25519KeyPair, KeyPair};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Policy {
    Moss,
    SelfHosted,
}

/// Release-owner configuration, never supplied by a package submitter.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub registry_path: PathBuf,
    pub registry_id: String,
    pub root_key: String,
    pub first_party_key: String,
    pub moss_version: Version,
    pub policy: Policy,
    pub reviewer_keys: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Submission {
    pub package_path: PathBuf,
    pub publisher_key: String,
    pub signature: String,
}
#[derive(Serialize)]
pub struct SignedIndex {
    /// Preserve these exact UTF-8 bytes for index.json.
    pub index: String,
    pub signature: String,
}

pub fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "Publisher input is too large");
    Ok(bytes)
}

pub fn approval_bytes(request: &ReviewRequest) -> Result<Vec<u8>> {
    let mut bytes = b"moss-publish-review-v1\n".to_vec();
    bytes.extend(serde_json::to_vec(request)?);
    Ok(bytes)
}

pub struct Prepared<'a> {
    config: &'a Configuration,
    catalog: Catalog,
    package: Package,
    artifact: Artifact,
    request: ReviewRequest,
}
impl<'a> Prepared<'a> {
    pub fn request(&self) -> &ReviewRequest {
        &self.request
    }

    pub fn open(config: &'a Configuration, submission: &Submission) -> Result<Self> {
        let mut seen = SeenRegistry::default();
        let catalog = Catalog::fetch(
            Source::Folder(config.registry_path.clone()),
            &config.root_key,
            &config.first_party_key,
            &mut seen,
        )?;
        ensure!(
            catalog.trust.identity.id == config.registry_id,
            "Wrong registry identity"
        );
        ensure!(
            catalog.index.expires > chrono::Utc::now(),
            "The base index has expired"
        );
        let bytes = read_bounded(&submission.package_path, MAX_PACKAGE)?;
        let digest = trust::digest(&bytes);
        let package = Package::read(&bytes, &digest, &config.moss_version)?;
        catalog.trust.verify_package(
            &submission.publisher_key,
            &package.manifest.id,
            &digest,
            &submission.signature,
        )?;
        let previous = catalog
            .index
            .modules
            .iter()
            .filter(|a| a.id == package.manifest.id)
            .max_by(|a, b| a.version.cmp(&b.version));
        let old = if let Some(previous) = previous {
            ensure!(
                package.manifest.version > previous.version,
                "Version must be newer than every published version"
            );
            let old = catalog.download_for_review(previous)?;
            package.unchanged_sql(&old)?;
            Some(old)
        } else {
            None
        };
        sql::check(&package, &LegacyInventory::default())?;
        if let Some(wasm) = package.files.get("code/module.wasm") {
            Host::new(Limits::default())?.validate(wasm, &package.manifest)?;
        }
        let publisher = catalog
            .trust
            .publisher(&submission.publisher_key, &package.manifest.id)?;
        ensure!(
            !seen.blocks_package(&digest, &submission.publisher_key, &publisher.key),
            "Package or publisher is blocked by registry revocation"
        );
        let new_publisher = !catalog.index.modules.iter().any(|a| {
            catalog
                .trust
                .identity
                .publishers
                .get(&a.publisher_key)
                .is_some_and(|p| p.key == publisher.key)
        });
        let manifest = &package.manifest;
        let mut capabilities = match &old {
            Some(old) => {
                let ports: BTreeSet<_> = manifest
                    .newly_requested(&old.manifest)
                    .into_iter()
                    .map(|p| p.port)
                    .collect();
                manifest
                    .capabilities
                    .iter()
                    .filter(|c| ports.contains(&c.port))
                    .cloned()
                    .collect::<Vec<_>>()
            }
            None => manifest.capabilities.clone(),
        };
        capabilities.sort_by(|a, b| a.port.cmp(&b.port));
        let old_hosts = old
            .as_ref()
            .map(|p| fetch_hosts(&p.manifest))
            .unwrap_or_default();
        let fetch_hosts: BTreeSet<String> = fetch_hosts(manifest)
            .difference(&old_hosts)
            .cloned()
            .collect();
        let request = ReviewRequest {
            registry_id: config.registry_id.clone(),
            base_index_digest: seen.index_digest,
            digest: digest.clone(),
            previous_digest: old.map(|p| p.digest),
            publisher_key: submission.publisher_key.clone(),
            publisher_public_key: publisher.key.clone(),
            diff: PublishDiff {
                new_publisher,
                capabilities,
                fetch_hosts,
            },
        };
        let artifact = Artifact {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            digest,
            size: bytes.len() as u64,
            publisher_key: submission.publisher_key.clone(),
            signature: submission.signature.clone(),
            requires_moss: manifest.requires_moss.clone(),
            abi: manifest.abi.clone(),
            capabilities: manifest.capabilities.clone(),
            migrations: manifest.database.migrations.clone(),
            requires: manifest.requires.clone(),
            changelog: String::from_utf8(package.files["CHANGELOG.md"].clone())?,
            channel: Channel::Stable,
            urgent: false,
        };
        Ok(Self {
            config,
            catalog,
            package,
            artifact,
            request,
        })
    }

    pub fn publish(self, approval: Option<HumanApproval>, index_key: &[u8]) -> Result<SignedIndex> {
        let config = self.config;
        if let Some(approval) = &approval {
            ensure!(
                approval.request == self.request,
                "Approval does not match the package digest and diff"
            );
            let key = config
                .reviewer_keys
                .get(&approval.reviewer)
                .context("Reviewer is not trusted")?;
            trust::verify(
                key,
                &approval_bytes(&approval.request)?,
                &approval.signature,
            )?;
        }
        ensure!(
            !matches!(config.policy, Policy::Moss)
                || !self.request.diff.requires_review()
                || approval.is_some(),
            "Human approval required for publisher, capability or fetch host growth"
        );
        let key = Ed25519KeyPair::from_pkcs8(index_key)
            .map_err(|_| anyhow::anyhow!("Invalid index signing key"))?;
        let expected = self
            .catalog
            .trust
            .identity
            .index_keys
            .get(&self.catalog.index.signing_key)
            .context("Index signing key is not trusted")?;
        ensure!(
            STANDARD.encode(key.public_key().as_ref()) == *expected,
            "Wrong index signing key"
        );
        let mut index: Index = self.catalog.index;
        index.serial = index
            .serial
            .checked_add(1)
            .context("Index serial exhausted")?;
        index.expires = chrono::Utc::now() + chrono::Duration::days(7);
        index.publish_reviews.insert(
            self.package.digest,
            PublishReview {
                request: self.request,
                approval,
            },
        );
        index.modules.push(self.artifact);
        let bytes = serde_json::to_vec(&index)?;
        ensure!(
            bytes.len() as u64 <= MAX_INDEX,
            "Proposed index exceeds the host limit"
        );
        let signature = STANDARD.encode(key.sign(&bytes).as_ref());
        Ok(SignedIndex {
            index: String::from_utf8(bytes)?,
            signature,
        })
    }
}

fn fetch_hosts(manifest: &Manifest) -> BTreeSet<String> {
    manifest
        .capabilities
        .iter()
        .filter(|c| c.port == "fetch")
        .flat_map(|c| c.resources.iter().cloned())
        .chain(
            manifest
                .credentials
                .values()
                .flat_map(|c| c.hosts.iter().cloned()),
        )
        .collect()
}
