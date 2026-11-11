//! Canonical ABI entry points. The package declares no host ports and no WASI imports.
use moss_module_sdk::{Error, Host, Result};
use serde_json::Value;
use std::alloc::{alloc, realloc, Layout};

struct Bridge;
impl Host for Bridge {
    fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
        Err(Error::new("Memory declares no host ports"))
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
