//! Ephemeral local registry for real package selection/download in the UI check.
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    manifest::Manifest,
    registry::{Artifact, Channel, Index},
    trust::{self, Publisher, RegistryIdentity},
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub fn write(folder: &Path, bytes: &[u8], manifest: &Manifest) -> Result<(String, String)> {
    fn key() -> Result<Ed25519KeyPair> {
        let bytes = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| anyhow::anyhow!("Create ephemeral signing key"))?;
        Ed25519KeyPair::from_pkcs8(bytes.as_ref())
            .map_err(|_| anyhow::anyhow!("Open ephemeral signing key"))
    }
    let root = key()?;
    let online = key()?;
    let publisher = key()?;
    let public = |key: &Ed25519KeyPair| STANDARD.encode(key.public_key().as_ref());
    let digest = trust::digest(bytes);
    let identity = RegistryIdentity {
        id: "tasks-ui-check".into(),
        name: "Temporary Tasks check".into(),
        root_fingerprint: trust::digest(root.public_key().as_ref()),
        index_keys: BTreeMap::from([("online".into(), public(&online))]),
        publishers: BTreeMap::from([(
            "tasks".into(),
            Publisher {
                key: public(&publisher),
                prefix: String::new(),
                replaces: BTreeSet::new(),
            },
        )]),
        lifted_revocations: BTreeSet::new(),
    };
    let artifact = Artifact {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        digest: digest.clone(),
        size: bytes.len() as u64,
        publisher_key: "tasks".into(),
        signature: STANDARD.encode(publisher.sign(digest.as_bytes()).as_ref()),
        requires_moss: manifest.requires_moss.clone(),
        abi: manifest.abi.clone(),
        capabilities: manifest.capabilities.clone(),
        migrations: manifest.database.migrations.clone(),
        requires: manifest.requires.clone(),
        changelog: "Tasks package screen check".into(),
        channel: Channel::Stable,
        urgent: false,
    };
    let index = Index {
        serial: 1,
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: vec![artifact],
        revoked: vec![],
    };
    std::fs::create_dir_all(folder.join("packages"))?;
    for (name, data, signer) in [
        ("registry.json", serde_json::to_vec(&identity)?, &root),
        ("index.json", serde_json::to_vec(&index)?, &online),
    ] {
        std::fs::write(folder.join(name), &data)?;
        std::fs::write(
            folder.join(format!("{name}.sig")),
            STANDARD.encode(signer.sign(&data).as_ref()),
        )?;
    }
    std::fs::write(folder.join(format!("packages/{digest}.mosspkg")), bytes)?;
    Ok((public(&root), public(&publisher)))
}

/// Optional synthetic account setup, only for the disposable signed-UI fixture.
/// Product code still reads the saved preference through the public host port.
pub fn seed_locale(access: &access_context::AccessContext) -> Result<()> {
    let Ok(zone) = std::env::var("TASKS_UI_TIMEZONE") else {
        return Ok(());
    };
    anyhow::ensure!(
        std::env::var("JARVIS_GATE_RUN").as_deref() == Ok("1"),
        "Use verify-gate"
    );
    tokio::runtime::Runtime::new()?.block_on(async {
        let (db, connection) = tokio_postgres::connect(
            &std::env::var("TASKS_UI_BOOTSTRAP_URL")?, tokio_postgres::NoTls
        ).await?;
        tokio::spawn(async move { let _ = connection.await; });
        db.execute(
            "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale',$2) ON CONFLICT(owner_user_id,key) DO UPDATE SET value_json=EXCLUDED.value_json",
            &[&access.actor_user_id(), &serde_json::json!({"timezone":zone})]
        ).await?;
        println!("Synthetic signed-UI account saved timezone initialized");
        Ok(())
    })
}
