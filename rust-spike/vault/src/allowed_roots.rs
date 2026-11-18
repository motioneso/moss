//! Host-selected notes roots, bound to the authenticated account before guest execution.
use crate::{AccessContext, Root, VaultContext, VaultError};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug)]
pub struct AllowedRoots {
    actor: String,
    roots: Vec<PathBuf>,
}

impl AllowedRoots {
    /// Only the host chooses these roots. Module request parameters are never the authority.
    pub fn for_account(access: &AccessContext, roots: Vec<PathBuf>) -> Self {
        Self {
            actor: access.actor_user_id().to_string(),
            roots,
        }
    }
}

impl VaultContext {
    /// Open an existing chosen notes folder. Unlike module storage, this creates no folders.
    pub fn at_allowed_root(
        access: &AccessContext,
        selected: &Path,
        allowed: &AllowedRoots,
    ) -> Result<Self, VaultError> {
        if access.actor_user_id().to_string() != allowed.actor {
            return Err(VaultError::Escape(
                "notes folder is not allowed for this account".into(),
            ));
        }
        validate_absolute(selected)?;
        for allowed_path in &allowed.roots {
            validate_absolute(allowed_path)?;
            let Ok(relative) = selected.strip_prefix(allowed_path) else {
                continue;
            };
            // The host chooses the anchor; guest-selected descendants must pass Root's
            // component checks before opening, rather than being canonicalized through links.
            let anchor = Root::open(allowed_path)?;
            let root = if relative.as_os_str().is_empty() {
                anchor
            } else {
                let relative = relative
                    .to_str()
                    .ok_or_else(|| VaultError::BadPath("notes folder is not valid UTF-8".into()))?;
                anchor.subdir(relative)?
            };
            return Ok(Self { root });
        }
        Err(VaultError::Escape(
            "notes folder is outside the allowed roots".into(),
        ))
    }
}

fn validate_absolute(path: &Path) -> Result<(), VaultError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(VaultError::BadPath(
            "notes folder must be an absolute path without traversal".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Vaults;

    fn actor(n: u8) -> AccessContext {
        AccessContext::new(
            format!("00000000-0000-4000-8000-{n:012}").parse().unwrap(),
            "notes-root-test",
        )
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        selected: PathBuf,
        other: PathBuf,
        allowed: AllowedRoots,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = Root::create(&dir.path().join("notes-a")).unwrap();
        let selected = root.create_subdir("People").unwrap();
        selected.write("alice.md", b"private contact").unwrap();
        let other = Root::create(&dir.path().join("notes-b")).unwrap();
        Fixture {
            selected: selected.path().into(),
            other: other.path().into(),
            allowed: AllowedRoots::for_account(&actor(1), vec![root.path().into()]),
            _dir: dir,
        }
    }

    #[test]
    fn owner_can_read_and_write_existing_chosen_folder() {
        let f = fixture();
        let notes = VaultContext::at_allowed_root(&actor(1), &f.selected, &f.allowed).unwrap();
        assert_eq!(notes.read_to_string("alice.md").unwrap(), "private contact");
        notes.write("alice.md", b"updated contact").unwrap();
        assert_eq!(notes.read_to_string("alice.md").unwrap(), "updated contact");
    }

    #[test]
    fn other_account_cannot_read_notes() {
        let f = fixture();
        let result = VaultContext::at_allowed_root(&actor(2), &f.selected, &f.allowed)
            .and_then(|v| v.read("alice.md"));
        assert!(result.is_err(), "Account B read account A's note");
    }

    #[test]
    fn other_account_cannot_change_notes() {
        let f = fixture();
        let result = VaultContext::at_allowed_root(&actor(2), &f.selected, &f.allowed)
            .and_then(|v| v.write("alice.md", b"changed by B"));
        assert!(result.is_err(), "Account B changed account A's note");
        let owner = VaultContext::at_allowed_root(&actor(1), &f.selected, &f.allowed).unwrap();
        assert_eq!(owner.read_to_string("alice.md").unwrap(), "private contact");
    }

    #[test]
    fn selected_folder_must_be_under_an_allowed_root() {
        let f = fixture();
        assert!(VaultContext::at_allowed_root(&actor(1), &f.other, &f.allowed).is_err());
        let parent = f.selected.join("../People");
        assert!(VaultContext::at_allowed_root(&actor(1), &parent, &f.allowed).is_err());
        assert!(VaultContext::at_allowed_root(&actor(1), Path::new("People"), &f.allowed).is_err());
    }

    #[test]
    fn allowed_root_itself_and_missing_folder() {
        let f = fixture();
        assert!(VaultContext::at_allowed_root(&actor(1), &f.allowed.roots[0], &f.allowed).is_ok());
        let missing = f.selected.join("missing");
        assert!(VaultContext::at_allowed_root(&actor(1), &missing, &f.allowed).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn canonical_private_vault_is_not_an_external_notes_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vaults");
        let vaults = Vaults::create(&path).unwrap();
        VaultContext::for_access(&vaults, &actor(1)).unwrap();
        let allowed = AllowedRoots::for_account(&actor(1), vec![path.clone()]);
        assert!(VaultContext::at_allowed_root(&actor(1), &path, &allowed).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn selected_folder_cannot_traverse_symlinks() {
        let f = fixture();
        let alias = f.allowed.roots[0].join("alias");
        std::os::unix::fs::symlink(&f.other, &alias).unwrap();
        assert!(VaultContext::at_allowed_root(&actor(1), &alias, &f.allowed).is_err());
    }
}
