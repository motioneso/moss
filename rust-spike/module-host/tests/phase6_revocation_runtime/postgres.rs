use super::common;
use access_context::AccessContext;
use moss_module_host::{
    ai::Intelligence,
    application::{Application, Configuration},
    jobs::{manifest_hash, module_key, specs},
    manifest::{Manifest, Route},
    postgres::PostgresCatalog,
    registry::{Artifact, Index, Revocation, RevocationLevel, Source},
    runtime::{CallScope, Request},
    store::CatalogStore,
};
use moss_platform_contracts::Actor;
use moss_platform_jobs::{Queue, Role};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::{Secret, SecretCipher},
};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};

struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("No AI")
    }
}
fn open(data: &Path, db: Database, admin: &AccessContext) -> Application {
    Application::open_extended(
        data,
        db,
        admin.clone(),
        Configuration {
            migrations: Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS43_APP_URL").unwrap()),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: None,
            browser_dir: None,
        },
    )
    .unwrap()
}
fn publish(keys: &common::Keys, folder: &Path) -> (Artifact, Manifest) {
    let mut artifact = keys.write(folder, "1.0.0", 1, vec![]);
    let mut manifest = common::manifest("1.0.0");
    manifest.routes.push(Route {
        method: "GET".into(),
        path: "/health".into(),
        sign_in: true,
    });
    manifest.jobs.insert("tick".into(), Default::default());
    manifest.capabilities.push(serde_json::from_value(json!({
        "port":"jobs", "operations":["enqueue"], "resources":["tick"]
    })).unwrap());
    manifest.tools.insert(
        "sample.read".into(),
        serde_json::from_value(json!({
            "description":"Read test status", "risk":"read", "approvalVersion":false,
            "inputSchema":{"type":"object","properties":{},"required":[],"examples":[{}]}
        }))
        .unwrap(),
    );
    manifest
        .screens
        .insert("/counter".into(), "ui/index.html".into());
    manifest
        .navigation
        .push(json!({"id":"counter","label":"Counter","path":"/counter","icon":"package"}));
    let reply = r#"{"status":200,"body":{"live":true}}"#;
    let set = r#"{"operation":"set","resource":"counter","parameters":{"worker":"ran"}}"#;
    let encode = |s: &str| s.bytes().map(|b| format!("\\{b:02x}")).collect::<String>();
    let mut source = include_str!("../../sample/module.wat").replace("(data (i32.const 128) \"healthy\")", &format!("(data (i32.const 128) \"healthy\") (data (i32.const 256) \"{}\") (data (i32.const 1024) \"{}\")", encode(reply), encode(set)));
    let start = source.find("      local.get $kind i32.load8_u").unwrap();
    let end = source[start..].find("      i32.const 32))").unwrap() + start;
    source.replace_range(
        start..end,
        &format!(
            r#"
      i32.const 32 i32.const 0 i32.store
      i32.const 36 i32.const 128 i32.store
      i32.const 40 i32.const 7 i32.store
      local.get $kind i32.load8_u i32.const 114 i32.eq if
        i32.const 36 i32.const 256 i32.store i32.const 40 i32.const {} i32.store
      end
      local.get $kind i32.load8_u i32.const 116 i32.eq if
        i32.const 36 local.get $payload i32.store i32.const 40 local.get $length i32.store
      end
      local.get $kind i32.load8_u i32.const 106 i32.eq if
        i32.const 1024 i32.const {} i32.const 32 call $kv
      end
"#,
            reply.len(),
            set.len()
        ),
    );
    let mut files = common::files(&manifest);
    files.insert("code/module.wasm".into(), wat::parse_str(source).unwrap());
    files.insert(
        "ui/index.html".into(),
        b"<!doctype html><title>Counter</title>".to_vec(),
    );
    let bytes = moss_module_host::archive::pack(&files).unwrap();
    artifact.digest = moss_module_host::trust::digest(&bytes);
    artifact.size = bytes.len() as u64;
    artifact.capabilities = manifest.capabilities.clone();
    artifact.signature = common::Keys::sign(&keys.publisher, artifact.digest.as_bytes());
    fs::write(
        folder.join(format!("packages/{}.mosspkg", artifact.digest)),
        bytes,
    )
    .unwrap();
    index(keys, folder, &artifact, 1, vec![]);
    (artifact, manifest)
}
fn index(
    keys: &common::Keys,
    folder: &Path,
    artifact: &Artifact,
    serial: u64,
    revoked: Vec<Revocation>,
) {
    let index = Index {
        serial,
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: vec![artifact.clone()],
        revoked,
    };
    let bytes = serde_json::to_vec(&index).unwrap();
    fs::write(folder.join("index.json"), &bytes).unwrap();
    fs::write(
        folder.join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
}
fn lift(keys: &common::Keys, folder: &Path, targets: &[&str]) {
    let path = folder.join("registry.json");
    let mut identity: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    identity["liftedRevocations"] = json!(targets);
    let bytes = serde_json::to_vec(&identity).unwrap();
    fs::write(path, &bytes).unwrap();
    fs::write(
        folder.join("registry.json.sig"),
        common::Keys::sign(&keys.root, &bytes),
    )
    .unwrap();
}
fn entries(app: &Application, accounts: &[AccessContext], digest: &str, blocked: bool) {
    for account in accounts {
        let route = app.dispatch(account.clone(), "GET", "/api/m/sample.counter/health", "{}");
        assert_eq!(
            route.is_err(),
            blocked,
            "real route must follow revocation: {route:?}"
        );
        let tool = app
            .installer
            .run_chat_tool(account, "sample.counter", "sample.read", json!({}));
        assert_eq!(
            tool.is_err(),
            blocked,
            "real chat tool must follow revocation: {tool:?}"
        );
        let frame = app.installer.screen(account, "sample.counter", "/counter");
        assert_eq!(frame.is_err(), blocked, "frame must follow revocation");
        assert_eq!(
            app.installer.navigation(account).unwrap().is_empty(),
            blocked
        );
        assert_eq!(
            app.installer.chat_tools(account).unwrap().is_empty(),
            blocked
        );
    }
    let policy = moss_module_host::frame::AssetPolicy::new("https://moss.example.test").unwrap();
    assert_eq!(
        app.installer
            .ui_asset("sample.counter", digest, "ui/index.html", &policy)
            .is_err(),
        blocked
    );
}

#[test]
#[ignore = "Only through verify-gate and test:rust-phase6-revocation-runtime"]
fn phase6_revocation_runtime() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let accounts = [
        AccessContext::new(uuid::Uuid::new_v4(), "revocation-owner"),
        AccessContext::new(uuid::Uuid::new_v4(), "revocation-member"),
    ];
    let (db, database) = rt.block_on(async {
        let (db, connection) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { connection.await.unwrap(); });
        for sql in [moss_module_host::postgres::MIGRATION, moss_module_host::migrations::MIGRATION, moss_platform_jobs::MIGRATION, moss_module_host::jobs::MIGRATION] { db.batch_execute(sql).await.unwrap(); }
        db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,'revoke-owner@example.test','Owner',true),($2,'revoke-member@example.test','Member',false)", &[&accounts[0].actor_user_id(), &accounts[1].actor_user_id()]).await.unwrap();
        let database = Database::connect(&std::env::var("JS43_APP_URL").unwrap(), 4, RuntimeRole::App).await.unwrap();
        (db, database)
    });
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let (artifact, manifest) = publish(&keys, registry.path());
    let mut app = open(data.path(), database.clone(), &accounts[0]);
    let refresh = |app: &Application| {
        app.installer
            .refresh(
                &accounts[0],
                Source::Folder(registry.path().into()),
                &common::Keys::public(&keys.root),
                &common::Keys::public(&keys.root),
                "sample-registry",
            )
            .unwrap()
    };
    let catalog = refresh(&app);
    app.installer
        .install(&accounts[0], &catalog, &artifact, true)
        .unwrap();
    entries(&app, &accounts, &artifact.digest, false);
    let queue = rt
        .block_on(Queue::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            Role::Producer,
            specs(&manifest),
        ))
        .unwrap();
    let enqueue = |account: &AccessContext| {
        rt.block_on(queue.enqueue(
        Actor::from_authenticated_session(account.actor_user_id(), uuid::Uuid::new_v4()), &specs(&manifest)[0].name,
        json!({"actorUserId":account.actor_user_id(),"moduleId":module_key(&manifest.id),"manifestHash":manifest_hash(&manifest),"jobKind":specs(&manifest)[0].name,"params":{}}),
        uuid::Uuid::new_v4(), chrono::Utc::now())).unwrap().unwrap()
    };
    let worker = Secret::new(std::env::var("JS43_WORKER_URL").unwrap());
    enqueue(&accounts[0]);
    assert!(
        app.installer.run_job(&worker).unwrap(),
        "positive worker control"
    );
    let rev = |level| Revocation {
        target: artifact.digest.clone(),
        reason: "Unsafe package".into(),
        level,
    };
    index(
        &keys,
        registry.path(),
        &artifact,
        2,
        vec![rev(RevocationLevel::Warn)],
    );
    refresh(&app);
    entries(&app, &accounts, &artifact.digest, false);
    let pending = [enqueue(&accounts[0]), enqueue(&accounts[1])];
    index(
        &keys,
        registry.path(),
        &artifact,
        3,
        vec![rev(RevocationLevel::Block)],
    );
    refresh(&app);
    entries(&app, &accounts, &artifact.digest, true);
    // Exercise the worker declaration gate independently of a stale/missing queue pause.
    rt.block_on(db.execute("DELETE FROM moss_modules.paused_modules", &[]))
        .unwrap();
    assert!(
        !app.installer.run_job(&worker).unwrap(),
        "revoked queued work must not be claimed"
    );
    for id in pending {
        assert_eq!(
            rt.block_on(db.query_one("SELECT state FROM moss_queue.jobs WHERE id=$1", &[&id]))
                .unwrap()
                .get::<_, String>(0),
            "pending"
        );
    }
    index(&keys, registry.path(), &artifact, 4, vec![]);
    refresh(&app);
    entries(&app, &accounts, &artifact.digest, true);
    index(
        &keys,
        registry.path(),
        &artifact,
        5,
        vec![rev(RevocationLevel::Warn)],
    );
    refresh(&app);
    entries(&app, &accounts, &artifact.digest, true);
    drop(app);
    fs::rename(registry.path(), registry.path().with_extension("offline")).unwrap();
    app = open(data.path(), database.clone(), &accounts[0]);
    entries(&app, &accounts, &artifact.digest, true);
    assert!(!app.installer.run_job(&worker).unwrap());
    fs::rename(registry.path().with_extension("offline"), registry.path()).unwrap();
    lift(&keys, registry.path(), &[&artifact.digest]);
    refresh(&app);
    entries(&app, &accounts, &artifact.digest, false);
    assert!(app.installer.run_job(&worker).unwrap());
    assert!(app.installer.run_job(&worker).unwrap());
    index(
        &keys,
        registry.path(),
        &artifact,
        6,
        vec![Revocation {
            target: "sample".into(),
            reason: "Compromised publisher".into(),
            level: RevocationLevel::Block,
        }],
    );
    refresh(&app);
    entries(&app, &accounts, &artifact.digest, true);
    let saved = PostgresCatalog::new(database.clone(), accounts[0].clone()).unwrap();
    let mut state = saved.load().unwrap();
    let revision = state.revision;
    state.installed.get_mut("sample.counter").unwrap().disabled =
        Some("Switched off by an administrator".into());
    state.revision += 1;
    saved.commit(revision, &state).unwrap();
    lift(&keys, registry.path(), &[&artifact.digest, "sample"]);
    refresh(&app);
    entries(&app, &accounts, &artifact.digest, true);
    assert!(saved.load().unwrap().installed["sample.counter"]
        .revocations
        .is_empty());
    assert!(!app.installer.run_job(&worker).unwrap());
    assert!(app.installer.activity(&accounts[1]).is_err());
    assert!(!app.installer.activity(&accounts[0]).unwrap().is_empty());
    println!("PASS phase6_revocation_runtime: two accounts, real route/tool/job/frame, digest/publisher blocks, warning, omission/downgrade, offline restart, root lift preserves manual off and held work");
    println!("NOT PROVEN: management UI (later slice), remote HTTPS registry, OS process kill during refresh, three-OS behavior");
}
