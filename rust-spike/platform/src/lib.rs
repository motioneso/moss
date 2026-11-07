//! The safety core of the Rust server (port plan Phase 2, part 1).
//!
//! Every request, job and module install goes through these types.
//!
//! - [`access::AccessContext`] says who is acting, and nothing else.
//! - [`db::Database`] and [`db::DataContext`] are the only way to reach Postgres. Row-level
//!   security applies to every actor, admins included.
//! - [`secret::Secret`] and [`secret::SecretCipher`] hold secrets in memory and at rest.
//! - [`redact`] decides what a log line may carry.
//! - [`payload::JobPayload`] decides what a queued job may carry.
//! - [`module_sql`] decides which module SQL the installer will run.
//! - [`auth`], [`admin`] and [`views`] serve sign-in, account management and the first
//!   private reads; [`http`] mounts them.

pub mod access;
pub mod admin;
pub mod auth;
pub mod db;
pub mod error;
pub mod http;
pub mod module_sql;
pub mod payload;
pub mod queue;
pub mod redact;
pub mod secret;
pub mod views;
