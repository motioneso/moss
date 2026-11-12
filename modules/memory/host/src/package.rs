//! Deterministic package construction from this crate's Rust Wasm and immutable legacy SQL.
use anyhow::Result;
use moss_module_host::{archive, manifest::Manifest};
use std::{collections::BTreeMap, path::Path};

pub fn manifest() -> Result<Manifest> {
    Ok(serde_json::from_str(include_str!(
        "../../moss.module.json"
    ))?)
}
pub fn component(core: &[u8]) -> Result<Vec<u8>> {
    let mut imports = String::new();
    let mut lowers = String::new();
    let mut exports = String::new();
    for port in ["kv", "db", "vault", "jobs", "context"] {
        imports += &format!(
            r#"(import "moss:module/{port}@1.0.0" (instance ${port} (export "call" (func (type $call)))))
            (alias export ${port} "call" (func ${port}-call))"#
        );
        lowers += &format!(
            r#"(core func ${port}-lower (canon lower (func ${port}-call) (memory $memory) (realloc (func $realloc))))"#
        );
        exports += &format!(r#"(export "{port}" (func ${port}-lower))"#);
    }
    // Canonical lowering needs memory/realloc before the guest is instantiated. A
    // one-entry trampoline delegates allocations to Rust after guest instantiation.
    let shell = wat::parse_str(format!(
        r#"(component
      (type $call (func (param "request" string) (result (result string (error string)))))
      {imports}
      (core module $shared
        (memory (export "memory") 32 1024)
        (table (export "alloc-table") 1 funcref)
        (type $alloc (func (param i32 i32 i32 i32) (result i32)))
        (func (export "realloc") (type $alloc)
          local.get 0 local.get 1 local.get 2 local.get 3 i32.const 0 call_indirect (type $alloc)))
      (core instance $shared-i (instantiate $shared))
      (alias core export $shared-i "memory" (core memory $memory))
      (alias core export $shared-i "realloc" (core func $realloc))
      (alias core export $shared-i "alloc-table" (core table $table))
      {lowers}
      (core module $guest
        (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32) i32.const 0)
        (func (export "moss_handle") (param i32 i32 i32 i32) (result i32) i32.const 0))
      (core instance $guest-i (instantiate $guest
        (with "env" (instance (export "memory" (memory $memory))))
        (with "ports" (instance {exports}))))
      (alias core export $guest-i "cabi_realloc" (core func $rust-alloc))
      (core module $bind
        (import "bind" "table" (table 1 funcref))
        (import "bind" "alloc" (func $alloc (param i32 i32 i32 i32) (result i32)))
        (elem (i32.const 0) $alloc))
      (core instance $bound (instantiate $bind (with "bind" (instance
        (export "table" (table $table)) (export "alloc" (func $rust-alloc))))))
      (alias core export $guest-i "moss_handle" (core func $handle))
      (func (export "handle") (param "kind" string) (param "payload" string)
        (result (result string (error string)))
        (canon lift (core func $handle) (memory $memory) (realloc (func $realloc)))))"#
    ))?;
    embed_core(&shell, core)
}
fn embed_core(shell: &[u8], core: &[u8]) -> Result<Vec<u8>> {
    anyhow::ensure!(
        core.starts_with(b"\0asm\x01\0\0\0"),
        "Expected a compiled core Wasm module"
    );
    // WAT's component syntax cannot embed a binary core module. Replace only the
    // second module section in our locally generated shell; all indices stay fixed.
    let mut offset = 8;
    let mut modules = 0;
    while offset < shell.len() {
        let start = offset;
        let id = shell[offset];
        offset += 1;
        let mut length = 0usize;
        let mut shift = 0;
        loop {
            let b = shell[offset];
            offset += 1;
            length |= ((b & 127) as usize) << shift;
            if b & 128 == 0 {
                break;
            }
            shift += 7;
        }
        if id == 1 {
            modules += 1;
        }
        if id == 1 && modules == 2 {
            let mut out = shell[..start].to_vec();
            out.push(1);
            let mut n = core.len();
            loop {
                let mut b = (n & 127) as u8;
                n >>= 7;
                if n != 0 {
                    b |= 128;
                }
                out.push(b);
                if n == 0 {
                    break;
                }
            }
            out.extend_from_slice(core);
            out.extend_from_slice(&shell[offset + length..]);
            return Ok(out);
        }
        offset += length;
    }
    anyhow::bail!("Memory component shell has no guest slot")
}
pub fn files(root: &Path, core: &[u8]) -> Result<BTreeMap<String, Vec<u8>>> {
    let manifest = manifest()?;
    manifest.validate(&"0.1.0".parse()?)?;
    let mut files = BTreeMap::from([
        ("moss.module.json".into(), serde_json::to_vec(&manifest)?),
        ("code/module.wasm".into(), component(core)?),
        (
            "icons/memory.svg".into(),
            include_bytes!("../../icons/memory.svg").to_vec(),
        ),
        ("LICENSE".into(), std::fs::read(root.join("LICENSE"))?),
        (
            "NOTICE".into(),
            b"Moss Memory; uses the existing Memory migration identities.".to_vec(),
        ),
        (
            "CHANGELOG.md".into(),
            include_bytes!("../../CHANGELOG.md").to_vec(),
        ),
    ]);
    for (name, bytes) in [
        ("index.html", include_bytes!("../../ui/index.html").as_slice()),
        ("embedding.html", include_bytes!("../../ui/embedding.html")),
        ("embedding.mjs", include_bytes!("../../ui/embedding.mjs")),
        ("reembed.mjs", include_bytes!("../../ui/reembed.mjs")),
        ("app.mjs", include_bytes!("../../ui/app.mjs")),
        ("view.mjs", include_bytes!("../../ui/view.mjs")),
        ("api.mjs", include_bytes!("../../ui/api.mjs")),
        ("guest-bridge.mjs", include_bytes!("../../ui/guest-bridge.mjs")),
        ("memory.css", include_bytes!("../../ui/memory.css")),
    ] {
        files.insert(format!("ui/{name}"), bytes.to_vec());
    }
    for path in &manifest.database.migrations {
        let bytes = if let Some(frozen) = moss_module_host::legacy::entry("memory", path) {
            let bytes = std::fs::read(root.join("packages/memory").join(path))?;
            anyhow::ensure!(
                frozen.raw == moss_module_host::trust::digest(&bytes),
                "Legacy Memory SQL changed"
            );
            bytes
        } else {
            let bytes = std::fs::read(root.join("modules/memory").join(path))?;
            let pinned = match path.as_str() {
                "sql/0363_memory_ingest_nudges.sql" => {
                    "461aa6600ae180caa1e0d5b66bb4f4b562612cac037f4638dd191c41f589443c"
                }
                "sql/0364_memory_reembed_runs.sql" => {
                    "404f1f8db11569a6bbb413acd0037d7555661b1430ba6c0dadcdccd0d907123e"
                }
                "sql/0365_memory_reembed_one_running.sql" => {
                    "502ed9bfba7d5fcc6353066adf43ccd3c548a07dd5a948ecad86d63709c84a19"
                }
                "sql/0366_memory_reembed_staged.sql" => {
                    "56cbd98c7eaefed964fdc74e5fcdb3dcdfc67fb38cfe9b289bbf6128c2797cb9"
                }
                _ => "",
            };
            anyhow::ensure!(
                moss_module_host::trust::digest(&bytes) == pinned,
                "Memory migration bytes changed: {path}"
            );
            bytes
        };
        files.insert(path.clone(), bytes);
    }
    Ok(files)
}
pub fn pack(root: &Path, core: &[u8]) -> Result<Vec<u8>> {
    archive::pack(&files(root, core)?)
}
