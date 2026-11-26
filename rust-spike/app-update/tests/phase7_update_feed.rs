use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Duration, Utc};
use moss_app_update::{trust, Artifact, Client, Index, Seen};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use std::{fs, process::Command};

struct Fixture {
    key: Ed25519KeyPair,
    client: Client,
    index: Index,
}
impl Fixture {
    fn new() -> Self {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        Self {
            client: Client {
                key_id: "test-app".into(),
                public_key: STANDARD.encode(key.public_key().as_ref()),
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                schema: 42,
            },
            key,
            index: Index {
                serial: 10,
                expires: Utc::now() + Duration::hours(1),
                signing_key: "test-app".into(),
                artifacts: vec![Artifact {
                    os: std::env::consts::OS.into(),
                    arch: std::env::consts::ARCH.into(),
                    version: "1.0.0".into(),
                    url: "https://github.com/motioneso/moss/releases/download/test/app".into(),
                    digest: trust::digest(b"artifact"),
                    size: 8,
                    schema_min: 40,
                    schema_max: 43,
                }],
            },
        }
    }
    fn signed(&self) -> (Vec<u8>, String) {
        let bytes = serde_json::to_vec(&self.index).unwrap();
        let sig = STANDARD.encode(self.key.sign(&bytes).as_ref());
        (bytes, sig)
    }
    fn check(&self, seen: &Seen) -> anyhow::Result<(Artifact, Seen)> {
        let (bytes, sig) = self.signed();
        self.client.check(&bytes, &sig, seen, Utc::now())
    }
}
#[test]
fn phase7_update_feed() {
    let mut f = Fixture::new();
    let (artifact, seen) = f.check(&Seen::default()).unwrap();
    artifact.verify_bytes(b"artifact").unwrap();
    f.check(&seen).unwrap(); // An identical serial is safe; equivocation isn't.
    let (bytes, sig) = f.signed();
    assert!(
        f.client
            .check(&bytes, "", &Seen::default(), Utc::now())
            .is_err(),
        "UNSIGNED-GUARD"
    );
    let mut changed = bytes.clone();
    changed.push(b' ');
    assert!(
        f.client.check(&changed, &sig, &seen, Utc::now()).is_err(),
        "changed signed bytes"
    );
    let other = Fixture::new();
    assert!(
        other
            .client
            .check(&bytes, &sig, &Seen::default(), Utc::now())
            .is_err(),
        "wrong trusted key"
    );
    f.index.serial = 9;
    assert!(f.check(&seen).is_err(), "OLDER-SERIAL-GUARD");
    f.index.serial = 10;
    f.index.artifacts[0].version = "2.0.0".into();
    assert!(f.check(&seen).is_err(), "serial equivocation");
    f.index.serial = 11;
    f.index.expires = Utc::now() - Duration::seconds(1);
    assert!(f.check(&seen).is_err(), "EXPIRED-GUARD");
    f.index.expires = Utc::now() + Duration::hours(1);
    assert!(
        artifact.verify_bytes(b"tampered").is_err(),
        "WRONG-HASH-GUARD"
    );
    f.index.artifacts[0].os = if f.client.os == "linux" {
        "windows"
    } else {
        "linux"
    }
    .into();
    assert!(f.check(&seen).is_err(), "WRONG-OS-GUARD");
    f.index.artifacts[0].os = f.client.os.clone();
    f.index.artifacts[0].arch = if f.client.arch == "x86_64" {
        "aarch64"
    } else {
        "x86_64"
    }
    .into();
    assert!(f.check(&seen).is_err(), "WRONG-ARCH-GUARD");
    f.index.artifacts[0].arch = f.client.arch.clone();
    f.index.artifacts[0].schema_min = 43;
    assert!(f.check(&seen).is_err(), "WRONG-SCHEMA-GUARD");
    f.index.artifacts[0].schema_min = 1;
    f.index.artifacts[0].schema_max = 41;
    assert!(f.check(&seen).is_err(), "schema upper bound");
    f.index.artifacts[0].schema_max = 43;
    f.check(&seen).unwrap();
    println!("phase7_update_feed: signed positive and all required refusals passed");
}
#[test]
fn cli_persists_serial_and_refuses_without_changing_state() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut f = Fixture::new();
    fs::write(root.join("public"), &f.client.public_key).unwrap();
    let state = root.join("seen.json");
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_moss-app-update"))
            .arg("check")
            .arg(root)
            .arg("test-app")
            .arg(root.join("public"))
            .arg(&state)
            .arg("42")
            .output()
            .unwrap()
    };
    let write = |f: &Fixture| {
        let (bytes, sig) = f.signed();
        fs::write(root.join("index.json"), bytes).unwrap();
        fs::write(root.join("index.json.sig"), sig).unwrap();
    };
    write(&f);
    assert!(run().status.success());
    let saved = fs::read(&state).unwrap();
    f.index.serial -= 1;
    write(&f);
    assert!(!run().status.success());
    assert_eq!(saved, fs::read(&state).unwrap());
    fs::write(&state, "corrupt").unwrap();
    assert!(
        !run().status.success(),
        "corrupt state must not reset serial"
    );
}
