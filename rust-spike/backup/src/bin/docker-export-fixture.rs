//! Test reader only: decrypt a synthetic Docker export using the unmodified part 4 reader.
//! Never prints decrypted material. Run only on generated test fixtures.
use keystore::{custody, recovery};
use moss_backup::archive::{self, ArchiveReader};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::Path;

fn run() -> Result<Value, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        return Err(
            "usage: docker-export-fixture ARCHIVE WORDS OUTDIR (synthetic data only)".into(),
        );
    }
    let text = std::fs::read_to_string(&args[1]).map_err(|_| "test words missing")?;
    let words = recovery::split_pasted(&text);
    let recovery = recovery::parse_words(&words).map_err(|_| "test words invalid")?;
    let mut input = std::fs::File::open(&args[0]).map_err(|_| "test archive missing")?;
    let header = archive::read_header(&mut input)?;
    let master = custody::master_from_recovery(header.key_bundle(), &recovery)
        .map_err(|_| "wrong test recovery key")?;
    let credentials = custody::unwrap_with_master(header.key_bundle(), &master)
        .map_err(|_| "test bundle damaged")?;
    let root = Path::new(&args[2]);
    moss_backup::create_private_dir(root).map_err(|_| "test extraction root")?;
    moss_backup::create_private_file(&root.join("credentials.json"))
        .and_then(|mut f| f.write_all(&credentials))
        .map_err(|_| "test credentials output")?;
    let key = archive::open_data_key(&header, &master)?;
    let mut reader = ArchiveReader::new(input, &header, &key);
    let mut files = Vec::new();
    let mut manifest = Value::Null;
    let mut dump = Value::Null;
    let mut roles = Value::Null;
    loop {
        let (kind, name) = reader
            .next_entry()
            .map_err(|_| "test archive entry invalid")?;
        if kind == archive::ENTRY_END {
            break;
        }
        if kind == archive::ENTRY_MANIFEST {
            let mut bytes = Vec::new();
            reader
                .content()
                .read_to_end(&mut bytes)
                .map_err(|_| "test manifest damaged")?;
            manifest = serde_json::from_slice(&bytes).map_err(|_| "test manifest invalid")?;
            continue;
        }
        let path = match kind {
            archive::ENTRY_DUMP => root.join("database.dump"),
            archive::ENTRY_ROLES => root.join("roles.sql"),
            archive::ENTRY_FILE => moss_backup::safe_join(&root.join("files"), &name)?,
            _ => return Err("unknown test entry".into()),
        };
        moss_backup::create_private_dir(path.parent().unwrap())
            .map_err(|_| "test extraction directory")?;
        let mut file =
            moss_backup::create_private_file(&path).map_err(|_| "duplicate test archive entry")?;
        let (size, sha256) = archive::copy_hashed(&mut reader.content(), &mut file)
            .map_err(|_| "test extraction failed")?;
        let record = json!({"size":size,"sha256":sha256});
        match kind {
            archive::ENTRY_DUMP => dump = record,
            archive::ENTRY_ROLES => roles = record,
            _ => files.push(json!({"path":name,"size":size,"sha256":sha256})),
        }
    }
    if manifest["kind"] != "moss-docker-move"
        || manifest["database"]["dump"] != dump
        || manifest["database"]["roles"] != roles
    {
        return Err("test manifest database hash mismatch".into());
    }
    let expected = manifest["files"]
        .as_array()
        .ok_or("test file manifest absent")?;
    if expected.len() != files.len()
        || files.iter().any(|f| {
            !expected.iter().any(|e| {
                e["path"] == f["path"] && e["size"] == f["size"] && e["sha256"] == f["sha256"]
            })
        })
    {
        return Err("test file hash mismatch".into());
    }
    moss_backup::create_private_file(&root.join("manifest.json"))
        .and_then(|mut f| f.write_all(manifest.to_string().as_bytes()))
        .map_err(|_| "test manifest output")?;
    Ok(json!({"opened":true,"files":files.len(),"accountsCount":manifest["accountsCount"]}))
}
fn main() {
    match run() {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
