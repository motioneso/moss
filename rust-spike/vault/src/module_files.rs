//! Host-owned module data uses the account folder layout, while lifecycle snapshots still
//! need a plain confined Root. Canonical account vaults continue to require Vaults.
use crate::{AccessContext, Root, VaultContext, VaultError};

impl VaultContext {
    /// Scope a host-owned module data root to the authenticated account. A plain Root
    /// cannot enter a registered canonical vault, including through this constructor.
    pub fn for_module_files(root: &Root, access: &AccessContext) -> Result<Self, VaultError> {
        Ok(Self { root: root.create_subdir(&access.actor_user_id().to_string())? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn module_files_are_account_scoped_and_cannot_enter_a_canonical_vault() {
        let tmp = tempfile::tempdir().unwrap();
        let root = Root::create(&tmp.path().join("modules")).unwrap();
        let a = AccessContext::new("10000000-0000-4000-8000-000000000001".parse().unwrap(), "a");
        let b = AccessContext::new("10000000-0000-4000-8000-000000000002".parse().unwrap(), "b");
        let first = VaultContext::for_module_files(&root, &a).unwrap();
        first.write("note", b"private").unwrap();
        let second = VaultContext::for_module_files(&root, &b).unwrap();
        assert!(second.read("note").is_err());
        assert!(second.read(&format!("../{}/note", a.actor_user_id())).is_err());
        // A previously opened plain handle must not reopen a now-protected vault.
        let plain = Root::create(&tmp.path().join("vaults")).unwrap();
        let _vaults = crate::Vaults::create(plain.path()).unwrap();
        assert!(VaultContext::for_module_files(&plain, &a).is_err());
    }
}
