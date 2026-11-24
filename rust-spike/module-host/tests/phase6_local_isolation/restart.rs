use super::fixture;
use moss_module_host::{
    lifecycle::FileLifecycle,
    store::{CatalogStore, Lifecycle},
};
use serde_json::json;

#[test]
fn startup_recovers_interrupted_local_upgrade_without_losing_owner_data() {
    let f = fixture::Fixture::new();
    let host = f.open();
    f.install(&host, "1.0.0");
    let write = |value: &str| {
        json!({"operation":"set","resource":"counter","parameters":value}).to_string()
    };
    host.call(
        &f.id,
        f.owner.clone(),
        "route",
        &write("PRIVATE-BEFORE-CRASH-MARKER"),
    )
    .unwrap();
    let before = f.saved.load().unwrap();
    let lifecycle = FileLifecycle::new(f.data.path(), [f.admin.actor_user_id()].into()).unwrap();
    let snapshot = lifecycle.snapshot(&f.id).unwrap();
    host.call(
        &f.id,
        f.owner.clone(),
        "route",
        &write("interrupted migration write"),
    )
    .unwrap();
    // Fault injection at the durable journal boundary: the pointer has not committed.
    // Startup must use the real lifecycle snapshot before serving any account again.
    let root = vault::Root::create(&f.data.path().join("modules")).unwrap();
    root.write(
        "operation.json",
        &serde_json::to_vec(
            &json!({"module":f.id,"snapshot":snapshot,"before":before,"target":"a".repeat(64)}),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(host.call(&f.id, f.owner.clone(), "health", "{}").is_err());
    drop(host);
    let host = f.open();
    assert!(host
        .call(
            &f.id,
            f.owner.clone(),
            "route",
            r#"{"operation":"get","resource":"counter","parameters":{}}"#
        )
        .unwrap()
        .contains("PRIVATE-BEFORE-CRASH-MARKER"));
    for actor in [&f.other, &f.admin] {
        assert!(host.call(&f.id, actor.clone(), "health", "{}").is_err());
        assert!(host.installed_for(actor).unwrap().is_empty());
    }
    drop(host);
    let host = f.open();
    assert_eq!(
        host.installed_for(&f.owner).unwrap()[0]
            .manifest
            .version
            .to_string(),
        "1.0.0"
    );
}
