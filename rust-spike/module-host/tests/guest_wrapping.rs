use moss_module_host::guest_component::wrap;

#[test]
fn wrapper_rejects_non_moss_edges_and_requires_shared_memory() {
    for core in [
        "(module)",
        "(module (import \"env\" \"memory\" (memory 32 1024)) (import \"wasi_snapshot_preview1\" \"fd_write\" (func)))",
        "(module (import \"env\" \"memory\" (memory 32 1024)) (import \"arbitrary\" \"call\" (func)))",
        "(module (import \"env\" \"memory\" (memory 32 1024)) (import \"moss:module/db@1.0.0\" \"raw-sql\" (func)))",
    ] { assert!(wrap(&wat::parse_str(core).unwrap()).is_err()); }
}

#[test]
fn wrapper_checks_the_real_guest_export_types() {
    let core = wat::parse_str(
        "(module (import \"env\" \"memory\" (memory 32 1024)) (func (export \"moss_handle\")))",
    )
    .unwrap();
    assert!(wrap(&core).is_err());
}
