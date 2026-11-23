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

#[test]
fn other_account_and_admin_cannot_discover_invoke_or_remove_local_code() {
    use moss_module_host::{frame::AssetPolicy, store::CatalogStore};
    let f = fixture::Fixture::new();
    let host = f.open();
    f.install(&host, "1.0.0");
    let digest = f.saved.load().unwrap().installed[&f.id].digest.clone();
    let policy = AssetPolicy::new("https://moss.example.test").unwrap();
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
        assert!(
            host.screen(actor, &f.id, "/counter").is_err(),
            "PRIVATE-ASSET-MARKER screen leaked"
        );
        for kind in ["route", "tool", "job", "event", "api", "health"] {
            // call rejects raw tools; the feature-gated entry exercises the installed tool path.
            assert!(
                host.call(&f.id, actor.clone(), kind, "{}").is_err(),
                "private invocation {kind} reached guest for {}",
                actor.request_id()
            );
        }
        assert!(
            host.remove(actor, &f.id, None).is_err(),
            "non-builder removed local package"
        );
    }
    assert!(
        host.ui_asset(&f.id, &digest, "ui/index.html", &policy)
            .is_err(),
        "PRIVATE-ASSET-MARKER leaked through public assets"
    );
    assert!(
        host.export_list().unwrap().modules.is_empty(),
        "local identity leaked through portable export"
    );
}
