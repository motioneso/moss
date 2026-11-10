mod common;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{
    archive::pack,
    frame::AssetPolicy,
    lifecycle::FileLifecycle,
    local::LocalPorts,
    registry::Source,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct Catalog(Mutex<State>);
impl CatalogStore for Catalog {
    fn load(&self) -> Result<State> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn commit(&self, expected: u64, next: &State) -> Result<()> {
        let mut s = self.0.lock().unwrap();
        ensure!(s.revision == expected, "stale");
        *s = next.clone();
        Ok(())
    }
}
#[test]
fn installed_screens_use_verified_versioned_opaque_assets() {
    let d = tempfile::tempdir().unwrap();
    let r = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(r.path(), "1.0.0", 1, vec![]);
    let access = AccessContext::new(uuid::Uuid::new_v4(), "frame");
    let i = Installer::new(
        d.path(),
        Arc::new(Catalog::default()),
        Arc::new(FileLifecycle::new(d.path(), [access.actor_user_id()].into()).unwrap()),
        Host::new(Limits::default()).unwrap(),
        Arc::new(LocalPorts::new(d.path()).unwrap()),
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let source = i
        .refresh(
            &access,
            Source::Folder(r.path().into()),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    let mut m = common::manifest("1.0.0");
    m.screens.insert("/counter".into(), "ui/index.html".into());
    let mut files = common::files(&m);
    files.insert(
        "ui/index.html".into(),
        b"<!doctype html><title>Counter</title>".to_vec(),
    );
    files.insert("ui/app.js".into(), b"document.title = 'Counter';".to_vec());
    let bytes = pack(&files).unwrap();
    let digest = moss_module_host::trust::digest(&bytes);
    i.import_file(
        &access,
        &source,
        &bytes,
        &common::Keys::sign(&keys.publisher, digest.as_bytes()),
        "sample",
        true,
    )
    .unwrap();
    let screen = i.screen(&access, "sample.counter", "/counter").unwrap();
    assert_eq!(screen.sandbox, "allow-scripts allow-forms");
    assert!(screen.src.contains(&digest));
    assert!(screen.src.ends_with("/ui/index.html"));
    let policy = AssetPolicy::new("https://moss.example.test").unwrap();
    let asset = i
        .ui_asset("sample.counter", &digest, "ui/index.html", &policy)
        .unwrap();
    assert_eq!(asset.body, files["ui/index.html"]);
    assert_eq!(asset.content_type, "text/html; charset=utf-8");
    let csp = &asset.headers["Content-Security-Policy"];
    assert!(csp.contains("sandbox allow-scripts allow-forms"));
    assert!(!csp.contains("allow-same-origin"));
    assert!(csp.contains("'wasm-unsafe-eval'"));
    assert!(csp.contains("style-src-attr 'unsafe-inline'"));
    assert!(!csp
        .split("script-src ")
        .nth(1)
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .contains("'unsafe-inline'"));
    assert_eq!(asset.headers["Access-Control-Allow-Origin"], "null");
    assert!(!asset
        .headers
        .contains_key("Access-Control-Allow-Credentials"));
    for path in [
        "sql/0001.sql",
        "../code/module.wasm",
        "ui/../../code/module.wasm",
        "ui/index.html?x",
    ] {
        assert!(i
            .ui_asset("sample.counter", &digest, path, &policy)
            .is_err());
    }
    assert!(i
        .ui_asset("sample.counter", &"0".repeat(64), "ui/index.html", &policy)
        .is_err());
    let changed = d
        .path()
        .join("modules/installed/sample.counter/1.0.0/ui/app.js");
    let mut permissions = std::fs::metadata(&changed).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o600);
    }
    #[cfg(not(unix))]
    permissions.set_readonly(false);
    std::fs::set_permissions(&changed, permissions).unwrap();
    std::fs::write(&changed, b"changed").unwrap();
    assert!(i.screen(&access, "sample.counter", "/counter").is_err());
}
#[test]
fn asset_policy_refuses_untrusted_origin_shapes() {
    for origin in [
        "null",
        "https://user:pass@example.test",
        "https://example.test/other",
        "https://example.test?x",
        "data:text/html,hello",
    ] {
        assert!(AssetPolicy::new(origin).is_err());
    }
}
