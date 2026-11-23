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
        self.call_fenced(id, access, kind, payload)
    }
    /// Installed-package parity harness only. Production builds expose no raw tool entry.
    #[cfg(feature = "test-tool-dispatch")]
    #[doc(hidden)]
    pub fn call_tool_for_test(
        &self,
        id: &str,
        access: AccessContext,
        payload: &str,
    ) -> Result<String> {
        self.call_fenced(id, access, "tool", payload)
    }
    fn call_fenced(
        &self,
        id: &str,
        access: AccessContext,
        kind: &str,
        payload: &str,
    ) -> Result<String> {
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
        self.call_unfenced_with_chat_budget(id, access, kind, payload, false)
    }
    pub(crate) fn call_chat_unfenced(
        &self,
        id: &str,
        access: AccessContext,
        kind: &str,
        payload: &str,
    ) -> Result<String> {
        self.call_unfenced_with_chat_budget(id, access, kind, payload, true)
    }
    fn call_unfenced_with_chat_budget(
        &self,
        id: &str,
        access: AccessContext,
        kind: &str,
        payload: &str,
        chat: bool,
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
        ensure!(!installed.is_blocked(), "This module is disabled");
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
        let call = if chat {
            crate::runtime::Host::call_chat
        } else {
            crate::runtime::Host::call
        };
        call(
            &self.host,
            wasm,
            Arc::new(installed.manifest.clone()),
            access,
            self.ports.clone(),
            kind,
            payload,
        )
    }
}
