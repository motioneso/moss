//! Host-only cleanup for data in core tables that a module must not drop.
use anyhow::Result;
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock, RwLock},
};

pub trait PurgeHook: Send + Sync {
    fn purge(&self) -> Result<()>;
}

type Hooks = RwLock<BTreeMap<&'static str, Arc<dyn PurgeHook>>>;
static HOOKS: OnceLock<Hooks> = OnceLock::new();

/// Registered by the shell before it serves module removal requests.
pub fn set_purge_hook(module_id: &'static str, hook: Arc<dyn PurgeHook>) {
    HOOKS
        .get_or_init(Default::default)
        .write()
        .expect("purge hooks")
        .insert(module_id, hook);
}

pub(crate) fn purge(id: &str) -> Result<()> {
    let hook = HOOKS
        .get_or_init(Default::default)
        .read()
        .expect("purge hooks")
        .get(id)
        .cloned();
    if let Some(hook) = hook {
        hook.purge()?;
    } else {
        // Meetings has data in the core ledger. Silently skipping its hook revives old
        // credentials on reinstall, so a host without the shell wiring must fail closed.
        anyhow::ensure!(
            id != "meetings",
            "Meetings device cleanup is not registered"
        );
    }
    Ok(())
}
