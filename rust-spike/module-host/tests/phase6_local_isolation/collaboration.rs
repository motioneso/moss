use super::{common, fixture};
use moss_module_host::{archive, registry::Source};
use serde_json::json;

#[test]
fn public_api_and_event_providers_stay_private_to_builder() {
    let f = fixture::Fixture::new();
    let host = f.open();
    f.install(&host, "1.0.0");
    // A local event provider publishes an actual marker through the service adapter.
    let event_id = format!("{}.events", f.id);
    let mut provider = common::manifest("1.0.0");
    provider.id = event_id.clone();
    provider.capabilities = vec![serde_json::from_value(
        json!({"port":"events","operations":["publish"],"resources":["private.marker"]}),
    )
    .unwrap()];
    provider
        .provides
        .insert("private.marker".into(), "1.0.0".parse().unwrap());
    let mut files = common::files(&provider);
    files.insert(
        "code/module.wasm".into(),
        wat::parse_str(
            include_str!("../../sample/module.wat").replace("moss:module/kv", "moss:module/events"),
        )
        .unwrap(),
    );
    let bytes = archive::pack(&files).unwrap();
    let signature = f.signer.sign(&f.owner, &bytes).unwrap();
    host.install_local(&f.owner, &f.signer, &bytes, &signature, true)
        .unwrap();
    host.call(&event_id, f.owner.clone(), "route", &json!({"operation":"publish","resource":"private.marker","parameters":{"marker":"PRIVATE-EVENT-MARKER"}}).to_string()).unwrap();

    // A downloaded subscriber runs for every account. Its dependency declaration alone
    // must not grant any account access to the builder's provider.
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let catalog = host
        .refresh(
            &f.admin,
            Source::Folder(registry.path().into()),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    let mut subscriber = common::manifest("1.0.0");
    subscriber.id = "sample.subscriber".into();
    subscriber
        .requires
        .insert(event_id.clone(), "*".parse().unwrap());
    subscriber.capabilities = vec![serde_json::from_value(
        json!({"port":"events","operations":["subscribe","poll"],"resources":["private.marker"]}),
    )
    .unwrap()];
    let mut files = common::files(&subscriber);
    files.insert(
        "code/module.wasm".into(),
        wat::parse_str(
            include_str!("../../sample/module.wat").replace("moss:module/kv", "moss:module/events"),
        )
        .unwrap(),
    );
    let bytes = archive::pack(&files).unwrap();
    host.import_file(
        &f.admin,
        &catalog,
        &bytes,
        &common::Keys::sign(
            &keys.publisher,
            moss_module_host::trust::digest(&bytes).as_bytes(),
        ),
        "sample",
        true,
    )
    .unwrap();
    let request = |op: &str| {
        json!({"operation":op,"resource":"private.marker","parameters":{"module":event_id}})
            .to_string()
    };
    host.call(
        &subscriber.id,
        f.owner.clone(),
        "route",
        &request("subscribe"),
    )
    .unwrap();
    assert!(host
        .call(&subscriber.id, f.owner.clone(), "route", &request("poll"))
        .unwrap()
        .contains("PRIVATE-EVENT-MARKER"));
    for actor in [&f.other, &f.admin] {
        let result = host.call(
            &subscriber.id,
            actor.clone(),
            "route",
            &request("subscribe"),
        );
        assert!(
            result.is_err(),
            "PRIVATE-EVENT-MARKER provider accepted non-builder: {result:?}"
        );
    }

    subscriber.version = "2.0.0".parse().unwrap();
    subscriber
        .requires
        .insert(f.id.clone(), "*".parse().unwrap());
    subscriber.capabilities = vec![serde_json::from_value(
        json!({"port":"api","operations":["call"],"resources":[f.id]}),
    )
    .unwrap()];
    let mut files = common::files(&subscriber);
    files.insert(
        "code/module.wasm".into(),
        wat::parse_str(
            include_str!("../../sample/module.wat").replace("moss:module/kv", "moss:module/api"),
        )
        .unwrap(),
    );
    let bytes = archive::pack(&files).unwrap();
    host.import_file(
        &f.admin,
        &catalog,
        &bytes,
        &common::Keys::sign(
            &keys.publisher,
            moss_module_host::trust::digest(&bytes).as_bytes(),
        ),
        "sample",
        true,
    )
    .unwrap();
    let request = json!({"operation":"call","resource":f.id,"parameters":{"name":"private.read","parameters":{}}}).to_string();
    assert!(host
        .call(&subscriber.id, f.owner.clone(), "route", &request)
        .unwrap()
        .contains("PRIVATE-CODE-MARKER"));
    for actor in [&f.other, &f.admin] {
        let result = host.call(&subscriber.id, actor.clone(), "route", &request);
        assert!(
            result.is_err(),
            "PRIVATE-CODE-MARKER public API accepted non-builder: {result:?}"
        );
    }
}
