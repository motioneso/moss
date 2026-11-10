mod common;
use moss_module_host::manifest::Tool;

#[test]
fn manifest_retains_exact_people_names_without_relaxing_module_ids() {
    let mut manifest = common::manifest("0.1.0");
    for name in [
        "people.resolve",
        "people.getContext",
        "people.listRecent",
        "people.acceptMatch",
        "people.rejectMatch",
        "people.merge",
        "people.splitIdentity",
    ] {
        manifest.tools.insert(
            name.into(),
            Tool {
                approval_version: false,
                description: "Existing People tool".into(),
                risk: "read".into(),
            },
        );
    }
    let version = "0.1.0".parse().unwrap();
    manifest.validate(&version).unwrap();
    manifest.id = "sample.Counter".into();
    assert!(manifest.validate(&version).is_err());
    manifest.id = "sample.counter".into();
    manifest.tools.insert(
        "people/merge".into(),
        Tool {
            approval_version: false,
            description: "Unsafe name".into(),
            risk: "write".into(),
        },
    );
    assert!(manifest.validate(&version).is_err());
}
