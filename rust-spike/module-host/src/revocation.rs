//! Install-wide registry policy, independent of the manual administrator switch.
use crate::{
    registry::RevocationLevel,
    store::{Installed, Installer, State},
};
use access_context::AccessContext;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedRevocation {
    pub source: String,
    pub target: String,
    pub reason: String,
    pub level: RevocationLevel,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activity {
    pub at: chrono::DateTime<chrono::Utc>,
    pub module: String,
    pub digest: String,
    pub source: String,
    pub target: String,
    pub reason: String,
    pub level: RevocationLevel,
    pub action: ActivityAction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityAction {
    Revoked,
    Lifted,
}
impl Activity {
    fn policy(module: &Installed, revocation: &AppliedRevocation, action: ActivityAction) -> Self {
        Self {
            at: chrono::Utc::now(),
            module: module.manifest.id.clone(),
            digest: module.digest.clone(),
            source: revocation.source.clone(),
            target: revocation.target.clone(),
            reason: revocation.reason.clone(),
            level: revocation.level.clone(),
            action,
        }
    }
}
impl Installed {
    pub fn is_blocked(&self) -> bool {
        self.disabled.is_some()
            || self
                .revocations
                .iter()
                .any(|r| r.level == RevocationLevel::Block)
    }
}
impl State {
    pub(crate) fn apply_revocations(&mut self) -> bool {
        let mut changed = false;
        for installed in self.installed.values_mut() {
            let next: Vec<_> = self
                .registries
                .get(&installed.registry)
                .into_iter()
                .flat_map(|seen| {
                    seen.revocations.values().filter(|r| {
                        seen.targets_package(
                            &r.target,
                            &installed.digest,
                            &installed.publisher_key,
                            &installed.publisher_public_key,
                        )
                    })
                })
                .map(|r| AppliedRevocation {
                    source: installed.registry.clone(),
                    target: r.target.clone(),
                    reason: r.reason.clone(),
                    level: r.level.clone(),
                })
                .collect();
            // Migrate the old derived flag; new manual switches never use this text.
            if installed.disabled.as_deref()
                == Some("The registry blocked this module or publisher")
            {
                installed.disabled = None;
                changed = true;
            }
            if installed.revocations != next {
                for previous in &installed.revocations {
                    if !next
                        .iter()
                        .any(|r| r.source == previous.source && r.target == previous.target)
                    {
                        self.activity.push(Activity::policy(
                            installed,
                            previous,
                            ActivityAction::Lifted,
                        ));
                    }
                }
                for current in &next {
                    if !installed.revocations.contains(current) {
                        self.activity.push(Activity::policy(
                            installed,
                            current,
                            ActivityAction::Revoked,
                        ));
                    }
                }
                installed.revocations = next;
                changed = true;
            }
        }
        // Keep a bounded recent journal, persisted atomically with the policy it describes.
        if self.activity.len() > 256 {
            self.activity.drain(..self.activity.len() - 256);
        }
        changed
    }
}
impl Installer {
    pub fn activity(&self, access: &AccessContext) -> Result<Vec<Activity>> {
        self.admin(access)?;
        Ok(self.catalog.load()?.activity)
    }

    pub(crate) fn reconcile_runtime(&self, state: &State) -> Result<()> {
        for (id, module) in &state.installed {
            self.reconcile_module_runtime(id, Some(module))?;
        }
        Ok(())
    }
    pub(crate) fn reconcile_module_runtime(
        &self,
        id: &str,
        module: Option<&Installed>,
    ) -> Result<()> {
        if module.is_some_and(Installed::is_blocked) {
            self.lifecycle.pause_jobs(id)
        } else {
            self.lifecycle.resume_jobs(id)
        }
    }
}

impl Installer {
    /// Configuration activity for modules visible to this account, never other builders' records.
    pub fn activity_for(&self, access: &AccessContext) -> Result<Vec<Activity>> {
        let state = self.catalog.load()?;
        Ok(state
            .activity
            .into_iter()
            .filter(|entry| {
                state
                    .installed
                    .get(&entry.module)
                    .is_some_and(|m| m.visible_to(access))
            })
            .collect())
    }
}
