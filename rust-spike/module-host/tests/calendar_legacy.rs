mod common;
use moss_module_host::{legacy, manifest::Ledger};

#[test]
fn calendar_inventory_retains_all_five_legacy_tables() {
    for table in [
        "app.calendar_events",
        "app.day_plans",
        "app.day_plan_blocks",
        "app.day_plan_operations",
        "app.day_plan_operation_items",
    ] {
        assert!(
            legacy::owns("calendar", table),
            "missing Calendar ownership: {table}"
        );
    }
    assert!(!legacy::owns("calendar", "app.tasks"));
    assert!(!legacy::owns("calendar", "app.preferences"));
}

#[test]
fn frozen_calendar_suffix_keeps_its_original_ledger_identity() {
    let mut m = common::manifest("1.0.0");
    m.id = "calendar".into();
    m.database.ledger = Ledger::CoreLegacy;
    m.database.migrations = [
        "sql/0229_day_plans.sql",
        "sql/0229a_day_plan_preserve_legacy.sql",
        "sql/0230_day_plan_ownership.sql",
    ]
    .map(str::to_owned)
    .to_vec();
    m.validate(&"0.1.0".parse().unwrap()).unwrap();
    assert_eq!(legacy::version(&m.database.migrations[1]).unwrap(), "0229a");
    m.database.migrations.swap(0, 1);
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
    m.database.migrations = vec!["sql/0230b_downloaded.sql".into()];
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
    m.id = "sample.counter".into();
    m.database.ledger = Ledger::Module;
    m.database.migrations = vec!["sql/0229a_day_plan_preserve_legacy.sql".into()];
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
}
