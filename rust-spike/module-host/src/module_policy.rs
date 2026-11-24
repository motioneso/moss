//! Install configuration and account choices have independent persistence and authority.
use crate::store::Installer;
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePolicy {
    pub automatic: bool,
    pub quiet_time: bool,
}
impl Default for UpdatePolicy {
    fn default() -> Self {
        Self {
            automatic: true,
            quiet_time: false,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchState {
    pub enabled: bool,
    pub on_for_everyone: bool,
    pub blocked: bool,
    pub digest: String,
}
impl Installer {
    pub fn switch_state(&self, access: &AccessContext, id: &str) -> Result<SwitchState> {
        let _fence = self
            .fence
            .read()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(false)?;
        let state = self.catalog.load()?;
        let module = state.installed.get(id).context("Module is not installed")?;
        ensure!(
            module.visible_to(access),
            "Module is unavailable for this account"
        );
        Ok(SwitchState {
            enabled: self.lifecycle.account_enabled(
                id,
                access,
                module.manifest.accounts.default_enabled,
            )?,
            on_for_everyone: module.disabled.is_none(),
            blocked: module.is_blocked(),
            digest: module.digest.clone(),
        })
    }
    pub fn set_server_enabled(
        &self,
        access: &AccessContext,
        id: &str,
        enabled: bool,
    ) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        let module = state
            .installed
            .get_mut(id)
            .context("Module is not installed")?;
        ensure!(
            module.local_owner.is_none(),
            "Private modules have no server switch"
        );
        module.disabled = if enabled {
            None
        } else {
            Some("Turned off by an administrator".into())
        };
        state.revision += 1;
        self.catalog.commit(revision, &state)?;
        self.reconcile_module_runtime(id, state.installed.get(id))
    }
    pub fn update_policy(&self, access: &AccessContext) -> Result<UpdatePolicy> {
        self.admin(access)?;
        Ok(self.catalog.load()?.update_policy)
    }
    pub fn set_update_policy(&self, access: &AccessContext, policy: UpdatePolicy) -> Result<()> {
        self.admin(access)?;
        let _fence = self
            .fence
            .write()
            .map_err(|_| anyhow::anyhow!("Module changes are busy"))?;
        let _disk = self.disk_lock(true)?;
        let mut state = self.catalog.load()?;
        let revision = state.revision;
        state.update_policy = policy;
        state.revision += 1;
        self.catalog.commit(revision, &state)
    }
}
