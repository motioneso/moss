//! `moss-shell install-module`: puts signed modules from a registry into an instance, with no
//! hand-made setup. It prepares the module tables, records the instance owner in the instance's
//! module settings and installs. A server running on the instance picks the result up by itself.
use crate::modules;
use anyhow::{bail, Context, Result};
use moss_module_host::registry::{Artifact, Source};
use moss_network::config::{private_read, private_write};
use safety_core::{
    access::AccessContext,
    db::{Database, RuntimeRole},
};
use std::path::PathBuf;

const USAGE: &str = "usage: moss-shell install-module --instance DIR --registry-id ID \
(--registry-folder DIR | --registry-url URL) --root-key KEY --first-party-key KEY [--approve] MODULE...";

struct Args {
    instance: PathBuf,
    registry_id: String,
    source: Source,
    root_key: String,
    first_party_key: String,
    approve: bool,
    modules: Vec<String>,
}

fn parse(raw: Vec<String>) -> Result<Args> {
    let (mut instance, mut id, mut source, mut root, mut first) = (None, None, None, None, None);
    let (mut approve, mut modules) = (false, vec![]);
    let mut raw = raw.into_iter();
    while let Some(flag) = raw.next() {
        if flag == "--approve" {
            approve = true;
        } else if let Some(name) = flag.strip_prefix("--") {
            let value = raw
                .next()
                .with_context(|| format!("{flag} needs a value"))?;
            match name {
                "instance" => instance = Some(PathBuf::from(value)),
                "registry-id" => id = Some(value),
                "registry-folder" => source = Some(Source::Folder(value.into())),
                "registry-url" => {
                    source = Some(Source::Https {
                        base: value.parse().context("Invalid registry address")?,
                        allow_private: false,
                        certificate_pem: None,
                    })
                }
                "root-key" => root = Some(value),
                "first-party-key" => first = Some(value),
                _ => bail!("unknown option {flag}\n{USAGE}"),
            }
        } else {
            modules.push(flag);
        }
    }
    let need = |what: &str| anyhow::anyhow!("missing {what}\n{USAGE}");
    if modules.is_empty() {
        return Err(need("module name"));
    }
    Ok(Args {
        instance: instance.ok_or_else(|| need("--instance"))?,
        registry_id: id.ok_or_else(|| need("--registry-id"))?,
        source: source.ok_or_else(|| need("--registry-folder or --registry-url"))?,
        root_key: root.ok_or_else(|| need("--root-key"))?,
        first_party_key: first.ok_or_else(|| need("--first-party-key"))?,
        approve,
        modules,
    })
}

/// The module tables each have one table that proves they exist, so a second run is a no-op.
fn bootstrap_steps() -> [(&'static str, &'static str); 4] {
    [
        (
            "moss_modules.catalog",
            moss_module_host::postgres::MIGRATION,
        ),
        (
            "moss_modules.migrations",
            moss_module_host::migrations::MIGRATION,
        ),
        ("moss_queue.jobs", moss_module_host::jobs::QUEUE_MIGRATION),
        (
            "moss_modules.paused_modules",
            moss_module_host::jobs::MIGRATION,
        ),
    ]
}

/// Creates the module tables that are missing and returns the instance owner's id.
async fn prepare_database(migrations_url: &str) -> Result<uuid::Uuid> {
    let (db, connection) = tokio_postgres::connect(migrations_url, tokio_postgres::NoTls)
        .await
        .map_err(|_| anyhow::anyhow!("Cannot reach the instance database"))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    for (marker, sql) in bootstrap_steps() {
        let present = db
            .query_one("SELECT to_regclass($1) IS NOT NULL", &[&marker])
            .await?
            .get::<_, bool>(0);
        if !present {
            db.batch_execute(sql).await?;
        }
    }
    let owner = db
        .query_opt(
            "SELECT id::text FROM app.users ORDER BY is_instance_admin DESC, created_at LIMIT 1",
            &[],
        )
        .await?
        .context("Create the owner account first, then install modules")?;
    Ok(owner.get::<_, String>(0).parse()?)
}

pub fn run(raw: Vec<String>) -> Result<()> {
    let args = parse(raw)?;
    let file = args.instance.join("modules.json");
    let runtime = tokio::runtime::Runtime::new()?;
    let settings = modules::read_settings(&file)?;
    let owner = runtime.block_on(prepare_database(&settings.migrations_url))?;
    // Record the owner so the server's host can open. The server may already be waiting.
    let mut stored: serde_json::Value =
        serde_json::from_slice(&private_read(&file).map_err(anyhow::Error::msg)?)?;
    stored["admin_user_id"] = serde_json::json!(owner);
    private_write(&file, stored.to_string().as_bytes()).map_err(anyhow::Error::msg)?;
    let settings = modules::read_settings(&file)?;
    let database = runtime
        .block_on(Database::connect(
            &settings.producer_url,
            4,
            RuntimeRole::App,
        ))
        .map_err(|_| anyhow::anyhow!("Cannot reach the instance database"))?;
    let application = modules::application(settings, database)?;
    let access = AccessContext::new(owner, "module-install");
    let catalog = application.installer.refresh(
        &access,
        args.source.clone(),
        &args.root_key,
        &args.first_party_key,
        &args.registry_id,
    )?;
    for name in &args.modules {
        let artifact: Artifact = catalog
            .index
            .modules
            .iter()
            .filter(|a| &a.id == name)
            .max_by(|a, b| a.version.cmp(&b.version))
            .cloned()
            .with_context(|| format!("{name} is not in the registry"))?;
        application
            .installer
            .install(&access, &catalog, &artifact, args.approve)
            .with_context(|| format!("Installing {name}"))?;
        println!("installed {name} {}", artifact.version);
    }
    drop(application);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &str) -> Vec<String> {
        text.split(' ').map(str::to_owned).collect()
    }

    #[test]
    fn a_full_command_parses() {
        let args = parse(words(
            "--instance /x --registry-id r --registry-folder /reg --root-key a --first-party-key b --approve people",
        ))
        .unwrap();
        assert!(args.approve);
        assert_eq!(args.modules, ["people"]);
    }

    #[test]
    fn missing_pieces_and_unknown_options_are_refused() {
        assert!(parse(words("--instance /x people")).is_err());
        assert!(parse(words("--bogus 1 people")).is_err());
        assert!(parse(words(
            "--instance /x --registry-id r --registry-folder /reg --root-key a --first-party-key b"
        ))
        .is_err());
    }

    #[test]
    fn every_bootstrap_step_has_a_distinct_marker() {
        let steps = bootstrap_steps();
        for (i, (marker, sql)) in steps.iter().enumerate() {
            assert!(!sql.is_empty());
            assert!(steps[i + 1..].iter().all(|(other, _)| other != marker));
        }
    }
}
