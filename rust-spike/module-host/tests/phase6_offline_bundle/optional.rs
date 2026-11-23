use super::*;
use moss_module_host::bundle::{Bundle, BundleItem};

#[test]
fn optional_bytes_are_validated_before_caching() {
    let data = tempfile::tempdir().unwrap();
    let actor = uuid::Uuid::new_v4();
    let installer = Installer::new(
        data.path(),
        Arc::new(Memory::default()),
        Arc::new(FileLifecycle::new(data.path(), BTreeSet::from([actor])).unwrap()),
        Host::new(Limits::default()).unwrap(),
        Arc::new(LocalPorts::new(data.path()).unwrap()),
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let keys = common::Keys::new();
    let public = common::Keys::public(&keys.publisher);
    for fault in ["signature", "name", "imports", "sql"] {
        let mut manifest = common::manifest("1.0.0");
        manifest.id = "finance".into();
        if fault == "imports" {
            manifest.capabilities.clear();
        }
        if fault == "sql" {
            manifest.database.migrations.push("sql/0001_bad.sql".into());
        }
        let mut files = common::files(&manifest);
        if fault == "sql" {
            files.insert(
                "sql/0001_bad.sql".into(),
                b"DROP SCHEMA public CASCADE;".to_vec(),
            );
        }
        let bytes = moss_module_host::archive::pack(&files).unwrap();
        let digest = trust::digest(&bytes);
        let signer = if fault == "signature" {
            &keys.root
        } else {
            &keys.publisher
        };
        let signature = common::Keys::sign(signer, digest.as_bytes());
        let id = if fault == "name" { "meals" } else { "finance" };
        let items = [BundleItem {
            package: BundledPackage {
                id,
                digest: &digest,
                signature: &signature,
            },
            bytes: &bytes,
            default: false,
        }];
        assert!(
            Bundle {
                registry: "moss",
                first_party_key: &public,
                packages: &items
            }
            .bootstrap(&installer, &AccessContext::new(actor, "bundle"))
            .is_err(),
            "Expected refusal: optional {fault}"
        );
        assert!(
            installer.read_package(&digest).is_err(),
            "Rejected optional bytes must not be cached"
        );
    }
}
