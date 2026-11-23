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

/// Environment variable carrying the elevated database URL for one install run.
pub const INSTALL_URL_VARIABLE: &str = "MOSS_INSTALL_DATABASE_URL";

const USAGE: &str = "usage: moss-shell install-module --instance DIR --registry-id ID \
(--registry-folder DIR | --registry-url URL) --root-key KEY --first-party-key KEY \
[--approve [--version V]| --list | --plan] [MODULE...]
  --list   prints the registry's modules as JSON and installs nothing
  --plan   prints what each MODULE would ask permission for as JSON and installs nothing";

struct Args {
    instance: PathBuf,
    registry_id: String,
    source: Source,
    root_key: String,
    first_party_key: String,
    approve: bool,
    version: Option<String>,
    actor: Option<uuid::Uuid>,
    operation: Option<String>,
    mode: Mode,
    modules: Vec<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Install,
    List,
    Plan,
}

fn parse(raw: Vec<String>) -> Result<Args> {
    let (mut instance, mut id, mut source, mut root, mut first) = (None, None, None, None, None);
    let (mut approve, mut modules, mut mode) = (false, vec![], Mode::Install);
    let mut version = None;
    let mut actor = None;
    let mut operation = None;
    let mut raw = raw.into_iter();
    while let Some(flag) = raw.next() {
        if flag == "--approve" {
            approve = true;
        } else if flag == "--list" {
            mode = Mode::List;
        } else if flag == "--plan" {
            mode = Mode::Plan;
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
                "version" => version = Some(value),
                "actor" => actor = Some(value.parse().context("Invalid actor")?),
                "operation" => operation = Some(value),
                _ => bail!("unknown option {flag}\n{USAGE}"),
            }
        } else {
            modules.push(flag);
        }
    }
    let need = |what: &str| anyhow::anyhow!("missing {what}\n{USAGE}");
    if modules.is_empty() && mode != Mode::List {
        return Err(need("module name"));
    }
    Ok(Args {
        instance: instance.ok_or_else(|| need("--instance"))?,
        registry_id: id.ok_or_else(|| need("--registry-id"))?,
        source: source.ok_or_else(|| need("--registry-folder or --registry-url"))?,
        root_key: root.ok_or_else(|| need("--root-key"))?,
        first_party_key: first.ok_or_else(|| need("--first-party-key"))?,
        approve,
        version,
        actor,
        operation,
        mode,
        modules,
    })
}

/// The module tables each have one table that proves they exist, so a second run is a no-op.
fn bootstrap_steps() -> [(&'static str, &'static str); 5] {
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
        (
            "moss_modules.approvals",
            moss_module_host::approval_port::MIGRATION,
        ),
    ]
}

/// Gives the migration owner the schemas, tables and sequences the steps created. Safe to repeat.
const HAND_OVER: &str = "DO $$ DECLARE r record; BEGIN \
ALTER SCHEMA moss_modules OWNER TO jarvis_migration_owner; \
ALTER SCHEMA moss_queue OWNER TO jarvis_migration_owner; \
FOR r IN SELECT schemaname AS s, tablename AS n FROM pg_tables WHERE schemaname IN ('moss_modules','moss_queue') LOOP \
EXECUTE format('ALTER TABLE %I.%I OWNER TO jarvis_migration_owner', r.s, r.n); END LOOP; \
FOR r IN SELECT sequence_schema AS s, sequence_name AS n FROM information_schema.sequences WHERE sequence_schema IN ('moss_modules','moss_queue') LOOP \
EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO jarvis_migration_owner', r.s, r.n); END LOOP; END $$";

/// The device lookup functions need the companion tables from the core migrations, so they go in after the
/// installs and only when those tables exist. Safe to repeat.
pub(crate) async fn ensure_device_sql(migrations_url: &str) -> Result<()> {
    let (db, connection) = tokio_postgres::connect(migrations_url, tokio_postgres::NoTls)
        .await
        .map_err(|_| anyhow::anyhow!("Cannot reach the instance database"))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let ready = db
        .query_one(
            "SELECT to_regclass('app.companion_recording_attempts') IS NOT NULL \
             AND to_regclass('app.companion_devices_owner') IS NULL",
            &[],
        )
        .await?
        .get::<_, bool>(0);
    if ready {
        db.batch_execute(moss_module_host::companion_devices::MIGRATION)
            .await?;
    }
    Ok(())
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
    // The server opens the host as the migration owner, so it must own what the steps made.
    db.batch_execute(HAND_OVER).await?;
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
    use moss_shell_contract::module_management::ModuleOperationStage;
    let args = parse(raw)?;
    // Every child, including legacy and read-only calls, shares this instance fence.
    let instance_lock =
        crate::module_operation::lock_file(&args.instance.join("module-install.lock"))?;
    instance_lock.lock()?;
    let Some(id) = &args.operation else {
        return run_selected(&args, None);
    };
    let operation_lock = crate::module_operation::operation_lock(&args.instance, id)?;
    operation_lock.lock()?;
    let mut record = crate::module_operation::Record::read(&args.instance, id)?;
    anyhow::ensure!(
        args.actor.is_some_and(|a| a.to_string() == record.actor),
        "The review belongs to another account"
    );
    if record.view.stage.terminal() {
        println!("{}", serde_json::to_string(&record.view)?);
        return Ok(());
    }
    anyhow::ensure!(record.approved, "Approve the reviewed package first");
    let source = crate::module_sources::select(&args.instance, Some(&record.view.review.source))?;
    anyhow::ensure!(
        source.binding()? == record.source_binding
            && source.id == args.registry_id
            && args.modules == [record.view.review.module.clone()],
        "The source changed; review again"
    );
    record.stage(&args.instance, ModuleOperationStage::Checking)?;
    let result = run_selected(&args, Some(&mut record));
    // Never persist database errors or child environment values in browser-readable results.
    if !record.view.stage.terminal() {
        let failure = match record.view.stage {
            ModuleOperationStage::Checking => "The signed registry or reviewed package could not be checked; review this module again",
            _ => "Module installation failed; check the installed version and review this module again",
        };
        record.finish(
            &args.instance,
            result.as_ref().map(|_| ()).map_err(|_| failure),
        )?;
    }
    println!("{}", serde_json::to_string(&record.view)?);
    Ok(())
}

fn run_selected(
    args: &Args,
    mut operation: Option<&mut crate::module_operation::Record>,
) -> Result<()> {
    let file = args.instance.join("modules.json");
    let runtime = tokio::runtime::Runtime::new()?;
    let mut settings = modules::read_settings(&file)?;
    // Creating module roles needs a stronger login than the stored migration owner. The caller
    // passes it in the environment for this one run; it is never written anywhere.
    if let Ok(url) = std::env::var(INSTALL_URL_VARIABLE) {
        settings.migrations_url = url;
    }
    let database = runtime
        .block_on(Database::connect(
            &settings.producer_url,
            4,
            RuntimeRole::App,
        ))
        .map_err(|_| anyhow::anyhow!("Cannot reach the instance database"))?;
    if let Some(actor) = args.actor {
        runtime.block_on(async {
            let access = AccessContext::new(actor, "module-management-authorization");
            let cx = safety_core::db::DataContext::open(&database, &access)
                .await
                .map_err(|_| anyhow::anyhow!("Cannot check administrator permission"))?;
            let row = cx
                .db()
                .query_opt(
                    "SELECT is_instance_admin FROM app.get_user_by_id($1::uuid)",
                    &[&actor],
                )
                .await?;
            anyhow::ensure!(
                row.is_some_and(|row| row.get::<_, bool>(0)),
                "Only an instance administrator can manage modules"
            );
            Ok::<_, anyhow::Error>(())
        })?;
    }
    let owner = runtime.block_on(prepare_database(&settings.migrations_url))?;
    // Record the owner so the server's host can open. The server may already be waiting.
    let mut stored: serde_json::Value =
        serde_json::from_slice(&private_read(&file).map_err(anyhow::Error::msg)?)?;
    stored["admin_user_id"] = serde_json::json!(owner);
    private_write(&file, stored.to_string().as_bytes()).map_err(anyhow::Error::msg)?;
    let mut settings = modules::read_settings(&file)?;
    if let Ok(url) = std::env::var(INSTALL_URL_VARIABLE) {
        settings.migrations_url = url;
    }
    let migrations_url = settings.migrations_url.clone();
    settings.admin_user_id = Some(args.actor.unwrap_or(owner));
    let application = modules::application(settings, database.clone())?;
    let access = AccessContext::new(args.actor.unwrap_or(owner), "module-install");
    let catalog = application.installer.configure_registry(
        &access,
        &moss_module_host::registry_manager::RegistryConfiguration {
            id: args.registry_id.clone(),
            source: args.source.clone(),
            root_key: args.root_key.clone(),
            first_party_key: args.first_party_key.clone(),
        },
    )?;
    use moss_module_host::{postgres::PostgresCatalog, store::CatalogStore};
    let state = PostgresCatalog::new(database, access.clone())?.load()?;
    if args.mode == Mode::List {
        let installed: std::collections::BTreeSet<String> = application
            .installer
            .export_list()?
            .modules
            .into_iter()
            .map(|m| m.id)
            .collect();
        let modules: Vec<_> = catalog
            .index
            .modules
            .iter()
            .map(|a| {
                serde_json::json!({
                    "id": a.id,
                    "version": a.version.to_string(),
                    "changelog": a.changelog,
                    "installed": installed.contains(&a.id),
                    "source": args.registry_id,
                    "digest": a.digest,
                    "publisher": catalog.trust.publisher(&a.publisher_key, &a.id).map(|p| p.key.clone()).unwrap_or_default(),
                    "installedDigest": state.installed.get(&a.id).map(|m| &m.digest),
                    "capabilities": a.capabilities,
                    "migrations": a.migrations,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::json!({ "registry": args.registry_id, "name": catalog.trust.identity.name, "modules": modules })
        );
        drop(application);
        return Ok(());
    }
    for name in &args.modules {
        let artifact: Artifact = catalog
            .index
            .modules
            .iter()
            .filter(|a| &a.id == name)
            .max_by(|a, b| a.version.cmp(&b.version))
            .cloned()
            .with_context(|| format!("{name} is not in the registry"))?;
        if args.mode == Mode::Plan {
            let moss = "0.1.0".parse()?;
            let package = catalog
                .download(&artifact, &moss)
                .with_context(|| format!("Reading {name}"))?;
            let approval = application.installer.approval(&package, artifact.urgent)?;
            let permissions: Vec<_> = approval
                .new_permissions
                .iter()
                .map(|p| serde_json::json!({ "group": p.group, "headline": p.headline, "details": p.details }))
                .collect();
            println!(
                "{}",
                serde_json::json!({
                    "id": package.manifest.id,
                    "name": package.manifest.name,
                    "description": package.manifest.description,
                    "version": artifact.version.to_string(),
                    "permissions": permissions,
                    "migrations": approval.new_migrations.len(),
                    "review": {
                        "source": args.registry_id,
                        "module": package.manifest.id,
                        "name": package.manifest.name,
                        "description": package.manifest.description,
                        "version": artifact.version.to_string(),
                        "digest": artifact.digest,
                        "previous": state.installed.get(name).map(|m| &m.digest),
                        "capabilities": package.manifest.capabilities,
                        "migrations": package.manifest.database.migrations,
                        "permissions": permissions,
                        "urgent": artifact.urgent,
                    },
                })
            );
            continue;
        }
        if let Some(record) = operation.as_deref_mut() {
            let reviewed = &record.view.review;
            if artifact.digest != reviewed.digest
                || artifact.version.to_string() != reviewed.version
            {
                record.finish(
                    &args.instance,
                    Err("The selected package changed since review; review this module again"),
                )?;
                bail!("The module changed since review; review it again");
            }
            let consent = moss_module_host::store::Consent {
                digest: reviewed.digest.clone(),
                previous: reviewed.previous.clone(),
            };
            record.stage(
                &args.instance,
                moss_shell_contract::module_management::ModuleOperationStage::Installing,
            )?;
            application
                .installer
                .install_reviewed(&access, &catalog, &artifact, &consent)?;
            continue;
        }
        if let Some(reviewed) = &args.version {
            if artifact.version.to_string() != *reviewed {
                bail!("{name} changed in the registry since it was reviewed; review it again");
            }
        }
        application
            .installer
            .install(&access, &catalog, &artifact, args.approve)
            .with_context(|| format!("Installing {name}"))?;
        println!("installed {name} {}", artifact.version);
    }
    drop(application);
    runtime.block_on(ensure_device_sql(&migrations_url))?;
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
