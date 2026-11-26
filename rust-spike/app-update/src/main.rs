use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Duration, Utc};
use moss_app_update::{load_seen, save_seen, trust, Artifact, Client, Index, MAX_INDEX};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::Deserialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

fn read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "Input too large");
    Ok(bytes)
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}
fn check(args: &[String]) -> Result<()> {
    ensure!(
        args.len() == 6 || args.len() == 7,
        "check FEED KEY_ID PUBLIC_KEY_FILE STATE SCHEMA [ARTIFACT]"
    );
    let folder = Path::new(&args[1]);
    let state = Path::new(&args[4]);
    // Refuse concurrent checks rather than losing the highest observed serial.
    let lock = state.with_extension("lock");
    fs::create_dir(&lock).context("Another update check is active, or its lock needs recovery")?;
    let _lock = Lock(lock);
    let client = Client {
        key_id: args[2].clone(),
        public_key: String::from_utf8(read(Path::new(&args[3]), 1024)?)?
            .trim()
            .into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        schema: args[5].parse()?,
    };
    let (artifact, next) = client.check(
        &read(&folder.join("index.json"), MAX_INDEX)?,
        &String::from_utf8(read(&folder.join("index.json.sig"), 1024)?)?,
        &load_seen(state)?,
        Utc::now(),
    )?;
    if let Some(path) = args.get(6) {
        // Part 7 never fetches, stages or executes this file.
        artifact.verify_bytes(&read(Path::new(path), usize::try_from(artifact.size)?)?)?;
    }
    save_seen(state, &next)?;
    println!("{}", serde_json::to_string(&artifact)?);
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    os: String,
    arch: String,
    version: String,
    url: String,
    file: PathBuf,
    schema_min: u64,
    schema_max: u64,
}
fn release(args: &[String]) -> Result<()> {
    ensure!(
        args.len() == 4 || args.len() == 5,
        "release INPUT_JSON OUT SERIAL [--configured-key]"
    );
    let configured = args.get(4).is_some_and(|s| s == "--configured-key");
    ensure!(args.len() == 4 || configured, "Unknown release option");
    let (id, key) = if configured {
        let id = std::env::var("MOSS_APP_UPDATE_SIGNING_KEY_ID")
            .context("Missing app update signing key ID")?;
        let encoded = std::env::var("MOSS_APP_UPDATE_SIGNING_PRIVATE_KEY")
            .context("Missing app update signing key")?;
        let bytes = STANDARD
            .decode(encoded.trim())
            .map_err(|_| anyhow::anyhow!("Invalid app update key encoding"))?;
        (
            id,
            Ed25519KeyPair::from_pkcs8(&bytes)
                .map_err(|_| anyhow::anyhow!("Invalid app update key"))?,
        )
    } else {
        let bytes = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| anyhow::anyhow!("Could not generate throwaway key"))?;
        (
            "generated-ci".into(),
            Ed25519KeyPair::from_pkcs8(bytes.as_ref())
                .map_err(|_| anyhow::anyhow!("Invalid throwaway key"))?,
        )
    };
    ensure!(!id.is_empty(), "Empty app update key ID");
    let inputs: Vec<Input> = serde_json::from_slice(&read(Path::new(&args[1]), MAX_INDEX)?)?;
    ensure!(!inputs.is_empty(), "No release artifacts");
    let mut artifacts = Vec::new();
    for input in inputs {
        let bytes = fs::read(&input.file)?;
        artifacts.push(Artifact {
            os: input.os,
            arch: input.arch,
            version: input.version,
            url: input.url,
            digest: trust::digest(&bytes),
            size: bytes.len() as u64,
            schema_min: input.schema_min,
            schema_max: input.schema_max,
        });
    }
    let index = Index {
        serial: args[3].parse()?,
        expires: Utc::now() + Duration::days(7),
        signing_key: id.clone(),
        artifacts,
    };
    let bytes = serde_json::to_vec_pretty(&index)?;
    let signature = STANDARD.encode(key.sign(&bytes).as_ref());
    let public = STANDARD.encode(key.public_key().as_ref());
    // Validate every target with the production client before publication.
    for artifact in &index.artifacts {
        let client = Client {
            key_id: id.clone(),
            public_key: public.clone(),
            os: artifact.os.clone(),
            arch: artifact.arch.clone(),
            schema: artifact.schema_min,
        };
        client.check(&bytes, &signature, &Default::default(), Utc::now())?;
    }
    let out = Path::new(&args[2]);
    fs::create_dir(out)?;
    fs::write(out.join("index.json"), bytes)?;
    fs::write(out.join("index.json.sig"), signature)?;
    fs::write(out.join("public-key.txt"), public)?;
    println!("Signed app update index; private key was not written to release output");
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check") => check(&args),
        Some("release") => release(&args),
        _ => bail!("Use check or release"),
    }
}
