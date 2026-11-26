//! One refresh pass owns source transfers and updates; catalog projection uses saved metadata.
use crate::{
    module_admin::{self, Admin},
    module_sources, modules,
};
use anyhow::{Context, Result};
use moss_network::config::{private_read, private_write};
use safety_core::access::AccessContext;
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const CLOCK: &str = "module-refresh.json";
const DAY: u64 = 24 * 60 * 60;
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Clock {
    last_attempt: u64,
}
#[derive(Clone, Default, Serialize)]
pub(crate) struct Report {
    sources: Vec<SourceResult>,
}
#[derive(Clone, Serialize)]
struct SourceResult {
    id: String,
    error: Option<&'static str>,
}
impl Report {
    pub(crate) fn error(&self, id: &str) -> Option<&'static str> {
        self.sources
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.error)
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn clock(instance: &Path) -> Result<Clock> {
    let path = instance.join(CLOCK);
    if !path.exists() {
        return Ok(Clock::default());
    }
    Ok(serde_json::from_slice(
        &private_read(&path).map_err(anyhow::Error::msg)?,
    )?)
}
/// Only configuration authority is used by the scheduler. Module data still uses its caller.
async fn pass(admin: &Admin, slot: &modules::Slot, access: AccessContext) -> Result<Report> {
    modules::host(slot).context("Modules are not ready")?;
    module_admin::require_admin(admin, &access)
        .await
        .map_err(|_| anyhow::anyhow!("Refresh needs configuration authority"))?;
    let instance = admin.instance.clone();
    tokio::task::spawn_blocking(move || {
        let sources = module_sources::read(&instance)?;
        // Persist attempts too: an unreachable source never causes a tight daily retry loop.
        private_write(&instance.join(CLOCK), &serde_json::to_vec(&Clock { last_attempt: now() })?).map_err(anyhow::Error::msg)?;
        let mut report = Report::default();
        for source in sources {
            let result = (|| -> Result<()> {
                // Activation needs the existing short-lived lifecycle service's trusted login.
                // The serving host deliberately cannot provision module roles.
                let result = module_admin::run_json(&instance, &source, &["--refresh-policy".into()], &[], &access.actor_user_id().to_string())
                    .map_err(anyhow::Error::msg)?;
                anyhow::ensure!(result["failed"].as_u64() == Some(0), "Some updates need attention");
                Ok(())
            })();
            if std::env::var_os("JS426_REFRESH_DIAGNOSTICS").is_some() {
                eprintln!("[JS426] refresh result: {result:?}");
            }
            report.sources.push(SourceResult { id: source.id, error: result.err().map(|_| "The registry or its updates could not be refreshed; saved installed modules remain available. Check the source and try again") });
        }
        Ok(report)
    }).await?
}
async fn run(admin: &Admin, slot: &modules::Slot, access: AccessContext) -> Result<Report> {
    let result = pass(admin, slot, access).await;
    *admin
        .refresh_report
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = result.as_ref().ok().cloned();
    admin.refresh_generation.fetch_add(1, Ordering::Release);
    result
}
/// Overlapping opens/start/daily events share the pass already in flight.
pub(crate) async fn open(
    admin: &Admin,
    slot: &modules::Slot,
    access: &AccessContext,
) -> Result<Report> {
    let generation = admin.refresh_generation.load(Ordering::Acquire);
    let _gate = admin.gate.lock().await;
    if generation != admin.refresh_generation.load(Ordering::Acquire) {
        return admin
            .refresh_report
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .context("The refresh failed; try again");
    }
    run(admin, slot, access.clone()).await
}
/// An authenticated shell open signals the same configuration-only check as the scheduler.
/// Registry failure must not delay or prevent loading the account's shell.
pub(crate) fn app_open(admin: Arc<Admin>, slot: modules::Slot) {
    if modules::host(&slot).is_none() {
        return;
    }
    tokio::spawn(async move {
        let actor = modules::read_settings(&admin.instance.join("modules.json"))
            .ok()
            .and_then(|s| s.admin_user_id);
        if let Some(actor) = actor {
            let _ = open(
                &admin,
                &slot,
                &AccessContext::new(actor, "module-registry-app-open"),
            )
            .await;
        }
    });
}
pub(crate) fn start(admin: Arc<Admin>, slot: modules::Slot, stop: Arc<AtomicBool>) {
    tokio::spawn(async move {
        let mut started = false;
        while !stop.load(Ordering::Relaxed) {
            let ready = slot.lock().unwrap_or_else(|e| e.into_inner()).is_some();
            if ready {
                let _gate = admin.gate.lock().await;
                let due = !started
                    || clock(&admin.instance)
                        .is_ok_and(|c| now().saturating_sub(c.last_attempt) >= DAY);
                if due {
                    // Startup and open may overlap while the host becomes ready.
                    let generation = admin.refresh_generation.load(Ordering::Acquire);
                    if !started && generation > 0 {
                        started = true;
                    } else {
                        let actor = modules::read_settings(&admin.instance.join("modules.json"))
                            .ok()
                            .and_then(|s| s.admin_user_id);
                        if let Some(actor) = actor {
                            if run(
                                &admin,
                                &slot,
                                AccessContext::new(actor, "module-registry-schedule"),
                            )
                            .await
                            .is_ok()
                            {
                                started = true;
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(if started { 60 } else { 1 })).await;
        }
    });
}
