//! Account deletion and export shape. Deleting an account removes all three tables by cascade.
use moss_module_sdk::{Error, Host, Result};
use serde_json::Value;

pub const OWNED_TABLES: [&str; 3] = ["app.backtrack_segments", "app.backtrack_preferences", "app.backtrack_deletions"];

/// Every column of the person's own segments except the search column, with the hash as hex.
pub fn collect<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let rows = crate::store::call(host, "export", serde_json::json!({}))?;
    if rows.is_array() {
        Ok(rows)
    } else {
        Err(Error::new("Backtrack export is malformed"))
    }
}
