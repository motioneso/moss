use moss_module_host::legacy;
use moss_tasks_checks::{legacy_files, manifest};
use moss_tasks_module::repository::TABLES;

#[test]
fn package_owns_every_existing_tasks_table() {
    let m = manifest().expect("Tasks manifest must accept all six legacy tables");
    for table in TABLES {
        assert!(m.database.owned_tables.iter().any(|t| t == table));
        assert!(
            legacy::owns("tasks", table),
            "Missing legacy ownership: {table}"
        );
    }
    assert_eq!(m.database.owned_tables.len(), 6);
    assert!(
        m.navigation.is_empty() && m.settings.is_empty() && m.screens.is_empty(),
        "Do not advertise unfinished screens"
    );
}
#[test]
fn all_original_migrations_are_hash_verified() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let files = legacy_files(&root).unwrap();
    let sql = std::fs::read_dir(root.join("packages/tasks/sql"))
        .unwrap()
        .filter_map(|p| {
            let p = p.unwrap().path();
            (p.extension().is_some_and(|e| e == "sql")).then_some(p)
        })
        .count();
    assert_eq!(files.len(), sql);
    assert_eq!(files.len(), 9);
}
