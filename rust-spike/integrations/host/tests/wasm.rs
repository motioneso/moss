//! Runs the sorting crate's self-test inside WebAssembly. Needs INTEGRATIONS_CORE_WASM, which
//! tools/check.sh builds with the selftest feature.
use wasmtime::{Engine, Instance, Module, Store};

#[test]
fn the_wasm_build_passes_its_self_test() {
    let path = std::env::var("INTEGRATIONS_CORE_WASM").expect("INTEGRATIONS_CORE_WASM is not set");
    let engine = Engine::default();
    let module = Module::from_file(&engine, &path).unwrap();
    let mut store = Store::new(&engine, ());
    let instance = Instance::new(&mut store, &module, &[]).unwrap();
    let failures = instance
        .get_typed_func::<(), u32>(&mut store, "selftest_failures")
        .unwrap()
        .call(&mut store, ())
        .unwrap();
    assert_eq!(failures, 0, "wasm self-test failures");
}
