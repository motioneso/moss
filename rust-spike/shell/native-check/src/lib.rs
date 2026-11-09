//! Type-checks the production desktop API code for each target. This is not a native runtime test.
#[cfg(target_os = "macos")]
#[path = "../../connect/src/desktop/macos.rs"]
pub mod macos;
#[cfg(windows)]
#[path = "../../connect/src/desktop/windows.rs"]
pub mod windows;

#[path = "../../connect/src/desktop/identity.rs"]
mod identity;
