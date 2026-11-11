//! Memory host assembly. Package building lives here; the embedding service and its settings
//! route live in the host application so the credential never reaches the package.
pub mod package;

pub const MODULE_ID: &str = "memory";
