#![cfg(unix)]
mod common;
use access_context::AccessContext;
use moss_module_host::{archive, local_packages::LocalPackages};

#[test]
fn local_signing_refuses_install_wide_storage() {
    let dir = tempfile::tempdir().unwrap();
    let paths = keystore::store::Paths::under(&dir.path().join("config"), &dir.path().join("data"));
    keystore::store::set_up(
        &paths,
        &keystore::probe::Keychain::NotInstalled,
        &keystore::recovery::RecoveryKey::generate(),
        &keystore::store::CredentialKeys::generate(),
    )
    .unwrap();
    let access = AccessContext::new(uuid::Uuid::new_v4(), "local-isolation");
    let mut manifest = common::manifest("1.0.0");
    manifest.id = format!("local.{}.counter", access.actor_user_id());
    manifest.install_wide_kv.insert("counter".into());
    let bytes = archive::pack(&common::files(&manifest)).unwrap();
    assert!(
        LocalPackages::new(paths).sign(&access, &bytes).is_err(),
        "local package must not gain install-wide storage"
    );
}
#[path = "phase6_local_isolation/fixture.rs"]
mod fixture;

#[test]
fn builder_installs_restarts_upgrades_and_removes_without_admin_rights() {
    let f = fixture::Fixture::new();
    let host = f.open();
    f.install(&host, "1.0.0");
    host.call(
        &f.id,
        f.owner.clone(),
        "route",
        r#"{"operation":"set","resource":"counter","parameters":"PRIVATE-DATA-MARKER"}"#,
    )
    .unwrap();
    drop(host);
    let host = f.open();
    let get = r#"{"operation":"get","resource":"counter","parameters":{}}"#;
    assert_eq!(
        host.call(&f.id, f.owner.clone(), "route", get).unwrap(),
        "\"PRIVATE-DATA-MARKER\""
    );
    f.install(&host, "2.0.0");
    assert_eq!(
        host.call(&f.id, f.owner.clone(), "route", get).unwrap(),
        "\"PRIVATE-DATA-MARKER\""
    );
    host.remove(&f.owner, &f.id, None).unwrap();
    assert!(host.call(&f.id, f.owner.clone(), "route", get).is_err());
    drop(host);
    let host = f.open();
    f.install(&host, "2.0.0");
    assert_eq!(
        host.call(&f.id, f.owner.clone(), "route", get).unwrap(),
        "\"PRIVATE-DATA-MARKER\""
    );
}

fn installed() -> (
    fixture::Fixture,
    std::sync::Arc<moss_module_host::store::Installer>,
    String,
) {
    use moss_module_host::store::CatalogStore;
    let f = fixture::Fixture::new();
    let host = f.open();
    f.install(&host, "1.0.0");
    let digest = f.saved.load().unwrap().installed[&f.id].digest.clone();
    (f, host, digest)
}
#[test]
fn navigation_is_owner_only() {
    let (f, host, _) = installed();
    assert_eq!(
        host.navigation(&f.owner).unwrap()[0].label,
        "PRIVATE-NAV-MARKER"
    );
    for actor in [&f.other, &f.admin] {
        assert!(
            host.navigation(actor).unwrap().is_empty(),
            "PRIVATE-NAV-MARKER leaked to {}",
            actor.request_id()
        );
    }
}
#[test]
fn screen_is_owner_only() {
    let (f, host, _) = installed();
    host.screen(&f.owner, &f.id, "/counter").unwrap();
    for actor in [&f.other, &f.admin] {
        assert!(
            host.screen(actor, &f.id, "/counter").is_err(),
            "PRIVATE-ASSET-MARKER screen leaked"
        );
    }
}
#[test]
fn assets_are_owner_only() {
    let (f, host, digest) = installed();
    let policy = moss_module_host::frame::AssetPolicy::new("https://moss.example.test").unwrap();
    let asset = host
        .ui_asset_for(Some(&f.owner), &f.id, &digest, "ui/index.html", &policy)
        .unwrap();
    assert!(String::from_utf8(asset.body)
        .unwrap()
        .contains("PRIVATE-ASSET-MARKER"));
    for actor in [Some(&f.other), Some(&f.admin), None] {
        assert!(
            host.ui_asset_for(actor, &f.id, &digest, "ui/index.html", &policy)
                .is_err(),
            "PRIVATE-ASSET-MARKER leaked"
        );
    }
    assert!(
        host.ui_asset(&f.id, &digest, "ui/index.html", &policy)
            .is_err(),
        "public asset leak"
    );
}
#[test]
fn catalog_is_owner_only() {
    let (f, host, _) = installed();
    assert_eq!(host.installed_for(&f.owner).unwrap()[0].manifest.id, f.id);
    for actor in [&f.other, &f.admin] {
        assert!(
            host.installed_for(actor).unwrap().is_empty(),
            "PRIVATE-CATALOG-MARKER leaked"
        );
    }
}
#[test]
fn package_files_are_owner_only() {
    let (f, host, digest) = installed();
    assert!(
        host.package_for_account(&f.owner, &f.id).unwrap().files["ui/index.html"]
            .windows(20)
            .any(|w| w == b"PRIVATE-ASSET-MARKER".as_slice()),
        "owner export"
    );
    for actor in [&f.other, &f.admin] {
        assert!(
            host.package_for_account(actor, &f.id).is_err(),
            "PRIVATE-ASSET-MARKER exported"
        );
    }
    assert!(
        host.read_package(&digest).is_err(),
        "PRIVATE-ASSET-MARKER leaked from digest reader"
    );
}
#[test]
fn portable_exports_omit_local_packages() {
    let (_, host, _) = installed();
    assert!(
        host.export_list().unwrap().modules.is_empty(),
        "PRIVATE-EXPORT-MARKER leaked"
    );
}
#[test]
fn invocations_are_owner_only() {
    let (f, host, _) = installed();
    let mut leaks = Vec::new();
    for kind in ["job", "event", "api", "health"] {
        assert!(host
            .call(&f.id, f.owner.clone(), kind, "{}")
            .unwrap()
            .contains("PRIVATE-CODE-MARKER"));
        for actor in [&f.other, &f.admin] {
            if let Ok(value) = host.call(&f.id, actor.clone(), kind, "{}") {
                leaks.push(format!("{} {kind}: {value}", actor.request_id()));
            }
        }
    }
    for actor in [&f.owner, &f.other, &f.admin] {
        let owner = actor.actor_user_id() == f.owner.actor_user_id();
        for (kind, result) in [
            (
                "route",
                host.dispatch(actor.clone(), "GET", &format!("/api/m/{}/read", f.id), "{}"),
            ),
            (
                "extended route",
                host.dispatch_extended(
                    actor.clone(),
                    "GET",
                    &format!("/api/m/{}/read", f.id),
                    "{}",
                ),
            ),
            (
                "tool",
                host.run_chat_tool(actor, &f.id, "local.read", serde_json::json!({}))
                    .map(|v| v.to_string()),
            ),
        ] {
            if owner {
                assert!(result.is_ok(), "builder {kind}: {result:?}");
            } else if let Ok(value) = result {
                leaks.push(format!("{} {kind}: {value}", actor.request_id()));
            }
        }
    }
    assert!(leaks.is_empty(), "guest data escaped: {leaks:?}");
}
#[test]
fn chat_tool_listing_is_owner_only() {
    let (f, host, _) = installed();
    assert_eq!(
        host.chat_tools(&f.owner).unwrap()[0].description,
        "PRIVATE-TOOL-MARKER"
    );
    for actor in [&f.other, &f.admin] {
        assert!(
            host.chat_tools(actor).unwrap().is_empty(),
            "PRIVATE-TOOL-MARKER leaked"
        );
    }
}
#[test]
fn removal_is_owner_only() {
    let (f, host, _) = installed();
    for actor in [&f.other, &f.admin] {
        assert!(
            host.remove(actor, &f.id, None).is_err(),
            "PRIVATE-REMOVE-MARKER non-builder removed package"
        );
    }
    host.remove(&f.owner, &f.id, None).unwrap();
}

#[test]
fn local_declarations_cannot_escape_account_scope() {
    use moss_module_host::manifest::{CredentialScope, TableAccess};
    let f = fixture::Fixture::new();
    let base = || {
        let mut m = common::manifest("1.0.0");
        m.id = f.id.clone();
        m
    };
    let mut cases = Vec::new();
    let mut shared = base();
    let table = format!(
        "app.{}rows",
        moss_module_host::manifest::table_prefix(&f.id)
    );
    shared.database.owned_tables.push(table.clone());
    shared
        .database
        .access
        .insert(table.clone(), TableAccess::HouseholdRead);
    cases.push(("shared SQL", shared));
    let mut shared = base();
    shared.database.owned_tables.push(table.clone());
    shared.database.access.insert(
        table,
        TableAccess::OwnerOrShare {
            resource_type: f.id.clone(),
            share_key: "id".into(),
        },
    );
    cases.push(("shared grants", shared));
    let mut credential = base();
    let mut cred: moss_module_host::manifest::Credential = serde_json::from_value(serde_json::json!({"scope":"instance","hosts":["example.test"],"attachment":{"kind":"header","name":"Authorization"}})).unwrap();
    cred.scope = CredentialScope::Instance;
    credential.credentials.insert("private".into(), cred);
    cases.push(("instance credential", credential));
    let mut core = base();
    core.lifecycle = Some(
        serde_json::from_value(
            serde_json::json!({"required":true,"bundled":true,"removable":false}),
        )
        .unwrap(),
    );
    cases.push(("core lifecycle", core));
    let mut dependency = base();
    dependency.optional_requires.insert(
        format!("local.{}.other", f.other.actor_user_id()),
        "*".parse().unwrap(),
    );
    cases.push(("other local owner dependency", dependency));
    let mut settings = base();
    settings
        .settings
        .push(serde_json::json!({"id":"private","label":"Private","description":"Private settings","path":"/private","scope":"admin"}));
    cases.push(("shared settings", settings));
    let mut storage = base();
    storage.install_wide_kv.insert("counter".into());
    cases.push(("install-wide KV", storage));
    for (kind, manifest) in cases {
        let bytes = archive::pack(&common::files(&manifest)).unwrap();
        assert!(
            f.signer.sign(&f.owner, &bytes).is_err(),
            "PRIVATE-DECLARATION-MARKER accepted {kind}"
        );
    }
}

#[test]
fn snapshot_resolution_is_owner_only() {
    let (f, host, _) = installed();
    f.install(&host, "2.0.0");
    let snapshot = host.snapshots(&f.owner).unwrap().pop().unwrap();
    let resolved = host
        .snapshot_for_restore(&f.owner, &snapshot.module, &snapshot.id)
        .unwrap();
    assert_eq!(resolved.id, snapshot.id);
    for actor in [&f.other, &f.admin] {
        assert!(
            host.snapshot_for_restore(actor, &snapshot.module, &snapshot.id)
                .is_err(),
            "PRIVATE-SNAPSHOT-MARKER resolved by non-builder"
        );
    }
}

#[test]
fn snapshot_listing_and_restore_are_owner_only() {
    let (f, host, _) = installed();
    f.install(&host, "2.0.0");
    let snapshots = host.snapshots(&f.owner).unwrap();
    assert!(!snapshots.is_empty());
    for actor in [&f.other, &f.admin] {
        assert!(
            host.snapshots(actor).unwrap().is_empty(),
            "PRIVATE-SNAPSHOT-MARKER leaked"
        );
        assert!(
            host.restore_snapshot(actor, snapshots.last().unwrap(), "Sample counter", true)
                .is_err(),
            "PRIVATE-SNAPSHOT-MARKER restored by non-builder"
        );
    }
    host.restore_snapshot(&f.owner, snapshots.last().unwrap(), "Sample counter", true)
        .unwrap();
}

#[path = "phase6_local_isolation/postgres.rs"]
mod postgres;

#[path = "phase6_local_isolation/collaboration.rs"]
mod collaboration;

#[path = "phase6_local_isolation/restart.rs"]
mod restart;

#[test]
fn account_switch_is_owner_only() {
    let (f, host, _) = installed();
    for actor in [&f.other, &f.admin] {
        assert!(
            host.set_enabled(actor, &f.id, false).is_err(),
            "PRIVATE-SWITCH-MARKER non-builder configured local package"
        );
    }
    host.set_enabled(&f.owner, &f.id, false).unwrap();
    assert!(host.call(&f.id, f.owner.clone(), "health", "{}").is_err());
    host.set_enabled(&f.owner, &f.id, true).unwrap();
    assert!(host
        .call(&f.id, f.owner.clone(), "health", "{}")
        .unwrap()
        .contains("PRIVATE-CODE-MARKER"));
}

#[test]
fn catalog_activity_is_owner_only() {
    use moss_module_host::{
        registry::RevocationLevel,
        revocation::{Activity, ActivityAction},
        store::CatalogStore,
    };
    let (f, host, digest) = installed();
    let mut state = f.saved.load().unwrap();
    state.activity.push(Activity {
        at: chrono::Utc::now(),
        module: f.id.clone(),
        digest,
        source: "local".into(),
        target: f.id.clone(),
        reason: "PRIVATE-ACTIVITY-MARKER".into(),
        level: RevocationLevel::Warn,
        action: ActivityAction::Revoked,
    });
    f.saved.commit(state.revision, &state).unwrap();
    assert_eq!(host.activity_for(&f.owner).unwrap().len(), 1);
    for actor in [&f.other, &f.admin] {
        assert!(
            host.activity_for(actor).unwrap().is_empty(),
            "PRIVATE-ACTIVITY-MARKER leaked"
        );
    }
}
