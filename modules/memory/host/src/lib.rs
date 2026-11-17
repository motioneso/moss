//! Memory host assembly. Package building lives here; the embedding service and its settings
//! route live in the host application so the credential never reaches the package.
pub mod account;
pub mod dashboard;
pub mod lifecycle;
pub mod package;
pub mod ports;
pub mod recording;
pub mod reembed;
pub mod public;
pub mod store;

pub const MODULE_ID: &str = "memory";
