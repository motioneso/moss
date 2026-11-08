//! Build-time wrapping of a Rust core guest in the existing Moss component ABI.
//! No generated binding package or WASI adapter is needed for this handwritten path.
use anyhow::{bail, ensure, Context, Result};
use std::{collections::BTreeSet, fmt::Write};
use wasmtime::{Engine, ExternType, Module};

pub fn wrap(core: &[u8]) -> Result<Vec<u8>> {
    let module = Module::new(&Engine::default(), core).context("Invalid core guest")?;
    let mut ports = BTreeSet::new();
    let mut memory = None;
    for import in module.imports() {
        if import.module() == "env" && import.name() == "memory" {
            let ExternType::Memory(ty) = import.ty() else {
                bail!("Guest memory has the wrong type")
            };
            ensure!(
                !ty.is_64() && !ty.is_shared(),
                "Guest needs ordinary wasm32 memory"
            );
            ensure!(
                ty.minimum() <= 1024 && ty.maximum().is_none_or(|n| n >= 1024),
                "Guest memory is incompatible with the host limit"
            );
            ensure!(
                memory.replace(ty.minimum()).is_none(),
                "Duplicate guest memory"
            );
            continue;
        }
        let port = import
            .module()
            .strip_prefix("moss:module/")
            .and_then(|s| s.strip_suffix("@1.0.0"));
        ensure!(
            port.is_some_and(|p| crate::manifest::PORTS.contains(&p)) && import.name() == "call",
            "Guest imports a forbidden edge: {} / {}",
            import.module(),
            import.name()
        );
        ports.insert(port.unwrap().to_owned());
    }
    let pages = memory.context("Compile the core guest with --import-memory")?;
    let mut wat = String::from("(component\n(type $call (func (param \"request\" string) (result (result string (error string)))))\n");
    for port in &ports {
        writeln!(wat,"(import \"moss:module/{port}@1.0.0\" (instance ${port} (export \"call\" (func (type $call)))))\n(alias export ${port} \"call\" (func ${port}-call))")?;
    }
    // Import lowering needs memory/realloc before the Rust instance exists. A
    // fixed trampoline table is filled with its allocator immediately afterwards.
    // All actual allocations, including host strings, use Rust's own allocator.
    writeln!(
        wat,
        r#"(core module $memory
      (type $r (func (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") {pages} 1024)
      (table (export "allocator") 1 1 funcref)
      (func (export "realloc") (type $r)
        local.get 0 local.get 1 local.get 2 local.get 3 i32.const 0 call_indirect (type $r)))
    (core instance $mem (instantiate $memory))
    (alias core export $mem "memory" (core memory $memory))
    (alias core export $mem "realloc" (core func $realloc))"#
    )?;
    for port in &ports {
        writeln!(wat,"(core func $lower-{port} (canon lower (func ${port}-call) (memory $memory) (realloc (func $realloc))))")?;
    }
    // This pinned WAT parser does not accept binary core modules inside a
    // component. Encode a placeholder, then replace its section payload intact.
    wat.push_str(r#"(core module $code
      (func (export "moss_realloc") (param i32 i32 i32 i32) (result i32) unreachable)
      (func (export "moss_handle") (param i32 i32 i32 i32) (result i32) unreachable)
      (func (export "moss_post_return") (param i32) unreachable))
      (core instance $guest (instantiate $code (with "env" (instance (export "memory" (memory $memory))))
    "#);
    for port in &ports {
        writeln!(
            wat,
            "(with \"moss:module/{port}@1.0.0\" (instance (export \"call\" (func $lower-{port}))))"
        )?;
    }
    wat.push_str(
        r#"))
      (alias core export $guest "moss_realloc" (core func $guest-realloc))
      (alias core export $guest "moss_handle" (core func $handle))
      (alias core export $guest "moss_post_return" (core func $post-return))
      (core module $allocator
        (import "env" "allocator" (table 1 1 funcref))
        (import "guest" "realloc" (func $realloc (param i32 i32 i32 i32) (result i32)))
        (elem (i32.const 0) func $realloc))
      (core instance $allocator-instance (instantiate $allocator
        (with "env" (instance $mem))
        (with "guest" (instance (export "realloc" (func $guest-realloc))))))
      (func (export "handle") (param "kind" string) (param "payload" string)
        (result (result string (error string)))
        (canon lift (core func $handle) (memory $memory) (realloc (func $realloc))
          (post-return (func $post-return)))))"#,
    );
    let component = replace_core(&wat::parse_str(&wat)?, core)?;
    let mut config = wasmtime::Config::new();
    config.wasm_component_model(true);
    wasmtime::component::Component::new(&Engine::new(&config)?, &component)
        .context("The wrapped guest does not implement the Moss ABI")?;
    Ok(component)
}

fn replace_core(template: &[u8], core: &[u8]) -> Result<Vec<u8>> {
    ensure!(
        template.get(..8) == Some(b"\0asm\x0d\0\x01\0"),
        "Invalid component template"
    );
    let mut output = template[..8].to_vec();
    let mut cursor = 8;
    let mut modules = 0;
    while cursor < template.len() {
        let start = cursor;
        let section = template[cursor];
        cursor += 1;
        let mut length = 0u32;
        let mut complete = false;
        for shift in (0..35).step_by(7) {
            let byte = *template
                .get(cursor)
                .context("Truncated component section")?;
            cursor += 1;
            ensure!(shift != 28 || byte < 16, "Oversized component section");
            length |= u32::from(byte & 127) << shift;
            if byte & 128 == 0 {
                complete = true;
                break;
            }
        }
        ensure!(complete, "Invalid component section size");
        let end = cursor
            .checked_add(length as usize)
            .context("Oversized component")?;
        ensure!(end <= template.len(), "Truncated component");
        if section == 1 {
            modules += 1;
        }
        if section == 1 && modules == 2 {
            output.push(1);
            let mut length = u32::try_from(core.len())?;
            loop {
                let byte = (length & 127) as u8;
                length >>= 7;
                output.push(byte | if length == 0 { 0 } else { 128 });
                if length == 0 {
                    break;
                }
            }
            output.extend_from_slice(core);
        } else {
            output.extend_from_slice(&template[start..end]);
        }
        cursor = end;
    }
    ensure!(modules == 3, "Unexpected component template");
    Ok(output)
}
