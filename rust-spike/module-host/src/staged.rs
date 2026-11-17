//! Request bytes that must not pass through a module. The shell stages a binary body under the
//! request id, the route sees only its size and hash, and a trusted host service takes the bytes
//! when the module asks it to store them. Nothing here is visible to guest code.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

fn table() -> &'static Mutex<HashMap<String, Arc<Vec<u8>>>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();
    TABLE.get_or_init(Default::default)
}

/// Holds the bytes until the guard drops, which is when the request ends.
pub struct Staged {
    key: String,
}

impl Staged {
    pub fn new(key: String, bytes: Vec<u8>) -> Self {
        table().lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), Arc::new(bytes));
        Self { key }
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        table().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.key);
    }
}

/// The bytes staged for this request id, if any.
pub fn get(key: &str) -> Option<Arc<Vec<u8>>> {
    table().lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()
}

/// Request ids that carry staged bytes start with this prefix, so a normal request can never
/// collide with one.
pub const PREFIX: &str = "staged:";

/// Stages `bytes` for the request and returns the JSON body the route receives in their place.
pub fn stage_body(request_id: &str, bytes: Vec<u8>) -> (Staged, String) {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let body = format!("{{\"staged\":{{\"bytes\":{},\"sha256\":\"{hash}\"}}}}", bytes.len());
    (Staged::new(request_id.to_owned(), bytes), body)
}
