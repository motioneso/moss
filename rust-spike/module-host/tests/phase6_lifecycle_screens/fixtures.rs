//! Signed packages, real module ledger rows and host snapshot expiry. No HTTP substitution.
use super::common;
use moss_module_host::{
    archive,
    registry::{Artifact, Index},
    trust,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};
fn offer(
    keys: &common::Keys,
    folder: &Path,
    base: &Artifact,
    width: &str,
    version: &str,
) -> Artifact {
    let id = format!("lifecycle-{width}");
    let name = format!("Finance {width}");
    let table = format!("app.lifecycle__{width}_ledger");
    let mut m = common::manifest(version);
    m.id = id.clone();
    m.name = name.clone();
    m.publisher = "Moss".into();
    m.database.owned_tables = vec![table.clone()];
    m.database.migrations = vec!["sql/001_ledger.sql".into()];
    if version != "1.0.0" {
        m.capabilities[0].resources.insert("reminders".into());
        m.database.migrations.push("sql/002_amounts.sql".into());
    }
    let mut files = common::files(&m);
    let sql=format!("CREATE TABLE {table} (id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES app.users(id), amount integer NOT NULL, title text NOT NULL);");
    files.insert("sql/001_ledger.sql".into(), sql.as_bytes().to_vec());
    if version != "1.0.0" {
        files.insert(
            "sql/002_amounts.sql".into(),
            format!("UPDATE {table} SET amount=0;").into_bytes(),
        );
        files.insert(
            "code/module.wasm".into(),
            wat::parse_str(common::unhealthy_source()).unwrap(),
        );
    }
    let bytes = archive::pack(&files).unwrap();
    let mut a = base.clone();
    a.id = id;
    a.version = version.parse().unwrap();
    a.digest = trust::digest(&bytes);
    a.size = bytes.len() as u64;
    a.signature = common::Keys::sign(&keys.publisher, a.digest.as_bytes());
    a.capabilities = m.capabilities;
    a.migrations = m.database.migrations;
    a.urgent = version != "1.0.0";
    a.changelog = "Bill reminders arrive on time.".into();
    a.presentation=Some(serde_json::from_value(json!({"name":name,"description":"Lifecycle ledger fixture","publisher":"Moss","category":"Testing","screenshots":[]})).unwrap());
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
    registry: &Path,
    keys: &common::Keys,
    hold: &Path,
    origin: &str,
    db: &tokio_postgres::Client,
    rt: &tokio::runtime::Runtime,
) {
    let mut index: Index =
        serde_json::from_slice(&fs::read(registry.join("index.json")).unwrap()).unwrap();
    let base = index.modules[0].clone();
    for width in ["desktop", "phone"] {
        index
            .modules
            .push(offer(keys, registry, &base, width, "1.0.0"));
    }
    sign(keys, registry, &mut index);
    fs::create_dir_all(hold).unwrap();
    fs::write(
        hold.join("ready.json"),
        json!({"origin":origin,"instance":root,"registry":registry}).to_string(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(1800);
    while !hold.join("release").exists() {
        assert!(Instant::now() < deadline, "lifecycle browser deadline");
        let command = hold.join("command.json");
        if command.exists() {
            let v: Value = serde_json::from_slice(&fs::read(&command).unwrap()).unwrap();
            let width = v["width"].as_str().unwrap();
            assert!(["desktop", "phone"].contains(&width));
            let table = format!("app.lifecycle__{width}_ledger");
            match v["action"].as_str().unwrap() {
                "plant" => {
                    rt.block_on(db.batch_execute(&format!("INSERT INTO {table}(id,owner_user_id,amount,title) SELECT gen_random_uuid(),id,42013,'planted ledger row' FROM app.users WHERE email IN ('bootstrap-owner@example.test','policy-member@example.test')"))).unwrap();
                }
                "rows" => {
                    let rows=rt.block_on(db.query(&format!("SELECT id::text,owner_user_id::text,amount,title FROM {table} ORDER BY id"),&[])).unwrap().iter().map(|r|json!({"id":r.get::<_,String>(0),"owner":r.get::<_,String>(1),"amount":r.get::<_,i32>(2),"title":r.get::<_,String>(3)})).collect::<Vec<_>>();
                    fs::write(hold.join("rows.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
                }
                "grow" => {
                    index
                        .modules
                        .push(offer(keys, registry, &base, width, "1.1.0"));
                    sign(keys, registry, &mut index);
                }
                "base" => {
                    index.modules.retain(|a| {
                        a.id != format!("lifecycle-{width}") || a.version.to_string() == "1.0.0"
                    });
                    sign(keys, registry, &mut index);
                }
                "expire" => {
                    let id = v["snapshot"].as_str().unwrap();
                    assert!(uuid::Uuid::parse_str(id).is_ok());
                    let path = root.join(format!(
                        "modules/modules/snapshots/lifecycle-{width}/{id}/snapshot.json"
                    ));
                    let mut s: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    s["expires"] =
                        json!((chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339());
                    fs::write(path, serde_json::to_vec(&s).unwrap()).unwrap();
                }
                _ => panic!("unknown lifecycle command"),
            }
            fs::remove_file(command).unwrap();
            fs::write(hold.join("reply"), v["id"].to_string()).unwrap();
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
