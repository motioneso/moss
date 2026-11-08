//! Build-wrapper checks only. Actual People behavior runs in people_guest and the DB gate.
mod common;
use access_context::AccessContext;
use moss_module_host::{
    guest_component,
    runtime::{DenyPorts, Host, Limits},
};
use std::sync::Arc;

fn core(invoke_denied: bool) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module
      (import "env" "memory" (memory 32 1024))
      (import "wasi:random/random@0.2.6" "get-random-u64" (func $denied (result i64)))
      (data (i32.const 32) "\00\00\00\00\40\00\00\00\07\00\00\00")
      (data (i32.const 64) "healthy")
      (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32) i32.const 4096)
      (func (export "handle") (param i32 i32 i32 i32) (result i32) {} i32.const 32)
      (func (export "cabi_post_handle") (param i32)))"#,
        if invoke_denied {
            "call $denied drop"
        } else {
            ""
        }
    ))
    .unwrap()
}

#[test]
fn unused_wasi_is_closed_and_an_attempt_to_use_it_traps() {
    let host = Host::new(Limits::default()).unwrap();
    for invoke_denied in [false, true] {
        let component = guest_component::wrap_generated(&core(invoke_denied)).unwrap();
        let mut manifest = common::manifest("0.1.0");
        manifest.capabilities.clear();
        // Any surviving WASI import would fail this existing host validation.
        host.validate(&component, &manifest).unwrap();
        let result = host.call(
            &component,
            Arc::new(manifest),
            AccessContext::new(uuid::Uuid::new_v4(), "generated-wrapper"),
            Arc::new(DenyPorts),
            "health",
            "{}",
        );
        if invoke_denied {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap(), "healthy");
        }
    }
}

#[test]
fn foreign_imports_and_handwritten_wasi_are_rejected() {
    assert!(guest_component::wrap(&core(false)).is_err());
    let foreign = wat::parse_str(
        r#"(module
        (import "env" "memory" (memory 32 1024))
        (import "outside" "read" (func)))"#,
    )
    .unwrap();
    assert!(guest_component::wrap_generated(&foreign).is_err());
}

#[test]
fn the_existing_handwritten_exports_still_run() {
    let core = wat::parse_str(
        r#"(module
      (import "env" "memory" (memory 32 1024))
      (data (i32.const 32) "\00\00\00\00\40\00\00\00\07\00\00\00")
      (data (i32.const 64) "healthy")
      (func (export "moss_realloc") (param i32 i32 i32 i32) (result i32) i32.const 4096)
      (func (export "moss_handle") (param i32 i32 i32 i32) (result i32) i32.const 32)
      (func (export "moss_post_return") (param i32)))"#,
    )
    .unwrap();
    let component = guest_component::wrap(&core).unwrap();
    let host = Host::new(Limits::default()).unwrap();
    let mut manifest = common::manifest("0.1.0");
    manifest.capabilities.clear();
    assert_eq!(
        host.call(
            &component,
            Arc::new(manifest),
            AccessContext::new(uuid::Uuid::new_v4(), "legacy-wrapper"),
            Arc::new(DenyPorts),
            "health",
            "{}"
        )
        .unwrap(),
        "healthy"
    );
}
