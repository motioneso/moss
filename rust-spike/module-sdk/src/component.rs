//! Handwritten canonical ABI for the string/result Moss interface. The component
//! wrapper supplies canonical lowering/lifting; no WASI or native host edge exists.
use crate::{Error, Host, Result};
use serde_json::{json, Value};

type Call = unsafe extern "C" fn(u32, u32, u32);

#[derive(Clone, Copy)]
pub struct Port {
    name: &'static str,
    call: Call,
}

macro_rules! port {
    ($constant:ident, $function:ident, $name:literal, $module:literal) => {
        #[link(wasm_import_module = $module)]
        extern "C" {
            #[link_name = "call"]
            fn $function(request: u32, length: u32, result: u32);
        }
        pub const $constant: Port = Port {
            name: $name,
            call: $function,
        };
    };
}
// Unreferenced constants/imports are removed by the core linker. A guest chooses
// a fixed port list; the host still authorizes every operation and resource.
pub mod ports {
    use super::*;
    port!(DB, db, "db", "moss:module/db@1.0.0");
    port!(CONTEXT, context, "context", "moss:module/context@1.0.0");
    port!(API, api, "api", "moss:module/api@1.0.0");
    port!(VAULT, vault, "vault", "moss:module/vault@1.0.0");
    port!(JOBS, jobs, "jobs", "moss:module/jobs@1.0.0");
    port!(EVENTS, events, "events", "moss:module/events@1.0.0");
    port!(AI, ai, "ai", "moss:module/ai@1.0.0");
    port!(KV, kv, "kv", "moss:module/kv@1.0.0");
    port!(FETCH, fetch, "fetch", "moss:module/fetch@1.0.0");
    port!(BROWSER, browser, "browser", "moss:module/browser@1.0.0");
    port!(
        CREDENTIALS,
        credentials,
        "credentials",
        "moss:module/credentials@1.0.0"
    );
    port!(EMBED, embed, "embed", "moss:module/embed@1.0.0");
    port!(
        TRANSCRIBE,
        transcribe,
        "transcribe",
        "moss:module/transcribe@1.0.0"
    );
    port!(NOTIFY, notify, "notify", "moss:module/notify@1.0.0");
    port!(
        ATTACHMENTS,
        attachments,
        "attachments",
        "moss:module/attachments@1.0.0"
    );
    port!(TOOLS, tools, "tools", "moss:module/tools@1.0.0");
    port!(
        ACTION_POLICY,
        action_policy,
        "action-policy",
        "moss:module/action-policy@1.0.0"
    );
}

pub struct ComponentHost {
    ports: &'static [Port],
}
impl ComponentHost {
    pub const fn new(ports: &'static [Port]) -> Self {
        Self { ports }
    }
}

// result<string,string>: a one-byte discriminant, three bytes padding, then
// string pointer/length. Zero-initialize padding before canonical lowering.
#[repr(C)]
#[derive(Default)]
struct Return {
    tag: u32,
    pointer: u32,
    length: u32,
}

impl Host for ComponentHost {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        let port = self
            .ports
            .iter()
            .find(|p| p.name == port)
            .ok_or_else(|| Error::new("The guest does not import this port"))?;
        let request = serde_json::to_string(
            &json!({"operation":operation,"resource":resource,"parameters":parameters}),
        )?;
        let mut returned = Return::default();
        // The canonical lowerer reads borrowed input and allocates the result via
        // this guest's realloc. It guarantees valid, owned UTF-8 string memory.
        unsafe {
            (port.call)(
                request.as_ptr() as u32,
                request.len() as u32,
                &mut returned as *mut Return as u32,
            );
            let body = take_string(returned.pointer, returned.length);
            match returned.tag {
                0 => Ok(serde_json::from_str(&body)?),
                1 => Err(Error::new(body)),
                _ => Err(Error::new("Invalid host result")),
            }
        }
    }
}

unsafe fn take_string(pointer: u32, length: u32) -> String {
    if length == 0 {
        return String::new();
    }
    String::from_utf8(Vec::from_raw_parts(
        pointer as *mut u8,
        length as usize,
        length as usize,
    ))
    .expect("The canonical ABI supplies UTF-8")
}

/// # Safety
/// Called only by canonical lifting with owned UTF-8 argument allocations from
/// `realloc`. The returned allocation must be finalized once with `post_return`.
pub unsafe fn handle(
    kind: u32,
    kind_len: u32,
    payload: u32,
    payload_len: u32,
    handler: impl FnOnce(&str, &str) -> Result<String>,
) -> u32 {
    let kind = take_string(kind, kind_len);
    let payload = take_string(payload, payload_len);
    let (tag, value) = match handler(&kind, &payload) {
        Ok(value) => (0, value),
        Err(error) => (1, error.message),
    };
    let bytes = value.into_bytes().into_boxed_slice();
    let returned = Return {
        tag,
        pointer: bytes.as_ptr() as u32,
        length: bytes.len() as u32,
    };
    std::mem::forget(bytes);
    Box::into_raw(Box::new(returned)) as u32
}

/// # Safety
/// `pointer` is the live result of one `handle` call and is finalized exactly once.
pub unsafe fn post_return(pointer: u32) {
    let returned = Box::from_raw(pointer as *mut Return);
    drop(take_string(returned.pointer, returned.length));
}

/// # Safety
/// Canonical ABI allocation: old pointer/size/alignment describe a live allocation
/// made here, or old pointer is zero. Alignment must be a nonzero power of two.
pub unsafe fn realloc(old: u32, old_size: u32, alignment: u32, new_size: u32) -> u32 {
    use std::alloc::{alloc, dealloc, handle_alloc_error, realloc, Layout};
    let layout = Layout::from_size_align(old_size as usize, alignment as usize).unwrap();
    if new_size == 0 {
        if old != 0 {
            dealloc(old as *mut u8, layout);
        }
        return alignment;
    }
    let new_layout = Layout::from_size_align(new_size as usize, alignment as usize).unwrap();
    let pointer = if old == 0 {
        alloc(new_layout)
    } else {
        realloc(old as *mut u8, layout, new_size as usize)
    };
    if pointer.is_null() {
        handle_alloc_error(new_layout);
    }
    pointer as u32
}

/// Export the Moss string/result handler and its canonical allocation lifecycle.
#[macro_export]
macro_rules! export_module {
    ($handler:path, [$($port:path),* $(,)?]) => {
        #[no_mangle]
        unsafe extern "C" fn moss_handle(kind: u32, kind_len: u32, payload: u32, payload_len: u32) -> u32 {
            static PORTS: &[$crate::component::Port] = &[$($port),*];
            let host = $crate::component::ComponentHost::new(PORTS);
            $crate::component::handle(kind, kind_len, payload, payload_len, |kind, payload| $handler(&host, kind, payload))
        }
        #[no_mangle]
        unsafe extern "C" fn moss_post_return(pointer: u32) { $crate::component::post_return(pointer); }
        #[no_mangle]
        unsafe extern "C" fn moss_realloc(old: u32, old_size: u32, alignment: u32, new_size: u32) -> u32 {
            $crate::component::realloc(old, old_size, alignment, new_size)
        }
    };
}
