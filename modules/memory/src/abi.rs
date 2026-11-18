//! Canonical ABI bridge for the JSON host ports (kv, db, vault, jobs, context). No WASI imports.
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::alloc::{alloc, realloc, Layout};

#[link(wasm_import_module = "ports")]
extern "C" {
    fn kv(ptr: *const u8, len: usize, out: *mut usize);
    fn db(ptr: *const u8, len: usize, out: *mut usize);
    fn vault(ptr: *const u8, len: usize, out: *mut usize);
    fn jobs(ptr: *const u8, len: usize, out: *mut usize);
    fn context(ptr: *const u8, len: usize, out: *mut usize);
}
struct Bridge;
impl Host for Bridge {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        let request =
            json!({"operation":operation,"resource":resource,"parameters":parameters}).to_string();
        let mut out = [0usize; 3];
        unsafe {
            let call = match port {
                "kv" => kv,
                "db" => db,
                "vault" => vault,
                "jobs" => jobs,
                "context" => context,
                _ => return Err(Error::new("Undeclared Memory port")),
            };
            call(request.as_ptr(), request.len(), out.as_mut_ptr());
            let bytes = std::slice::from_raw_parts(out[1] as *const u8, out[2]);
            if out[0] != 0 {
                return Err(Error::new("Memory host request failed"));
            }
            Ok(serde_json::from_slice(bytes)?)
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn cabi_realloc(
    ptr: *mut u8,
    old: usize,
    align: usize,
    new: usize,
) -> *mut u8 {
    if new == 0 {
        return align as *mut u8;
    }
    if old == 0 {
        alloc(Layout::from_size_align_unchecked(new, align))
    } else {
        realloc(ptr, Layout::from_size_align_unchecked(old, align), new)
    }
}
#[no_mangle]
pub unsafe extern "C" fn moss_handle(
    kp: *const u8,
    kl: usize,
    pp: *const u8,
    pl: usize,
) -> *const usize {
    let kind = std::str::from_utf8(std::slice::from_raw_parts(kp, kl));
    let payload = std::str::from_utf8(std::slice::from_raw_parts(pp, pl));
    let result = match (kind, payload) {
        (Ok(k), Ok(p)) => crate::handle(&Bridge, k, p),
        _ => Err("Invalid Memory input".into()),
    };
    let tag = usize::from(result.is_err());
    let bytes = result.unwrap_or_else(|e| e).into_bytes().into_boxed_slice();
    let out = Box::new([tag, bytes.as_ptr() as usize, bytes.len()]);
    // Each invocation gets a fresh bounded Wasm instance; the host drops its memory.
    std::mem::forget(bytes);
    Box::into_raw(out) as *const usize
}
