use moss_module_host::legacy;
use moss_tasks_checks::{legacy_files, manifest};
use moss_tasks_module::repository::TABLES;

#[test]
fn package_owns_every_existing_tasks_table() {
    let m = manifest().expect("Tasks manifest must accept all six legacy tables");
    assert!(
        !m.accounts.supports_user_disable,
        "Tasks is a required module"
    );
    for table in TABLES {
        assert!(m.database.owned_tables.iter().any(|t| t == table));
        assert!(
            legacy::owns("tasks", table),
            "Missing legacy ownership: {table}"
        );
    }
    assert_eq!(m.database.owned_tables.len(), 6);
    assert_eq!(m.tools.len(), 18);
    assert_eq!(
        m.tools.values().filter(|tool| tool.risk == "read").count(),
        6
    );
    assert_eq!(
        m.tools.values().filter(|tool| tool.risk == "write").count(),
        12
    );
    assert!(
        m.navigation.len() == 1
            && m.settings.is_empty()
            && m.screens
                .get("/tasks")
                .is_some_and(|path| path == "ui/index.html"),
        "Advertise only the implemented package screen; action-policy settings are unfinished"
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
