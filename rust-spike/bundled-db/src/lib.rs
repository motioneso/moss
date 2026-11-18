//! Phase 1 spike (throwaway grade). One Rust program owns a private Postgres cluster per
//! install: it creates it, starts it, runs the app's migrations, stops it, and recovers it
//! after a crash. It also reports whether the disk holding the data is encrypted.

pub mod at_rest;
pub mod cluster;
pub mod layout;
pub mod migrate;
#[cfg(unix)]
pub mod procs;
#[cfg(windows)]
#[path = "procs_windows.rs"]
pub mod procs;
pub mod secrets;
pub mod supervisor_lock;

/// Database the app uses inside the private cluster.
pub const APP_DATABASE: &str = "moss";

/// Superuser created by `initdb`. Only the supervisor signs in as it, for bootstrap.
pub const SUPERUSER: &str = "moss_admin";

/// Runtime roles the app's bootstrap SQL creates. None is a superuser or bypasses RLS.
pub const RUNTIME_ROLES: [&str; 4] = [
    "jarvis_migration_owner",
    "jarvis_app_runtime",
    "jarvis_worker_runtime",
    "jarvis_auth_runtime",
];
