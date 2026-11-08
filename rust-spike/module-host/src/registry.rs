use crate::{
    manifest::{Capability, Manifest, ABI},
    trust::{self, TrustedRegistry},
};
use anyhow::{bail, ensure, Context, Result};
use chrono::{DateTime, Utc};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    net::{IpAddr, ToSocketAddrs},
    path::PathBuf,
    time::Duration,
};
use url::Url;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub id: String,
    pub version: Version,
    pub digest: String,
    pub size: u64,
    pub publisher_key: String,
    pub signature: String,
    pub requires_moss: VersionReq,
    pub abi: String,
    pub capabilities: Vec<Capability>,
    pub migrations: Vec<String>,
    #[serde(default)]
    pub requires: BTreeMap<String, VersionReq>,
    pub changelog: String,
    pub channel: Channel,
    #[serde(default)]
    pub urgent: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Channel {
    Stable,
    Preview,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Index {
    pub serial: u64,
    pub expires: DateTime<Utc>,
    pub signing_key: String,
    pub modules: Vec<Artifact>,
    #[serde(default)]
    pub revoked: Vec<Revocation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revocation {
    pub target: String,
    pub reason: String,
    pub level: RevocationLevel,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum RevocationLevel {
    Warn,
    Block,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeenRegistry {
    #[serde(default)]
    pub root_fingerprint: Option<String>,
    pub serial: u64,
    pub index_digest: String,
    pub revocations: BTreeMap<String, Revocation>,
    pub versions: BTreeMap<String, String>,
}
impl SeenRegistry {
    pub fn accept(&mut self, index: &Index, bytes: &[u8], trust: &TrustedRegistry) -> Result<()> {
        ensure!(
            self.root_fingerprint
                .as_ref()
                .is_none_or(|root| root == &trust.identity.root_fingerprint),
            "The registry root differs from the one already trusted"
        );
        ensure!(
            index.serial >= self.serial,
            "The registry index is older than one already seen"
        );
        let digest = trust::digest(bytes);
        ensure!(
            index.serial != self.serial
                || self.index_digest.is_empty()
                || self.index_digest == digest,
            "The registry reused an index serial"
        );
        let mut next = self.clone();
        next.root_fingerprint = Some(trust.identity.root_fingerprint.clone());
        for artifact in &index.modules {
            let version = format!("{}@{}", artifact.id, artifact.version);
            ensure!(
                next.versions
                    .get(&version)
                    .is_none_or(|old| old == &artifact.digest),
                "The registry changed a published version"
            );
            next.versions.insert(version, artifact.digest.clone());
        }
        for rev in &index.revoked {
            // A signing key cannot downgrade a block to a warning.
            if next
                .revocations
                .get(&rev.target)
                .is_some_and(|r| r.level == RevocationLevel::Block)
            {
                continue;
            }
            next.revocations.insert(rev.target.clone(), rev.clone());
        }
        for target in &trust.identity.lifted_revocations {
            next.revocations.remove(target);
        }
        next.serial = index.serial;
        next.index_digest = digest;
        *self = next;
        Ok(())
    }
    pub fn blocked(&self, artifact: &Artifact) -> bool {
        [&artifact.digest, &artifact.publisher_key].iter().any(|k| {
            self.revocations
                .get(*k)
                .is_some_and(|r| r.level == RevocationLevel::Block)
        })
    }
}
#[derive(Clone)]
pub enum Source {
    Folder(PathBuf),
    Https { base: Url, allow_private: bool },
}
impl Source {
    pub fn fetch(&self, path: &str, cap: u64) -> Result<Vec<u8>> {
        ensure!(
            crate::manifest::relative_path(path),
            "Unsafe registry file name"
        );
        let mut bytes = Vec::new();
        match self {
            Self::Folder(folder) => {
                let root = vault::Root::open(folder)?;
                let candidate = root.path().join(path);
                let parent = candidate
                    .parent()
                    .context("The registry path has no parent")?;
                let confined = root.subdir(
                    parent
                        .strip_prefix(root.path())?
                        .to_str()
                        .context("Invalid registry path")?
                        .trim_end_matches('/'),
                );
                if parent != root.path() {
                    confined?;
                }
                let meta = std::fs::symlink_metadata(&candidate)?;
                ensure!(
                    meta.is_file() && !meta.file_type().is_symlink(),
                    "Registry entries must be regular files"
                );
                std::fs::File::open(candidate)?
                    .take(cap + 1)
                    .read_to_end(&mut bytes)?;
            }
            Self::Https {
                base,
                allow_private,
            } => {
                ensure!(
                    base.scheme() == "https"
                        && base.username().is_empty()
                        && base.password().is_none()
                        && base.query().is_none()
                        && base.fragment().is_none()
                        && base.path().ends_with('/'),
                    "Registry addresses must be HTTPS folder URLs"
                );
                let url = base.join(path)?;
                let response = https_request(&url, *allow_private, Duration::from_secs(30))?;
                response.take(cap + 1).read_to_end(&mut bytes)?;
            }
        }
        ensure!(
            bytes.len() as u64 <= cap,
            "The registry file exceeds its size limit"
        );
        Ok(bytes)
    }
}
/// Resolve once, validate every address, and pin that resolution for the request. Redirects and
/// ambient proxy settings are disabled so neither can bypass the destination check.
pub fn https_request(
    url: &Url,
    allow_private: bool,
    timeout: Duration,
) -> Result<reqwest::blocking::Response> {
    ensure!(
        url.scheme() == "https" && url.username().is_empty() && url.password().is_none(),
        "Only HTTPS destinations are allowed"
    );
    let host = url.host_str().context("The URL needs a host")?;
    let addresses: Vec<_> = (host, url.port_or_known_default().unwrap_or(443))
        .to_socket_addrs()?
        .collect();
    ensure!(
        !addresses.is_empty() && (allow_private || addresses.iter().all(|a| public_ip(a.ip()))),
        "This destination resolves to a private or reserved network"
    );
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .resolve_to_addrs(host, &addresses)
        .build()?;
    let response = client.get(url.clone()).send()?;
    ensure!(
        response.status().is_success(),
        "The service did not return a successful response"
    );
    Ok(response)
}
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || a == 169 && b == 254
                || a == 172 && (16..=31).contains(&b)
                || a == 192 && b == 168
                || a == 100 && (64..=127).contains(&b)
                || a == 192 && b == 0
                || a == 192 && b == 2
                || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)
                || a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(v) => v
            .to_ipv4_mapped()
            .map(|v| public_ip(v.into()))
            .unwrap_or_else(|| {
                let s = v.segments();
                (s[0] & 0xe000) == 0x2000
                    && !(s[0] == 0x2001 && s[1] <= 0x1ff)
                    && !(s[0] == 0x2001 && s[1] == 0xdb8)
            }),
    }
}
pub struct Catalog {
    pub trust: TrustedRegistry,
    pub index: Index,
    pub source: Source,
    documents: BTreeMap<String, Vec<u8>>,
}
impl Catalog {
    pub fn assert_current(&self, seen: &SeenRegistry) -> Result<()> {
        ensure!(
            seen.root_fingerprint.as_ref() == Some(&self.trust.identity.root_fingerprint)
                && self.index.serial == seen.serial
                && self
                    .documents
                    .get("index.json")
                    .is_some_and(|bytes| trust::digest(bytes) == seen.index_digest),
            "Refresh the registry before using this stale or untrusted catalog"
        );
        Ok(())
    }
    /// The caller commits `seen` durably before using this catalog to install anything.
    pub fn fetch(
        source: Source,
        root_key: &str,
        first_party_key: &str,
        seen: &mut SeenRegistry,
    ) -> Result<Self> {
        let identity = source.fetch("registry.json", 1024 * 1024)?;
        let sig = String::from_utf8(source.fetch("registry.json.sig", 4096)?)?;
        let root_signature = sig.as_bytes().to_vec();
        let trust = TrustedRegistry::open(&identity, &sig, root_key, first_party_key)?;
        let bytes = source.fetch("index.json", 8 * 1024 * 1024)?;
        let sig = String::from_utf8(source.fetch("index.json.sig", 4096)?)?;
        let index: Index = serde_json::from_slice(&bytes)?;
        let key = trust
            .identity
            .index_keys
            .get(&index.signing_key)
            .context("The index signing key is not trusted")?;
        trust::verify(key, &bytes, &sig)?;
        let mut versions = BTreeSet::new();
        for artifact in &index.modules {
            ensure!(
                crate::manifest::identifier(&artifact.id)
                    && trust::valid_digest(&artifact.digest)
                    && artifact.size <= crate::archive::MAX_PACKAGE
                    && versions.insert((&artifact.id, &artifact.version)),
                "An index package entry is invalid or repeated"
            );
            trust.verify_package(
                &artifact.publisher_key,
                &artifact.id,
                &artifact.digest,
                &artifact.signature,
            )?;
        }
        seen.accept(&index, &bytes, &trust)?;
        let documents = BTreeMap::from([
            ("registry.json".into(), identity),
            ("registry.json.sig".into(), root_signature),
            ("index.json".into(), bytes),
            ("index.json.sig".into(), sig.into_bytes()),
        ]);
        Ok(Self {
            trust,
            index,
            source,
            documents,
        })
    }
    /// Copy verified metadata and content-addressed blobs without changing any signature.
    pub fn mirror(&self, destination: &std::path::Path) -> Result<()> {
        let root = vault::Root::create(destination)?;
        let packages = root.create_subdir("packages")?;
        for artifact in &self.index.modules {
            let bytes = self.source.fetch(
                &format!("packages/{}.mosspkg", artifact.digest),
                artifact.size,
            )?;
            ensure!(
                bytes.len() as u64 == artifact.size && trust::digest(&bytes) == artifact.digest,
                "The mirrored package does not match the index"
            );
            packages.write(&format!("{}.mosspkg", artifact.digest), &bytes)?;
            packages.write(
                &format!("{}.mosspkg.sig", artifact.digest),
                artifact.signature.as_bytes(),
            )?;
        }
        // Metadata is published last, after every referenced package exists.
        for (name, bytes) in &self.documents {
            root.write(name, bytes)?;
        }
        Ok(())
    }
    pub fn select(
        &self,
        id: &str,
        pin: Option<&Version>,
        moss: &Version,
        installed: &BTreeMap<String, Version>,
        seen: &SeenRegistry,
    ) -> Result<&Artifact> {
        ensure!(
            self.index.expires > Utc::now(),
            "This registry index has expired; installed modules keep running"
        );
        let artifact = self
            .index
            .modules
            .iter()
            .filter(|a| {
                a.id == id && a.channel == Channel::Stable && pin.is_none_or(|v| v == &a.version)
            })
            .max_by_key(|a| &a.version)
            .context("This module version is not in the registry")?;
        ensure!(
            !seen.blocked(artifact),
            "This package or its publisher has been blocked"
        );
        ensure!(
            artifact.requires_moss.matches(moss) && artifact.abi == ABI,
            "This module needs a different Moss version"
        );
        for (id, range) in &artifact.requires {
            ensure!(
                installed.get(id).is_some_and(|v| range.matches(v)),
                "A required module is missing or incompatible: {id}"
            );
        }
        Ok(artifact)
    }
    pub fn download(&self, artifact: &Artifact, moss: &Version) -> Result<crate::archive::Package> {
        let path = format!("packages/{}.mosspkg", artifact.digest);
        let bytes = self.source.fetch(&path, artifact.size)?;
        ensure!(
            bytes.len() as u64 == artifact.size,
            "The package size does not match"
        );
        self.trust.verify_package(
            &artifact.publisher_key,
            &artifact.id,
            &artifact.digest,
            &artifact.signature,
        )?;
        let package = crate::archive::Package::read(&bytes, &artifact.digest, moss)?;
        compare_manifest(&package.manifest, artifact)?;
        Ok(package)
    }
}
pub fn compare_manifest(manifest: &Manifest, artifact: &Artifact) -> Result<()> {
    ensure!(
        manifest.id == artifact.id
            && manifest.version == artifact.version
            && manifest.requires_moss == artifact.requires_moss
            && manifest.abi == artifact.abi
            && manifest.capabilities == artifact.capabilities
            && manifest.database.migrations == artifact.migrations
            && manifest.requires == artifact.requires,
        "The package manifest does not match the signed index"
    );
    Ok(())
}
/// Imported lists add modules and pins only. Absence never means removal.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleList {
    pub modules: Vec<ModulePin>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModulePin {
    pub id: String,
    pub registry: String,
    pub version: Option<Version>,
}
impl ModuleList {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= 1024 * 1024, "The module list is too large");
        let list: Self = serde_json::from_slice(bytes)?;
        let mut ids = BTreeSet::new();
        for item in &list.modules {
            ensure!(
                crate::manifest::identifier(&item.id)
                    && crate::manifest::identifier(&item.registry)
                    && ids.insert(&item.id),
                "Invalid or repeated module list entry"
            );
        }
        Ok(list)
    }
}
pub fn same_publisher(catalogs: &[&Catalog], id: &str) -> Result<()> {
    let mut publisher = None;
    for catalog in catalogs {
        for artifact in catalog.index.modules.iter().filter(|a| a.id == id) {
            let key = &catalog.trust.publisher(&artifact.publisher_key, id)?.key;
            if publisher.is_some_and(|old| old != key) {
                bail!("Registries disagree about who publishes this module");
            }
            publisher = Some(key);
        }
    }
    Ok(())
}
