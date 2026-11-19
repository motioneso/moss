//! The trusted host's data-removal hook. Never exposed as a guest capability.
use crate::pairing::PairingStore;

impl moss_module_host::purge_hooks::PurgeHook for PairingStore {
    fn purge(&self) -> anyhow::Result<()> {
        // Installer is synchronous and can itself be on a runtime. Execute off that thread.
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let rt = tokio::runtime::Runtime::new()?;
                    rt.block_on(self.revoke_all_devices())?;
                    Ok(())
                })
                .join()
                .map_err(|_| anyhow::anyhow!("Device cleanup stopped"))?
        })
    }
}
