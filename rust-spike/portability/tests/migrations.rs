//! Fact 3: Rust reproduces every migration checksum the app's runners compute.

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use common::{fixture, label, repo_root, spike_dir, text, Outcome};
use portability::migrations::{
    assert_unique_versions, load_migration_files, load_module_migration_files, MigrationFile,
};
use serde_json::{json, Value};

/// The module runner's SQL wire-contract validator is not part of this spike.
const VALIDATOR_NOT_PORTED: &str = "module-refused-statement";

fn as_json(files: &[MigrationFile]) -> Value {
    Value::Array(
        files
            .iter()
            .map(|file| {
                json!({
                    "name": file.name,
                    "version": file.version,
                    "checksum": file.checksum,
                    "backfill": file.backfill,
                })
            })
            .collect(),
    )
}

#[test]
fn rust_matches_every_repo_migration_checksum() {
    let text =
        std::fs::read_to_string(spike_dir().join("fixtures/migrations-manifest.jsonl")).unwrap();
    let mut lines = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap());
    let header = lines.next().unwrap();
    let entries: Vec<Value> = lines.collect();
    assert_eq!(header["entries"].as_u64().unwrap() as usize, entries.len());

    let mut folders: BTreeMap<(String, String), Vec<&Value>> = BTreeMap::new();
    let mut shims = Vec::new();
    for entry in &entries {
        match entry["runner"].as_str().unwrap() {
            "pinned-shim" => shims.push(entry),
            runner => folders
                .entry((
                    runner.to_string(),
                    entry["dir"].as_str().unwrap().to_string(),
                ))
                .or_default()
                .push(entry),
        }
    }

    let mut failures = Vec::new();
    let mut core_files = Vec::new();
    let (mut core, mut module, mut backfills) = (0, 0, 0);
    for ((runner, dir), want) in &folders {
        let path = repo_root().join(dir);
        let got = if runner == "core" {
            load_migration_files(&path)
        } else {
            load_module_migration_files(&path)
        }
        .unwrap_or_else(|error| panic!("{dir}: {error}"));
        if got.len() != want.len() {
            failures.push(format!(
                "{dir}: rust found {} files, node {}",
                got.len(),
                want.len()
            ));
        }
        for (file, want) in got.iter().zip(want) {
            let mut agrees = file.name == want["name"]
                && file.version == want["version"]
                && file.checksum == want["checksum"];
            if runner == "core" {
                agrees &= json!(file.backfill) == want["backfill"];
                if let Some(old) = want["oldRuleChecksum"].as_str() {
                    agrees &= file.old_rule_checksum == old;
                }
                core += 1;
                backfills += usize::from(file.backfill.is_some());
            } else {
                module += 1;
            }
            if !agrees {
                failures.push(format!("{dir}/{}: rust {file:?}, node {want}", file.name));
            }
        }
        if runner == "core" {
            core_files.extend(got);
        }
    }
    assert_unique_versions(&core_files).unwrap();

    for shim in &shims {
        let name = shim["name"].as_str().unwrap();
        let file = core_files.iter().find(|file| file.name == name);
        if file.map(|file| file.checksum.as_str()) != shim["checksum"].as_str() {
            failures.push(format!(
                "pinned shim {name}: rust {file:?}, pinned {}",
                shim["checksum"]
            ));
        }
    }

    println!(
        "migrations: {core} core-runner files ({backfills} with a backfill), {module} module-runner \
         files and {} pinned shim checksums checked; {} disagree (fixture commit {})",
        shims.len(),
        failures.len(),
        header["commit"].as_str().unwrap()
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn rust_matches_runner_edge_cases() {
    let fixtures = fixture("migrations-edge.json");
    let cases = fixtures["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    let mut skipped = Vec::new();
    for case in cases {
        if label(case) == VALIDATOR_NOT_PORTED {
            skipped.push(label(case));
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        for file in case["files"].as_array().unwrap() {
            let bytes = portability::js::base64_decode(file["base64"].as_str().unwrap());
            std::fs::write(dir.path().join(text(&file["name"])), bytes).unwrap();
        }
        let got = load(case["runner"].as_str().unwrap(), dir.path());
        let got = match got {
            Ok(files) => Outcome::Ok(as_json(&files)),
            Err(error) => Outcome::Error(error.replace(&dir.path().display().to_string(), "<dir>")),
        };
        let want = Outcome::expected(&case["expect"]);
        if got != want {
            failures.push(format!("{}: rust {got:?}, node {want:?}", label(case)));
        }
    }
    println!(
        "migration edge cases: {}/{} agree with Node, skipped {skipped:?} (validator not ported)",
        cases.len() - skipped.len() - failures.len(),
        cases.len() - skipped.len()
    );
    assert_eq!(skipped, [VALIDATOR_NOT_PORTED]);
    assert!(failures.is_empty(), "{failures:#?}");
}

fn load(runner: &str, dir: &Path) -> Result<Vec<MigrationFile>, String> {
    match runner {
        "core" => load_migration_files(dir),
        "module" => load_module_migration_files(dir),
        other => panic!("unknown runner {other}"),
    }
}
