//! Real signed failures and owner-scoped package bytes, coordinated by files outside the repo.
use super::{common, fixtures};
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    archive,
    registry::{Artifact, Index, Revocation, RevocationLevel},
    trust::{self, RegistryIdentity},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    time::{Duration, Instant},
};
pub fn key_storage(root: &Path) {
    let paths = keystore::store::Paths::under(&root.join("key-config"), &root.join("key-data"));
    keystore::store::set_up(
        &paths,
        &keystore::probe::Keychain::NotInstalled,
        &keystore::recovery::RecoveryKey::generate(),
        &keystore::store::CredentialKeys::generate(),
    )
    .unwrap();
}
fn registry(keys: &common::Keys, folder: &Path, id: &str) -> Value {
    fixtures::publish(keys, folder, false, None);
    let mut identity: RegistryIdentity =
        serde_json::from_slice(&fs::read(folder.join("registry.json")).unwrap()).unwrap();
    identity.id = id.into();
    identity.name = format!("{id} registry");
    let bytes = serde_json::to_vec(&identity).unwrap();
    fs::write(folder.join("registry.json"), &bytes).unwrap();
    fs::write(
        folder.join("registry.json.sig"),
        common::Keys::sign(&keys.root, &bytes),
    )
    .unwrap();
    let mut files = BTreeMap::new();
    for name in [
        "registry.json",
        "registry.json.sig",
        "index.json",
        "index.json.sig",
    ] {
        files.insert(
            name.to_owned(),
            STANDARD.encode(fs::read(folder.join(name)).unwrap()),
        );
    }
    for entry in fs::read_dir(folder.join("packages")).unwrap() {
        let entry = entry.unwrap();
        files.insert(
            format!("packages/{}", entry.file_name().to_str().unwrap()),
            STANDARD.encode(fs::read(entry.path()).unwrap()),
        );
    }
    json!({"id":id,"rootKey":common::Keys::public(&keys.root),"files":files})
}
fn offer(keys: &common::Keys, folder: &Path, base: &Artifact, id: &str, name: &str) -> Artifact {
    let mut m = common::manifest("1.0.0");
    m.id = id.into();
    m.name = name.into();
    m.publisher = "Moss".into();
    let bytes = archive::pack(&common::files(&m)).unwrap();
    let mut a = base.clone();
    a.id = id.into();
    a.digest = trust::digest(&bytes);
    a.size = bytes.len() as u64;
    a.signature = common::Keys::sign(&keys.publisher, a.digest.as_bytes());
    a.presentation=Some(serde_json::from_value(json!({"name":name,"description":"Trust fixture","publisher":"Moss","category":"Testing","screenshots":[]})).unwrap());
    fs::write(folder.join(format!("packages/{}.mosspkg", a.digest)), bytes).unwrap();
    a
}
fn sign(keys: &common::Keys, folder: &Path, index: &mut Index) {
    index.serial += 1;
    let bytes = serde_json::to_vec(index).unwrap();
    fs::write(folder.join("index.json"), &bytes).unwrap();
    fs::write(
        folder.join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
}
pub fn serve(
    root: &Path,
    registry_folder: &Path,
    keys: &common::Keys,
    extra_keys: &common::Keys,
    hold: &Path,
    origin: &str,
    db: &tokio_postgres::Client,
    rt: &tokio::runtime::Runtime,
    member: uuid::Uuid,
) {
    fs::create_dir_all(hold).unwrap();
    let other = uuid::Uuid::new_v4();
    rt.block_on(async{
        db.execute("INSERT INTO app.users(id,name,email,email_verified,is_instance_admin,status) VALUES($1,'Second member','second-member@example.test',false,false,'active')",&[&other]).await.unwrap();
        db.execute("INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT gen_random_uuid(),$1::uuid::text,'credential',$1::uuid,password,now(),now() FROM app.auth_accounts WHERE user_id=(SELECT id FROM app.users WHERE email='bootstrap-owner@example.test') AND provider_id='credential'",&[&other]).await.unwrap();
    });
    let admin: uuid::Uuid = rt
        .block_on(db.query_one(
            "SELECT id FROM app.users WHERE email='bootstrap-owner@example.test'",
            &[],
        ))
        .unwrap()
        .get(0);
    let mut index: Index =
        serde_json::from_slice(&fs::read(registry_folder.join("index.json")).unwrap()).unwrap();
    let base = index.modules[0].clone();
    for width in ["control", "desktop", "phone"] {
        for kind in ["request", "decline", "import"] {
            index.modules.push(offer(
                keys,
                registry_folder,
                &base,
                &format!("{kind}-{width}"),
                &if kind == "import" {
                    format!("{kind} {width}")
                } else {
                    format!("{kind}-{width}")
                },
            ));
        }
        let imported = index
            .modules
            .iter()
            .find(|a| a.id == format!("import-{width}"))
            .unwrap();
        fs::copy(
            registry_folder.join(format!("packages/{}.mosspkg", imported.digest)),
            hold.join(format!("import-{width}.mosspkg")),
        )
        .unwrap();
        fs::write(
            hold.join(format!("import-{width}.sig")),
            &imported.signature,
        )
        .unwrap();
        fs::write(
            hold.join(format!("wrong-{width}.sig")),
            common::Keys::sign(&extra_keys.publisher, imported.digest.as_bytes()),
        )
        .unwrap();
        for kind in ["folder", "file", "wrong"] {
            let id = format!("{kind}-{width}");
            let folder = root.join(&id);
            let mut envelope = registry(extra_keys, &folder, &id);
            if kind == "wrong" {
                envelope["files"]["index.json.sig"] = json!(STANDARD.encode("invalid-signature"));
            }
            fs::write(hold.join(format!("{id}.json")), envelope.to_string()).unwrap();
        }
        let mut m = common::manifest("1.0.0");
        m.id = format!("local.{member}.trust-{width}");
        m.name = format!("Private {width}");
        m.screens
            .insert("/private".into(), "ui/private.html".into());
        m.navigation.push(json!({"id":"private","label":format!("Private {width}"),"path":"/private","icon":"package"}));
        m.routes.push(
            serde_json::from_value(json!({"method":"GET","path":"/read","signIn":true})).unwrap(),
        );
        let mut files = common::files(&m);
        files.insert(
            "ui/private.html".into(),
            b"<!doctype html><h1>Private builder package</h1>".to_vec(),
        );
        fs::write(
            hold.join(format!("local-{width}.mosspkg")),
            archive::pack(&files).unwrap(),
        )
        .unwrap();
    }
    sign(keys, registry_folder, &mut index);
    fs::write(hold.join("ready.json"),json!({"origin":origin,"instance":root,"member":member,"other":other,"admin":admin,"extraKey":common::Keys::public(&extra_keys.root)}).to_string()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1800);
    while !hold.join("release").exists() {
        assert!(Instant::now() < deadline, "browser trust deadline");
        let command = hold.join("command.json");
        if command.exists() {
            let input: Value = serde_json::from_slice(&fs::read(&command).unwrap()).unwrap();
            fs::remove_file(command).unwrap();
            match input["action"].as_str().unwrap() {
                "notices" => {
                    let width = input["width"].as_str().unwrap();
                    for (id, level) in [
                        ("catalog-notes".to_owned(), RevocationLevel::Block),
                        (format!("request-{width}"), RevocationLevel::Warn),
                    ] {
                        let artifact = index.modules.iter().find(|a| a.id == id).unwrap();
                        index.revoked.push(Revocation {
                            target: artifact.digest.clone(),
                            reason: if level == RevocationLevel::Block {
                                "Publisher key revoked."
                            } else {
                                "Publisher review pending."
                            }
                            .into(),
                            level,
                        });
                    }
                    sign(keys, registry_folder, &mut index);
                }
                "storage" => {
                    let row = rt
                        .block_on(db.query_one(
                            "SELECT state::text FROM moss_modules.catalog WHERE id=true",
                            &[],
                        ))
                        .unwrap();
                    let state: String = row.get(0);
                    fs::write(hold.join("catalog-digest"), trust::digest(state.as_bytes()))
                        .unwrap();
                }
                "offline" => fs::rename(registry_folder, root.join("offline-registry")).unwrap(),
                "online" => fs::rename(root.join("offline-registry"), registry_folder).unwrap(),
                _ => panic!("unknown trust command"),
            }
            fs::write(hold.join("reply"), input["id"].to_string()).unwrap();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("PASS phase6_trust_screens real signed registry, local owner and request fixtures");
}
