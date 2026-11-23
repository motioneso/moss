//! Install-local trust only. Verified records are not activated or registry-reviewed.
use crate::{
    archive::Package,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    trust,
};
use access_context::AccessContext;
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

pub const MIGRATION: &str = include_str!("../sql/0006_local_packages.sql");
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Signature {
    pub installation_id: String,
    pub key_fingerprint: String,
    pub digest: String,
    pub signature: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicTrust {
    pub installation_id: String,
    pub public_key: String,
    pub fingerprint: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub module_id: String,
    pub owner_account_id: String,
    pub digest: String,
    pub provenance: &'static str,
    pub install_key_fingerprint: String,
    pub registry_reviewed: bool,
}
/// Only this module can construct a verified record; catalog writes consume this proof.
pub struct VerifiedLocal {
    record: Record,
    trust: PublicTrust,
}
impl VerifiedLocal {
    pub fn record(&self) -> &Record {
        &self.record
    }
    pub fn trust(&self) -> &PublicTrust {
        &self.trust
    }
}
#[cfg(unix)]
pub struct LocalPackages {
    paths: keystore::store::Paths,
}
#[cfg(unix)]
impl LocalPackages {
    pub fn host_storage() -> Self {
        Self::new(keystore::store::Paths::from_env())
    }
    pub fn new(paths: keystore::store::Paths) -> Self {
        Self { paths }
    }
    fn key(&self, create: bool) -> Result<keystore::store::LocalSigningKey> {
        keystore::store::local_signing_key(&self.paths, create).map_err(anyhow::Error::msg)
    }
    fn identity(key: &keystore::store::LocalSigningKey) -> Result<PublicTrust> {
        let public_key = key.public_key();
        Ok(PublicTrust {
            installation_id: key.installation_id().into(),
            fingerprint: trust::digest(&STANDARD.decode(&public_key)?),
            public_key,
        })
    }
    fn package(access: &AccessContext, bytes: &[u8], digest: &str) -> Result<Package> {
        let package = Package::read(bytes, digest, &"0.1.0".parse()?)?;
        let prefix = format!("local.{}.", access.actor_user_id());
        ensure!(
            package.manifest.id.starts_with(&prefix),
            "Local package owner or prefix does not match the signed-in account"
        );
        ensure!(
            package.manifest.install_wide_kv.is_empty(),
            "Local packages cannot use install-wide storage"
        );
        crate::archive::validate_install(
            &package,
            &Host::new(Limits::default())?,
            &LegacyInventory::default(),
        )?;
        Ok(package)
    }
    pub fn sign(&self, access: &AccessContext, bytes: &[u8]) -> Result<Signature> {
        let digest = trust::digest(bytes);
        Self::package(access, bytes, &digest)?;
        let key = self.key(true)?;
        let identity = Self::identity(&key)?;
        Ok(Signature {
            installation_id: identity.installation_id,
            key_fingerprint: identity.fingerprint,
            signature: key.sign(digest.as_bytes()),
            digest,
        })
    }
    pub fn verify(
        &self,
        access: &AccessContext,
        bytes: &[u8],
        signature: &Signature,
    ) -> Result<VerifiedLocal> {
        let identity = Self::identity(&self.key(false)?)?;
        ensure!(
            signature.installation_id == identity.installation_id,
            "Local package belongs to another install"
        );
        ensure!(
            signature.key_fingerprint == identity.fingerprint,
            "Local package signing key does not match this install"
        );
        trust::verify(
            &identity.public_key,
            signature.digest.as_bytes(),
            &signature.signature,
        )?;
        let package = Self::package(access, bytes, &signature.digest)?;
        Ok(VerifiedLocal {
            record: Record {
                module_id: package.manifest.id,
                owner_account_id: access.actor_user_id().to_string(),
                digest: package.digest,
                provenance: "local",
                install_key_fingerprint: identity.fingerprint.clone(),
                registry_reviewed: false,
            },
            trust: identity,
        })
    }
}

/// Persists verified provenance without registering an executable module. No elevated login
/// or administrator bypass: writes use the authenticated account's data context.
pub async fn record(
    database: &safety_core::db::Database,
    access: &AccessContext,
    verified: &VerifiedLocal,
) -> Result<()> {
    use safety_core::db::DataContext;
    ensure!(
        verified.record.owner_account_id == access.actor_user_id().to_string(),
        "Local package owner changed"
    );
    let cx = DataContext::open(database, access)
        .await
        .map_err(|_| anyhow::anyhow!("Cannot open local package catalog"))?;
    cx.db()
        .query_one(
            "SELECT pg_advisory_xact_lock(hashtext('moss:local-package-trust'))",
            &[],
        )
        .await?;
    let trust = &verified.trust;
    cx.db().execute("INSERT INTO moss_modules.local_trust(installation_id,public_key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", &[&trust.installation_id, &trust.public_key, &trust.fingerprint]).await?;
    let row = cx.db().query_one("SELECT installation_id,public_key,fingerprint FROM moss_modules.local_trust WHERE singleton", &[]).await?;
    ensure!(
        row.get::<_, String>(0) == trust.installation_id
            && row.get::<_, String>(1) == trust.public_key
            && row.get::<_, String>(2) == trust.fingerprint,
        "Catalog local key belongs to another install or key"
    );
    let record = &verified.record;
    cx.db().execute("INSERT INTO moss_modules.local_packages(module_id,owner_account_id,digest,installation_id,install_key_fingerprint) VALUES($1,$2::text::uuid,$3,$4,$5) ON CONFLICT DO NOTHING", &[&record.module_id, &record.owner_account_id, &record.digest, &trust.installation_id, &trust.fingerprint]).await?;
    let row = cx
        .db()
        .query_opt(
            "SELECT digest FROM moss_modules.local_packages WHERE module_id=$1",
            &[&record.module_id],
        )
        .await?;
    ensure!(
        row.is_some_and(|r| r.get::<_, String>(0) == record.digest),
        "Local package already recorded with different bytes"
    );
    cx.commit()
        .await
        .map_err(|_| anyhow::anyhow!("Cannot commit local package provenance"))?;
    Ok(())
}
