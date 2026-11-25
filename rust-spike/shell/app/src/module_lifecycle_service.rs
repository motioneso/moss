//! Runs only in the synchronous, short-lived migration child. Registry availability is
//! irrelevant to removal and restore; the installed catalog and snapshots are authoritative.
use crate::{
    module_install,
    module_operation::{self, Record},
    modules,
};
use anyhow::{ensure, Context, Result};
use moss_module_host::application::Application;
use moss_shell_contract::module_management::{
    LifecycleAction, ModuleOperationStage, ModuleSnapshot,
};
use safety_core::{
    access::AccessContext,
    db::{DataContext, Database, RuntimeRole},
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

fn with_application<T>(
    instance: &Path,
    actor: uuid::Uuid,
    action: impl FnOnce(&Application, &AccessContext) -> Result<T>,
) -> Result<T> {
    let runtime = tokio::runtime::Runtime::new()?;
    let mut settings = modules::read_settings(&instance.join("modules.json"))?;
    let access = AccessContext::new(actor, "module-lifecycle");
    let database = runtime
        .block_on(Database::connect(
            &settings.producer_url,
            4,
            RuntimeRole::App,
        ))
        .map_err(anyhow::Error::msg)?;
    // Authorization uses the session actor, not the settings' original bootstrap owner.
    runtime.block_on(async {
        let cx = DataContext::open(&database, &access)
            .await
            .map_err(|_| anyhow::anyhow!("Cannot check administrator permission"))?;
        let row = cx
            .db()
            .query_opt(
                "SELECT is_instance_admin FROM app.get_user_by_id($1::uuid)",
                &[&actor],
            )
            .await?;
        ensure!(
            row.is_some_and(|r| r.get::<_, bool>(0)),
            "Only an instance administrator can manage modules"
        );
        cx.commit()
            .await
            .map_err(|_| anyhow::anyhow!("Cannot finish administrator check"))?;
        Ok::<_, anyhow::Error>(())
    })?;
    settings.migrations_url = std::env::var(module_install::INSTALL_URL_VARIABLE)
        .context("The lifecycle service needs its one-shot migration login")?;
    runtime.block_on(module_install::prepare_host_schema(
        &settings.migrations_url,
    ))?;
    settings.admin_user_id = Some(actor);
    // Meetings owns a cleanup hook for device credentials in core tables. Use the same
    // auth adapter as the serving host; it is part of the existing snapshot/restore boundary.
    let config = moss_network::config::Config::read(&instance.join("network.json"))
        .map_err(anyhow::Error::msg)?;
    let platform = runtime
        .block_on(config.platform())
        .map_err(anyhow::Error::msg)?;
    moss_module_host::purge_hooks::set_purge_hook(
        "meetings",
        Arc::new(moss_meetings_host::pairing::PairingStore::new(
            platform.auth.clone(),
        )),
    );
    let application = modules::application(settings, database)?;
    action(&application, &access)
}

/// Only authored lifecycle reasons reach browser-readable records. Database and filesystem
/// error details stay out of this projection.
fn reason(error: &anyhow::Error) -> &'static str {
    match error.to_string().as_str() {
        "Type the module name to delete every account's data" => {
            "Type the module name to delete every account's data"
        }
        "The snapshot has expired" => "The snapshot has expired; snapshots are kept for 30 days",
        "The snapshot is unavailable" => "The snapshot is unavailable; choose a current snapshot",
        "Confirm the module name and that newer writes will be lost" => {
            "Confirm the module name and that newer writes will be lost"
        }
        "This module is part of Moss and cannot be removed" => {
            "This module is part of Moss and cannot be removed"
        }
        "Remove dependent modules first" => "Remove dependent modules first",
        "This module has no installed code or retained data" => {
            "This module has no installed code or retained data"
        }
        "Module is unavailable for this account" => "Module is unavailable for this account",
        _ => "The module change failed; read the installed state before trying again",
    }
}
fn perform(instance: &Path, actor: uuid::Uuid, record: &mut Record) -> Result<()> {
    let request = record
        .view
        .lifecycle
        .clone()
        .context("Missing lifecycle request")?;
    let saved = record
        .lifecycle
        .clone()
        .context("Missing lifecycle confirmation")?;
    with_application(instance, actor, |application, access| {
        // Opening the application recovers the host journal before any result is decided.
        let (revision, installed, current) = application
            .installer
            .lifecycle_status(access, &request.module)?;
        if let Some(before) = saved.before_revision {
            let committed = revision == before + 1
                && match request.action {
                    LifecycleAction::Remove => !installed && current.is_some(),
                    LifecycleAction::DeleteData => !installed && current.is_none(),
                    LifecycleAction::Restore => {
                        installed
                            && current
                                .as_ref()
                                .is_some_and(|m| Some(&m.digest) == saved.expected_digest.as_ref())
                    }
                };
            return record.finish(instance, if committed {
                Ok("The module change completed before the interruption")
            } else if revision == before {
                Err("The interrupted change was rolled back; the module was left as it was")
            } else {
                Err("The interrupted change was recovered; check the current module state before trying again")
            });
        }
        let snapshot = if request.action == LifecycleAction::Restore {
            Some(application.installer.snapshot_for_restore(
                access,
                &request.module,
                request.snapshot.as_deref().context("Choose a snapshot")?,
            )?)
        } else {
            None
        };
        let lifecycle = record.lifecycle.as_mut().unwrap();
        lifecycle.before_revision = Some(revision);
        lifecycle.expected_digest = snapshot
            .as_ref()
            .and_then(|s| s.previous.as_ref())
            .map(|m| m.digest.clone());
        record.stage(instance, ModuleOperationStage::Installing)?;
        let outcome = match request.action {
            LifecycleAction::Remove => application.installer.remove(access, &request.module, None),
            LifecycleAction::DeleteData => {
                application
                    .installer
                    .remove(access, &request.module, Some(&saved.typed_name))
            }
            LifecycleAction::Restore => application.installer.restore_snapshot(
                access,
                snapshot.as_ref().unwrap(),
                &saved.typed_name,
                saved.acknowledge_data_loss,
            ),
        };
        let success = match request.action {
            LifecycleAction::Remove => {
                "The module was removed; its data was kept for reinstallation"
            }
            LifecycleAction::DeleteData => {
                "The module and its data were removed; a snapshot is kept for 30 days"
            }
            LifecycleAction::Restore => "The snapshot was restored for every account",
        };
        if outcome.is_err() {
            application.installer.recover_lifecycle()?;
        }
        record.finish(instance, outcome.as_ref().map(|_| success).map_err(reason))
    })
}
pub fn run(raw: Vec<String>) -> Result<()> {
    let mut args = raw.into_iter();
    let (mut instance, mut actor, mut operation, mut snapshots) = (None, None, None, false);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--instance" => {
                instance = Some(PathBuf::from(args.next().context("Missing instance")?))
            }
            "--actor" => {
                actor = Some(
                    args.next()
                        .context("Missing session actor")?
                        .parse::<uuid::Uuid>()?,
                )
            }
            "--operation" => operation = Some(args.next().context("Missing operation")?),
            "--snapshots" => snapshots = true,
            _ => anyhow::bail!("Unknown lifecycle option"),
        }
    }
    let instance = instance.context("Missing instance")?;
    let actor = actor.context("Missing session actor")?;
    let instance_lock = module_operation::lock_file(&instance.join("module-install.lock"))?;
    instance_lock.lock()?;
    if snapshots {
        ensure!(operation.is_none(), "Choose one lifecycle command");
        let metadata = with_application(&instance, actor, |application, access| {
            Ok(application
                .installer
                .snapshots(access)?
                .into_iter()
                .map(|s| ModuleSnapshot {
                    version: s
                        .previous
                        .as_ref()
                        .map(|m| m.manifest.version.to_string())
                        .unwrap_or_default(),
                    name: s
                        .previous
                        .as_ref()
                        .map(|m| m.manifest.name.clone())
                        .unwrap_or_default(),
                    module: s.module,
                    id: s.id,
                    created: s.created.to_rfc3339(),
                    expires: s.expires.to_rfc3339(),
                    reason: s.reason,
                })
                .collect::<Vec<_>>())
        })?;
        println!("{}", serde_json::to_string(&metadata)?);
        return Ok(());
    }
    let id = operation.context("Missing operation")?;
    let lock = module_operation::operation_lock(&instance, &id)?;
    lock.lock()?;
    let mut record = Record::read(&instance, &id)?;
    ensure!(
        record.actor == actor.to_string()
            && record.lifecycle.is_some()
            && record.view.review.is_none(),
        "Operation belongs to another account or service"
    );
    if !record.view.stage.terminal() {
        let outcome = perform(&instance, actor, &mut record);
        if let Err(error) = outcome {
            // Before any data change, refusals are final. Once a change has started, leave
            // recovery pending if the service could not open/recover the host.
            if record.lifecycle.as_ref().unwrap().before_revision.is_none() {
                record.finish(&instance, Err(reason(&error)))?;
            } else {
                return Err(error);
            }
        }
    }
    println!("{}", serde_json::to_string(&record.view)?);
    Ok(())
}
