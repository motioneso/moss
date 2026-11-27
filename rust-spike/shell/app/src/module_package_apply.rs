//! One-shot activation over the existing installers. The serving host cannot create module roles.
use crate::{module_admin, module_install, modules};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use safety_core::{
    access::AccessContext,
    db::{DataContext, Database, RuntimeRole},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub package: String,
    pub signature: Value,
    pub source: Option<String>,
}
/// Only authenticated adapters call this; the actor never comes from uploaded input.
pub fn apply(instance: &Path, access: &AccessContext, input: Input) -> Result<()> {
    let url = module_admin::elevated_url(instance).map_err(anyhow::Error::msg)?;
    let mut child = Command::new(std::env::current_exe()?)
        .arg("apply-module-package")
        .arg("--instance")
        .arg(instance)
        .arg(access.actor_user_id().to_string())
        .env(module_install::INSTALL_URL_VARIABLE, url)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let payload = serde_json::to_vec(&input)?;
    let written = child
        .stdin
        .take()
        .context("Missing package pipe")?
        .write_all(&payload);
    if written.is_err() {
        let _ = child.kill();
        let output = child.wait_with_output()?;
        if let Some(error) = module_admin::custody_child_error(&output.stderr) {
            return Err(error.into());
        }
        anyhow::bail!("Package transfer failed");
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        // A key store failure in the child names itself and its remedy.
        // Surface that line instead of the generic failure.
        if let Some(error) = module_admin::custody_child_error(&output.stderr) {
            return Err(error.into());
        }
        anyhow::bail!("Package activation failed");
    }
    Ok(())
}
/// Internal installer entry: keeps the elevated login in one short-lived process.
pub fn run(args: Vec<String>) -> Result<()> {
    // Both spawn forms are accepted: --instance DIR ACTOR, or DIR ACTOR.
    let (instance_arg, actor_arg) = match args.as_slice() {
        [flag, dir, actor] if flag == "--instance" => (dir, actor),
        [dir, actor] => (dir, actor),
        _ => anyhow::bail!("Missing instance or session actor"),
    };
    let instance = std::path::PathBuf::from(instance_arg);
    let actor = actor_arg.parse()?;
    let access = AccessContext::new(actor, "package-activation");
    let mut payload = Vec::new();
    std::io::stdin()
        .take(96 * 1024 * 1024 + 1)
        .read_to_end(&mut payload)?;
    ensure!(payload.len() <= 96 * 1024 * 1024, "Package input too large");
    let input: Input = serde_json::from_slice(&payload)?;
    let bytes = STANDARD.decode(&input.package)?;
    #[cfg(unix)]
    let local_signature = if input.source.is_none() {
        let signature: moss_module_host::local_packages::Signature =
            serde_json::from_value(input.signature.clone())?;
        moss_module_host::local_packages::LocalPackages::host_storage()
            .verify(&access, &bytes, &signature)?;
        Some(signature)
    } else {
        None
    };
    #[cfg(not(unix))]
    ensure!(
        input.source.is_some(),
        "Local signing is unavailable on this platform"
    );
    let _fence = module_install_fence(&instance)?;
    let mut settings = modules::read_settings(&instance.join("modules.json"))?;
    settings.migrations_url = std::env::var(module_install::INSTALL_URL_VARIABLE)
        .context("Missing one-shot installer login")?;
    let rt = tokio::runtime::Runtime::new()?;
    let database = rt
        .block_on(Database::connect(
            &settings.producer_url,
            4,
            RuntimeRole::App,
        ))
        .map_err(|_| anyhow::anyhow!("Cannot reach the instance database"))?;
    if input.source.is_some() {
        rt.block_on(async {
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
                "Package import needs administrator permission"
            );
            Ok::<_, anyhow::Error>(())
        })?;
    }
    rt.block_on(module_install::prepare_host_schema(
        &settings.migrations_url,
    ))?;
    // Preserve the existing configuration actor; it never becomes the local package owner.
    let application = modules::application(settings, database)?;
    match input.source {
        Some(source) => {
            let catalog = application.installer.saved_catalog(&access, &source)?;
            let digest = moss_module_host::trust::digest(&bytes);
            let offer = catalog
                .index
                .modules
                .iter()
                .find(|a| a.digest == digest)
                .context("Package not in trusted registry")?;
            application.installer.import_file(
                &access,
                &catalog,
                &bytes,
                input
                    .signature
                    .as_str()
                    .context("Missing package signature")?
                    .trim(),
                &offer.publisher_key,
                true,
            )?;
        }
        None => {
            #[cfg(unix)]
            application.installer.install_local(
                &access,
                &moss_module_host::local_packages::LocalPackages::host_storage(),
                &bytes,
                &local_signature.context("Missing local signature")?,
                true,
            )?;
        }
    }
    Ok(())
}
fn module_install_fence(instance: &Path) -> Result<std::fs::File> {
    let file = crate::module_operation::lock_file(&instance.join("module-install.lock"))?;
    file.lock()?;
    Ok(file)
}
