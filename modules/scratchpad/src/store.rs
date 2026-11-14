//! Guest side of the Scratchpad store. The host runs the SQL under the caller's own row policies.
use moss_module_sdk::{Host, Result};
use serde_json::Value;

pub const STORE: &str = "scratchpad.store";

pub fn call<H: Host + ?Sized>(host: &H, operation: &str, parameters: Value) -> Result<Value> {
    host.call("kv", operation, STORE, parameters)
}
