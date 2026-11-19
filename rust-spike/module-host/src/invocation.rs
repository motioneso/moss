//! Installed-package invocation and the public non-tool dispatch boundary.
use crate::store::Installer;
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use std::sync::Arc;
impl Installer {
    pub fn call(
        &self,
        id: &str,
        access: AccessContext,
        kind: &str,
        payload: &str,
    ) -> Result<String> {
        ensure!(kind != "tool", "Use the validated chat tool entry points");
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk_lock = self.disk_lock(false)?;
        self.call_unfenced(id, access, kind, payload)
    }
    pub(crate) fn call_unfenced(
        &self,
        id: &str,
        access: AccessContext,
        kind: &str,
        payload: &str,
    ) -> Result<String> {
        ensure!(
            !self.root.path().join("operation.json").exists(),
            "Module recovery must finish before calls resume"
        );
        let state = self.catalog.load()?;
        let installed = state
            .installed
            .get(id)
            .context("This module is not installed")?;
        ensure!(installed.disabled.is_none(), "This module is disabled");
        ensure!(
            self.lifecycle.account_enabled(
                id,
                &access,
                installed.manifest.accounts.default_enabled
            )?,
            "This module is switched off for this account"
        );
        let package = self.read_package(&installed.digest)?;
        let dir = self
            .root
            .subdir("installed")?
            .subdir(id)?
            .subdir(&installed.manifest.version.to_string())?;
        for (path, expected) in &package.files {
            ensure!(
                dir.read(path)? == *expected,
                "The installed module changed on disk and is disabled"
            );
        }
        let wasm = package
            .files
            .get("code/module.wasm")
            .context("This module has no code handler")?;
        self.host.call(
            wasm,
            Arc::new(installed.manifest.clone()),
            access,
            self.ports.clone(),
            kind,
            payload,
        )
    }
}
