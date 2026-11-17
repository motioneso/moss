//! The pure rules, built for WebAssembly, run their own fixtures inside the host's engine.
//! Run through the proactive feedback gate, which builds the module first.
use wasmtime::{Engine, Instance, Module, Store};

#[test]
#[ignore = "Only through the proactive feedback gate"]
fn the_webassembly_build_passes_every_fixture() {
    let path = std::env::var("USEFULNESS_RULES_WASM").expect("the gate builds the module first");
    let engine = Engine::default();
    let module = Module::from_file(&engine, path).unwrap();
    let mut store = Store::new(&engine, ());
    let instance = Instance::new(&mut store, &module, &[]).unwrap();
    let run = instance.get_typed_func::<(), u32>(&mut store, "run_fixtures").unwrap();
    assert_eq!(run.call(&mut store, ()).unwrap(), 0, "fixtures failed in the WebAssembly build");
    println!("WebAssembly fixtures passed");
}
