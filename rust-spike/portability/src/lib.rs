//! Phase 0a spike (throwaway). Mirrors the TypeScript app's password, credential and
//! migration-hash rules so the fixtures in `../fixtures` can prove or disprove parity.

#[cfg(any(unix, windows))]
pub mod file_lock;
pub mod js;
pub mod migrations;
pub mod password;
pub mod secrets;
#[cfg(windows)]
pub mod windows_child;
