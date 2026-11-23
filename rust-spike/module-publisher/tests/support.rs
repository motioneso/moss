use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::{
    archive::pack,
    registry::{Artifact, Channel, Index},
    trust,
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap, process::Command};
use tempfile::TempDir;

pub fn key() -> Ed25519KeyPair {
    Ed25519KeyPair::from_pkcs8(
        Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .unwrap()
            .as_ref(),
    )
    .unwrap()
}
pub fn public(k: &Ed25519KeyPair) -> String {
    STANDARD.encode(k.public_key().as_ref())
}
pub fn sign(k: &Ed25519KeyPair, bytes: &[u8]) -> String {
    STANDARD.encode(k.sign(bytes).as_ref())
}
pub struct Fixture {
    pub dir: TempDir,
    pub files: RefCell<BTreeMap<String, Vec<u8>>>,
    root: Ed25519KeyPair,
    publisher: Ed25519KeyPair,
    index: Ed25519KeyPair,
    reviewer: Ed25519KeyPair,
}
impl Fixture {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("registry/packages")).unwrap();
        let index_pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        std::fs::write(dir.path().join("index.pk8"), index_pkcs8.as_ref()).unwrap();
        let manifest = json!({
            "schemaVersion":2,"id":"sample.counter","name":"Sample counter","description":"Publisher CLI fixture","publisher":"Sample publisher","version":"1.1.0","requiresMoss":">=0.1.0, <1.0.0","abi":"moss:module@1",
            "capabilities":[{"port":"kv","operations":["get","set"],"resources":["counter"]}],
            "icons":["icons/counter.svg"],"accounts":{"supportsUserDisable":true,"defaultEnabled":true},
            "features":[{"id":"sample.counter","description":"Saves a value through the host"}]
        });
        let wasm = wat::parse_str(include_str!("../../module-host/sample/module.wat")).unwrap();
        let files = BTreeMap::from([
            (
                "moss.module.json".into(),
                serde_json::to_vec(&manifest).unwrap(),
            ),
            ("code/module.wasm".into(), wasm),
            ("icons/counter.svg".into(), b"<svg/>".to_vec()),
            ("LICENSE".into(), b"MIT".to_vec()),
            ("NOTICE".into(), b"Fixture".to_vec()),
            ("CHANGELOG.md".into(), b"Fixture update".to_vec()),
        ]);
        let f = Self {
            dir,
            files: RefCell::new(files),
            root: key(),
            publisher: key(),
            index: Ed25519KeyPair::from_pkcs8(index_pkcs8.as_ref()).unwrap(),
            reviewer: key(),
        };
        // This old package uses the same real Wasm and the previous manifest version.
        let mut prior = f.files.borrow().clone();
        let mut m: Value = serde_json::from_slice(&prior["moss.module.json"]).unwrap();
        m["version"] = json!("1.0.0");
        prior.insert("moss.module.json".into(), serde_json::to_vec(&m).unwrap());
        let artifact = f.store_prior(&prior);
        let identity = json!({"id":"moss","name":"Moss fixture","rootFingerprint":trust::digest(f.root.public_key().as_ref()),
            "indexKeys":{"online":public(&f.index)},"publishers":{"sample":{"key":public(&f.publisher),"prefix":"sample"}}});
        f.write_signed("registry.json", &identity, &f.root);
        let index = Index {
            publish_reviews: Default::default(),
            serial: 1,
            expires: chrono::Utc::now() + chrono::Duration::days(1),
            signing_key: "online".into(),
            modules: vec![artifact],
            revoked: vec![],
        };
        f.write_signed(
            "index.json",
            &serde_json::to_value(index).unwrap(),
            &f.index,
        );
        let config = json!({"registryPath":f.dir.path().join("registry"),"rootKey":public(&f.root),"firstPartyKey":public(&f.root),"mossVersion":"0.1.0","registryId":"moss","policy":"moss","reviewerKeys":{"human":public(&f.reviewer)}});
        f.write_json("config.json", &config);
        f.write_package();
        f
    }
    fn write_signed(&self, name: &str, value: &Value, key: &Ed25519KeyPair) {
        let bytes = serde_json::to_vec(value).unwrap();
        std::fs::write(self.dir.path().join("registry").join(name), &bytes).unwrap();
        std::fs::write(
            self.dir.path().join("registry").join(format!("{name}.sig")),
            sign(key, &bytes),
        )
        .unwrap();
    }
    fn write_json(&self, name: &str, value: &Value) {
        std::fs::write(
            self.dir.path().join(name),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    pub fn edit_config(&self, edit: impl FnOnce(&mut Value)) {
        self.edit_json("config.json", edit);
    }
    pub fn edit_submission(&self, edit: impl FnOnce(&mut Value)) {
        self.edit_json("submission.json", edit);
    }
    fn edit_json(&self, name: &str, edit: impl FnOnce(&mut Value)) {
        let mut v =
            serde_json::from_slice(&std::fs::read(self.dir.path().join(name)).unwrap()).unwrap();
        edit(&mut v);
        self.write_json(name, &v);
    }
    pub fn edit_index(&self, edit: impl FnOnce(&mut Value)) {
        let mut v = serde_json::from_slice(
            &std::fs::read(self.dir.path().join("registry/index.json")).unwrap(),
        )
        .unwrap();
        edit(&mut v);
        self.write_signed("index.json", &v, &self.index);
    }
    pub fn clear_history(&self) {
        self.edit_index(|i| i["modules"] = json!([]));
    }
    pub fn edit_manifest(&self, edit: impl FnOnce(&mut Value)) {
        let mut m = serde_json::from_slice(&self.files.borrow()["moss.module.json"]).unwrap();
        edit(&mut m);
        self.files
            .borrow_mut()
            .insert("moss.module.json".into(), serde_json::to_vec(&m).unwrap());
        self.write_package();
    }
    pub fn write_package(&self) {
        let bytes = pack(&self.files.borrow()).unwrap();
        std::fs::write(self.dir.path().join("candidate.mosspkg"), &bytes).unwrap();
        self.write_json("submission.json",&json!({"packagePath":self.dir.path().join("candidate.mosspkg"),"publisherKey":"sample","signature":sign(&self.publisher,trust::digest(&bytes).as_bytes())}));
    }
    pub fn digest(&self) -> String {
        trust::digest(&std::fs::read(self.dir.path().join("candidate.mosspkg")).unwrap())
    }
    fn run(&self, command: &str, approval: Option<&Value>) -> std::process::Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_moss-module-publisher"));
        cmd.arg(command)
            .arg(self.dir.path().join("config.json"))
            .arg(self.dir.path().join("submission.json"));
        if command == "publish" {
            cmd.arg(self.dir.path().join("index.pk8"));
            if let Some(a) = approval {
                self.write_json("approval.json", a);
                cmd.arg(self.dir.path().join("approval.json"));
            }
        }
        cmd.output().unwrap()
    }
    pub fn review_ok(&self) -> Value {
        self.ok("review", None)
    }
    pub fn publish_ok(&self, approval: Option<&Value>) -> Value {
        self.ok("publish", approval)
    }
    fn ok(&self, command: &str, approval: Option<&Value>) -> Value {
        let output = self.run(command, approval);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    pub fn refused(&self, command: &str, approval: Option<&Value>, reason: &str) {
        let output = self.run(command, approval);
        assert!(!output.status.success(), "Expected refusal: {reason}");
        assert!(
            output.stdout.is_empty(),
            "Refused command emitted publication bytes"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(reason), "Expected {reason}, got {stderr}");
    }
    pub fn approve(&self) -> Value {
        self.sign_request(self.review_ok())
    }
    pub fn sign_request(&self, request: Value) -> Value {
        let request_bytes = moss_module_publisher::approval_bytes(
            &serde_json::from_value(request.clone()).unwrap(),
        )
        .unwrap();
        json!({"request":request,"reviewer":"human","signature":sign(&self.reviewer,&request_bytes)})
    }
    pub fn verify_index(&self, envelope: &Value) {
        trust::verify(
            &public(&self.index),
            envelope["index"].as_str().unwrap().as_bytes(),
            envelope["signature"].as_str().unwrap(),
        )
        .unwrap();
        let _: Index = serde_json::from_str(envelope["index"].as_str().unwrap()).unwrap();
    }
    fn store_prior(&self, files: &BTreeMap<String, Vec<u8>>) -> Artifact {
        let bytes = pack(files).unwrap();
        let digest = trust::digest(&bytes);
        let m: moss_module_host::manifest::Manifest =
            serde_json::from_slice(&files["moss.module.json"]).unwrap();
        std::fs::write(
            self.dir
                .path()
                .join(format!("registry/packages/{digest}.mosspkg")),
            &bytes,
        )
        .unwrap();
        Artifact {
            id: m.id,
            version: m.version,
            digest: digest.clone(),
            size: bytes.len() as u64,
            publisher_key: "sample".into(),
            signature: sign(&self.publisher, digest.as_bytes()),
            requires_moss: m.requires_moss,
            abi: m.abi,
            capabilities: m.capabilities,
            migrations: m.database.migrations,
            requires: m.requires,
            changelog: "Fixture".into(),
            channel: Channel::Stable,
            urgent: false,
        }
    }
    pub fn add_prior_sql(&self) {
        self.edit_manifest(|m| m["database"] = json!({"migrations":["sql/001_create.sql"]}));
        self.files.borrow_mut().insert(
            "sql/001_create.sql".into(),
            b"CREATE TABLE app.sample_counter_rows (id uuid);".to_vec(),
        );
        self.write_package();
        let mut files = self.files.borrow().clone();
        let mut m: Value = serde_json::from_slice(&files["moss.module.json"]).unwrap();
        m["version"] = json!("1.0.0");
        files.insert("moss.module.json".into(), serde_json::to_vec(&m).unwrap());
        let a = self.store_prior(&files);
        self.edit_index(|i| i["modules"] = json!([a]));
    }
    pub fn corrupt_prior(&self) {
        let index: Value = serde_json::from_slice(
            &std::fs::read(self.dir.path().join("registry/index.json")).unwrap(),
        )
        .unwrap();
        let digest = index["modules"][0]["digest"].as_str().unwrap();
        let size = index["modules"][0]["size"].as_u64().unwrap() as usize;
        let mut files = self.files.borrow().clone();
        let mut m: Value = serde_json::from_slice(&files["moss.module.json"]).unwrap();
        m["version"] = json!("1.0.0");
        files.insert("moss.module.json".into(), serde_json::to_vec(&m).unwrap());
        for n in 0..=255u8 {
            files.insert("LICENSE".into(), vec![n, b'I', b'T']);
            let bytes = pack(&files).unwrap();
            if bytes.len() == size && trust::digest(&bytes) != digest {
                std::fs::write(
                    self.dir
                        .path()
                        .join(format!("registry/packages/{digest}.mosspkg")),
                    bytes,
                )
                .unwrap();
                return;
            }
        }
        panic!("Could not construct equal-sized tampered archive");
    }
    pub fn set_prior_requirement(&self, requirement: &str) {
        let mut files = self.files.borrow().clone();
        let mut m: Value = serde_json::from_slice(&files["moss.module.json"]).unwrap();
        m["version"] = json!("1.0.0");
        m["requiresMoss"] = json!(requirement);
        files.insert("moss.module.json".into(), serde_json::to_vec(&m).unwrap());
        let a = self.store_prior(&files);
        self.edit_index(|i| i["modules"] = json!([a]));
    }
    pub fn replace_index_key(&self) {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        std::fs::write(self.dir.path().join("index.pk8"), pkcs8.as_ref()).unwrap();
    }
    pub fn add_newer_history(&self) {
        let mut files = self.files.borrow().clone();
        let mut m: Value = serde_json::from_slice(&files["moss.module.json"]).unwrap();
        m["version"] = json!("1.2.0");
        files.insert("moss.module.json".into(), serde_json::to_vec(&m).unwrap());
        let a = self.store_prior(&files);
        self.edit_index(|i| {
            i["modules"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::to_value(a).unwrap())
        });
    }
}
