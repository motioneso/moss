//! Installed Meals package served by the real HTTPS executable. Not a native UI proof.
mod common;
#[path = "people_routes/installed.rs"]
mod installed;
use access_context::AccessContext;
use common::Keys;
use moss_module_host::{
    archive::Package,
    registry::{Artifact, Channel, Index, Source},
    trust::{self, Publisher, RegistryIdentity},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
// The live fixture grants approval through the real trusted host API, never through HTTP
// parameters. It shares the server's private service store and disk locks.
struct NoModel;
impl moss_module_host::ai::Intelligence for NoModel {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("No model")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("No model")
    }
}
struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Port(String);
impl Drop for Port {
    fn drop(&mut self) {
        let _ = Command::new("devports").args(["release", &self.0]).output();
    }
}
fn private(path: &Path, value: &Value) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(value.to_string().as_bytes()).unwrap();
}

#[test]
#[ignore = "Only through verify-gate and the Meals live gate"]
fn installed_meals_package_serves_routes_from_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js304-meals-{}", std::process::id())])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .into(),
    );
    assert!(!port.0.is_empty());
    let origin = format!("https://localhost:{}", port.0);
    let address: std::net::IpAddr = std::env::var("JS290_PROOF_ADDRESS")
        .unwrap()
        .parse()
        .unwrap();
    assert!(!address.is_loopback() && address.is_ipv4());
    let remote_origin = format!("https://{address}:{}", port.0);
    let cert = root.join("tls/certificate.pem");
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .args(["local-certificate"])
        .arg(root.join("tls"))
        .arg(&origin)
        .arg(&remote_origin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    fs::create_dir(root.join("web")).unwrap();
    if let Ok(shared) = std::env::var("MOSS_MODULE_SHARED_DIR") {
        // Generated shared styles and fonts, which the sandboxed screens load.
        let status = Command::new("cp")
            .args(["-r", &shared])
            .arg(root.join("web/module-shared"))
            .status()
            .unwrap();
        assert!(status.success());
    }
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>Meals HTTP fixture</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    let worker_url = std::env::var("JS43_WORKER_URL").unwrap();
    let bootstrap_url = std::env::var("JS43_BOOTSTRAP_URL").unwrap();
    let auth_url = std::env::var("JS170_AUTH_URL").unwrap();
    let connector_key = "ab".repeat(32);
    let ai_key = "cd".repeat(32);
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":auth_url,"auth_secret":"temporary-disposable-news-signing-secret-276","connector_key":connector_key}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("0.0.0.0:{}",port.0),"sharing":true,"origins":[origin,remote_origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    let client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    let start = |modules: bool| {
        let mut command = Command::new(std::env::var("JS170_SERVER").unwrap());
        command
            .arg("--network")
            .arg(root.join("network.json"))
            .arg("--web")
            .arg(root.join("web"));
        if modules {
            command.arg("--modules").arg(root.join("modules.json"));
        }
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join("server.log"))
            .unwrap();
        let mut server = Server(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(
                server.0.try_wait().unwrap().is_none(),
                "server startup failed"
            );
            if client
                .get(format!("{origin}/api/hello"))
                .send()
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            assert!(Instant::now() < deadline, "server startup deadline");
            std::thread::sleep(Duration::from_millis(100));
        }
        server
    };
    let signup = |email: &str, name: &str| {
        let response = client.post(format!("{origin}/api/auth/sign-up/email")).header("origin", &origin).json(&json!({"name":name,"email":email,"password":"temporary-meals-password-287-not-a-real-secret"})).send().unwrap();
        let status = response.status();
        if status != 200 {
            panic!(
                "sign-up answered {status}: {}",
                response.text().unwrap_or_default()
            );
        }
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let server = start(false);
    let cookie = signup("meals-owner@example.test", "Meals owner");
    drop(server);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (owner, app) = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        for migration in [
            moss_module_host::postgres::MIGRATION,
            moss_module_host::migrations::MIGRATION,
            moss_platform_jobs::MIGRATION,
            moss_module_host::jobs::MIGRATION,
        ] {
            db.batch_execute(migration).await.unwrap();
        }
        let owner: uuid::Uuid = db
            .query_one(
                "SELECT id FROM app.users WHERE email='meals-owner@example.test'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        (
            owner,
            Database::connect(&app_url, 4, RuntimeRole::App)
                .await
                .unwrap(),
        )
    });
    let access = AccessContext::new(owner, "meals-install");
    // Publish the Meals package through a signed folder registry and install it with the
    // canonical installer, as the server would find it.
    let keys = Keys::new();
    fs::create_dir_all(root.join("registry/packages")).unwrap();
    let artifacts: Vec<Artifact> = [("JS304_MEALS_PACKAGE", "meals")]
        .iter()
        .map(|(variable, id)| {
            let bytes = fs::read(std::env::var(variable).unwrap()).unwrap();
            let digest = trust::digest(&bytes);
            let package = Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).unwrap();
            let manifest = &package.manifest;
            assert_eq!(manifest.id, *id);
            fs::write(
                root.join(format!("registry/packages/{digest}.mosspkg")),
                &bytes,
            )
            .unwrap();
            Artifact {
                id: manifest.id.clone(),
                version: manifest.version.clone(),
                digest: digest.clone(),
                size: bytes.len() as u64,
                publisher_key: "meals-test".into(),
                signature: Keys::sign(&keys.publisher, digest.as_bytes()),
                requires_moss: manifest.requires_moss.clone(),
                abi: manifest.abi.clone(),
                capabilities: manifest.capabilities.clone(),
                migrations: manifest.database.migrations.clone(),
                requires: manifest.requires.clone(),
                changelog: "Meals live gate".into(),
                channel: Channel::Stable,
                urgent: false,
            }
        })
        .collect();
    let identity = RegistryIdentity {
        id: "meals-test-registry".into(),
        name: "Meals test registry".into(),
        root_fingerprint: trust::digest(ring::signature::KeyPair::public_key(&keys.root).as_ref()),
        index_keys: BTreeMap::from([("online".into(), Keys::public(&keys.index))]),
        publishers: BTreeMap::from([(
            "meals-test".into(),
            Publisher {
                key: Keys::public(&keys.publisher),
                prefix: String::new(),
                replaces: BTreeSet::new(),
            },
        )]),
        lifted_revocations: BTreeSet::new(),
    };
    let index = Index {
        serial: 1,
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: artifacts.clone(),
        revoked: vec![],
    };
    for (name, data, key) in [
        (
            "registry.json",
            serde_json::to_vec(&identity).unwrap(),
            &keys.root,
        ),
        (
            "index.json",
            serde_json::to_vec(&index).unwrap(),
            &keys.index,
        ),
    ] {
        fs::write(root.join("registry").join(name), &data).unwrap();
        fs::write(
            root.join("registry").join(format!("{name}.sig")),
            Keys::sign(key, &data),
        )
        .unwrap();
    }
    let installer = installed::reopen(
        &root.join("data"),
        app,
        &access,
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    );
    let source = installer
        .refresh(
            &access,
            Source::Folder(root.join("registry")),
            &Keys::public(&keys.root),
            &Keys::public(&keys.publisher),
            "meals-test-registry",
        )
        .unwrap();
    for artifact in &artifacts {
        installer.install(&access, &source, artifact, true).unwrap();
    }
    drop(installer);

    private(
        &root.join("modules.json"),
        &json!({"data":root.join("data"),"admin_user_id":owner,"migrations_url":bootstrap_url,"producer_url":app_url,"worker_url":worker_url,"connector_key":connector_key,"ai_key":ai_key}),
    );
    let _server = start(true);
    // Setup allows one owner over HTTP, so the second person is made in the database with the
    // owner's password hash and then signs in through the real route.
    let other = {
        runtime.block_on(async {
            let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = connection.await;
            });
            let id = uuid::Uuid::new_v4();
            db.execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Meals other', 'meals-other@example.test', false, now(), now(), false, 'active')", &[&id]).await.unwrap();
            db.execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&id, &owner]).await.unwrap();
        });
        let signed = client.post(format!("{remote_origin}/api/auth/sign-in/email")).header("origin", &remote_origin)
            .json(&json!({"email":"meals-other@example.test","password":"temporary-meals-password-287-not-a-real-secret"})).send().unwrap();
        assert_eq!(signed.status(), 200, "second person sign-in");
        signed.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();
    let call = |method: reqwest::Method, path: &str, cookie: Option<&str>, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{remote_origin}/api/m/meals{path}"))
            .header("origin", &remote_origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        println!("{method_path} -> {status}", method_path = path);
        (status, text)
    };
    let json_of = |text: &str| serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    use reqwest::Method;
    const MARK: &str = "PLANTED-LIVE-MARKER-7d2e";
    assert_eq!(
        client
            .post(format!("{remote_origin}/api/m/meals/meals/tools/run"))
            .header("origin", "https://untrusted.example")
            .header("cookie", &cookie)
            .json(&json!({"tool":"meals.list","parameters":{}}))
            .send()
            .unwrap()
            .status()
            .as_u16(),
        403
    );
    println!("PASS live network: real non-loopback HTTPS with certificate verification; untrusted origin refused");
    assert_eq!(call(Method::GET, "/meals", None, None).0, 401);
    // The server answers 503, or holds the request, until its module host has finished starting.
    let started = std::time::Instant::now();
    loop {
        let ready = client
            .get(format!("{origin}/api/m/meals/meals"))
            .header("origin", &origin)
            .header("cookie", &cookie)
            .send()
            .is_ok_and(|r| r.status().as_u16() != 503);
        if ready {
            break;
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(240),
            "module host start deadline\n{}",
            log()
        );
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    let services = moss_module_host::services::ServicePorts::new(
        &root.join("data"),
        std::sync::Arc::new(
            safety_core::secret::SecretCipher::connectors(&Default::default()).unwrap(),
        ),
        std::sync::Arc::new(NoModel),
        std::sync::Arc::new(moss_module_host::runtime::DenyPorts),
    )
    .unwrap();
    let tool = |name: &str, parameters: Value, approve: bool| {
        if approve {
            services
                .approve_tool(&access, "meals", name, &parameters)
                .unwrap();
        }
        call(
            Method::POST,
            "/meals/tools/run",
            Some(&cookie),
            Some(json!({"tool":name,"parameters":parameters})),
        )
    };
    for who in [&cookie, &other] {
        let (status, text) = call(Method::POST, "/meals/tools/run", Some(who), Some(json!({"tool":"meals.kitchen.get","parameters":{}})));
        assert_eq!(status, 403, "a tool without approval is refused: {text}");
    }
    let policies = BTreeMap::from([
        ("meals.kitchen.get".into(), false),
        ("meals.list.get".into(), false),
        ("meals.pantry.get".into(), false),
    ]);
    services.set_action_policy(&access, "meals", &policies).unwrap();
    let (status, text) = tool("meals.kitchen.get", json!({}), false);
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(json_of(&text)["data"]["members"].as_array().unwrap().len(), 1);
    let save = json!({"unitsSystem":"metric","slotRules":[{"slotName":"lunch","usualTime":"12:30"}]});
    assert_eq!(tool("meals.kitchen.save", save.clone(), false).0, 403);
    let (status, text) = tool("meals.kitchen.save", save.clone(), true);
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(tool("meals.kitchen.save", save, false).0, 403, "an approval is used once");
    let member = json!({"name":MARK,"preferences":[MARK]});
    let (status, text) = tool("meals.household.save", member, true);
    assert_eq!(status, 200, "{text}");
    let member_id = json_of(&text)["data"]["memberId"].as_str().unwrap().to_owned();
    // The second person sees none of it and cannot change or remove it.
    let (_, mine) = tool("meals.kitchen.get", json!({}), true);
    assert!(mine.contains(MARK));
    let (status, text) = call(Method::POST, "/meals/tools/run", Some(&other), Some(json!({"tool":"meals.household.remove","parameters":{"memberId":member_id}})));
    assert!(status == 403 && !text.contains(MARK), "{text}");
    let (_, again) = tool("meals.kitchen.get", json!({}), true);
    assert!(again.contains(MARK), "the other person removed nothing");
    let (_, removed) = tool("meals.household.remove", json!({"memberId":member_id}), true);
    assert_eq!(json_of(&removed)["data"], json!({"removed":true}));
    // Lists and pantry through the same route. The second person sees and changes none of it.
    let (status, text) = tool("meals.list.edit", json!({"action":"add","name":MARK,"quantity":2,"unit":"kg"}), true);
    assert_eq!(status, 200, "{text}\n{}", log());
    let line_id = json_of(&text)["data"]["list"]["lines"][0]["lineId"].as_str().unwrap().to_owned();
    let (status, text) = tool("meals.pantry.edit", json!({"action":"add","name":MARK}), true);
    assert_eq!(status, 200, "{text}");
    let (_, listed) = tool("meals.list.get", json!({}), false);
    assert!(listed.contains(MARK) && listed.contains(&line_id), "{listed}");
    let (_, stocked) = tool("meals.pantry.get", json!({}), false);
    assert!(stocked.contains(MARK), "{stocked}");
    let (status, text) = call(Method::POST, "/meals/tools/run", Some(&other), Some(json!({"tool":"meals.list.clear","parameters":{}})));
    assert!(status == 403 && !text.contains(MARK), "{text}");
    let (_, still) = tool("meals.list.get", json!({}), false);
    assert!(still.contains(&line_id), "the other person cleared nothing");
    let (status, text) = tool("meals.list.bought", json!({"lines":[{"lineId":line_id}]}), true);
    assert_eq!(status, 200, "{text}");
    let (status, text) = tool("meals.list.clear", json!({}), true);
    assert_eq!(status, 200, "{text}");
    let (_, after) = tool("meals.pantry.get", json!({}), false);
    assert!(after.contains(MARK), "clearing the list left the pantry alone");
    // Cooking, ratings and undo through the same route. The plan and meal rows are set up in the
    // database because writing a plan needs a model; every call after that goes through the server.
    let milk = tool("meals.pantry.edit", json!({"action":"add","name":"Milk","quantity":5,"unit":"cup"}), true);
    assert_eq!(milk.0, 200, "{}", milk.1);
    let meal_id = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        db.batch_execute(&format!(
            "INSERT INTO app.meals_plans(owner_user_id,kitchen_id,plan_id,start_date,day_count,pantry_mode,idempotency_key)
               SELECT '{owner}',kitchen_id,md5('live-plan')::uuid,DATE '2026-11-09',1,'prefer','live' FROM app.meals_kitchens WHERE owner_user_id='{owner}';
             INSERT INTO app.meals_plan_days(owner_user_id,kitchen_id,plan_id,day_id,day_date,status)
               SELECT '{owner}',kitchen_id,md5('live-plan')::uuid,md5('live-day')::uuid,DATE '2026-11-09','ready' FROM app.meals_kitchens WHERE owner_user_id='{owner}';
             INSERT INTO app.meals_recipes(owner_user_id,kitchen_id,recipe_id,title,title_key,steps,cook_minutes,base_servings,source)
               SELECT '{owner}',kitchen_id,md5('live-recipe')::uuid,'Live','live','[\"stir\"]'::jsonb,10,2,'generated' FROM app.meals_kitchens WHERE owner_user_id='{owner}';
             INSERT INTO app.meals_recipe_ingredients(owner_user_id,kitchen_id,recipe_id,position,original_text,name,name_key,quantity,unit,store_section)
               SELECT '{owner}',kitchen_id,md5('live-recipe')::uuid,0,'2 cups milk','milk','milk',2,'cup','dairy_eggs' FROM app.meals_kitchens WHERE owner_user_id='{owner}';
             INSERT INTO app.meals_planned_meals(owner_user_id,kitchen_id,day_id,meal_id,slot_name,slot_position,kind,sharing,status,recipe_id)
               SELECT '{owner}',kitchen_id,md5('live-day')::uuid,md5('live-meal')::uuid,'dinner',0,'recipe','shared','ready',md5('live-recipe')::uuid FROM app.meals_kitchens WHERE owner_user_id='{owner}';
             INSERT INTO app.meals_planned_meal_eaters(owner_user_id,kitchen_id,meal_id,member_id,portion)
               SELECT '{owner}',kitchen_id,md5('live-meal')::uuid,member_id,1 FROM app.meals_household_members WHERE owner_user_id='{owner}' AND is_self;"
        ))
        .await
        .unwrap();
        db.query_one("SELECT md5('live-meal')::uuid::text", &[]).await.unwrap().get::<_, String>(0)
    });
    let (_, kitchen) = tool("meals.kitchen.get", json!({}), true);
    let me = json_of(&kitchen)["data"]["members"][0]["memberId"].as_str().unwrap().to_owned();
    let (status, text) = tool("meals.meal.rate", json!({"mealId":meal_id,"ratings":[{"memberId":me,"stars":4}]}), true);
    assert_eq!(status, 200, "{text}\n{}", log());
    let (status, text) = tool("meals.meal.cooked", json!({"mealId":meal_id}), true);
    assert_eq!(status, 200, "{text}\n{}", log());
    let cooked = json_of(&text);
    assert_eq!(cooked["data"]["pantryChanges"][0]["after"], 4.0, "{text}");
    let action = cooked["data"]["undo"]["actionId"].as_str().unwrap().to_owned();
    let (status, text) = call(Method::POST, "/meals/tools/run", Some(&other), Some(json!({"tool":"meals.undo","parameters":{"actionId":action}})));
    assert_eq!(status, 403, "the second person is refused before anything runs: {text}");
    let (status, text) = tool("meals.undo", json!({"actionId":action}), true);
    assert_eq!(status, 200, "{text}\n{}", log());
    assert_eq!(json_of(&text)["data"], json!({"restored":1,"skipped":0}), "{text}");
    let (_, back) = tool("meals.pantry.get", json!({}), false);
    assert!(back.contains("\"quantity\":5"), "undo put the milk back: {back}");
    let (status, text) = tool("meals.undo", json!({"actionId":action}), true);
    assert_eq!(json_of(&text)["data"]["code"], "invalid_input", "a second undo is refused: {text} {status}");
    println!("PASS live cooking: rate, cook, undo and a refused second undo through the real server; second person refused");
    let activity = serde_json::to_string(&services.activity("meals", &access).unwrap()).unwrap();
    assert!(!activity.contains(MARK));
    // Nothing the test sent reached the server log.
    assert!(!log().to_lowercase().contains(&MARK.to_lowercase()));
    // The food log with a real model. The key comes from the box's own proxy file and is never
    // printed. Without that file the proof is reported as not run, never as passed.
    let key_file = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/cliproxyapi/client-key");
    let proxy_port = fs::read_to_string(key_file.with_file_name("port")).unwrap_or_default();
    let model_key = fs::read_to_string(&key_file).map(|k| k.trim().to_owned()).ok().filter(|k| !k.is_empty());
    let (Some(model_key), false) = (model_key, proxy_port.trim().is_empty()) else {
        println!("NOT RUN live model: no local model proxy key on this box");
        return;
    };
    let sealed = safety_core::secret::SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), ai_key.clone())].into())
        .unwrap()
        .seal(&safety_core::secret::SecretFields::new().with("apiKey", safety_core::secret::Secret::new(&model_key)));
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        let (provider, model) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        db.execute(
            "INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,base_url,encrypted_credential,is_instance_default) VALUES($1,$2,'openai-compatible','Local proxy',$3,$4,true)",
            &[&provider, &owner, &format!("http://127.0.0.1:{}", proxy_port.trim()), &sealed],
        ).await.unwrap();
        db.execute(
            "INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities) VALUES($1,$2,$3,'gpt-5.6-luna','Small model',ARRAY['chat','json'])",
            &[&model, &provider, &owner],
        ).await.unwrap();
    });
    let manifest: Value = serde_json::from_str(&fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules/meals/moss.module.json")).unwrap()).unwrap();
    assert_eq!(manifest["callLimitMs"], 30000, "the module asks for the longer model call limit");
    let mut policies = policies.clone();
    policies.insert("meals.log.list".into(), false);
    services.set_action_policy(&access, "meals", &policies).unwrap();
    let (status, text) = tool("meals.log.add", json!({"description":"two scrambled eggs and a slice of buttered toast","idempotencyKey":"live-1","consumedAt":"2026-11-10T08:00:00-08:00"}), true);
    assert_eq!(status, 200, "{text}\n{}", log());
    let added = json_of(&text)["data"]["entry"].clone();
    assert_eq!(added["estimateState"], "pending", "a new entry shows as waiting for an estimate");
    assert!(added["nutrients"].is_null(), "no figures before the model answers");
    let waited = Instant::now();
    let entry = loop {
        let (_, text) = tool("meals.log.list", json!({"localDate":"2026-11-10"}), false);
        let found = json_of(&text)["data"]["entries"][0].clone();
        if found["estimateState"] != "pending" {
            break found;
        }
        assert!(waited.elapsed() < Duration::from_secs(120), "estimate did not finish: {found}\n{}", log());
        std::thread::sleep(Duration::from_secs(2));
    };
    assert_eq!(entry["estimateState"], "estimated", "real model estimate: {entry}\n{}", log());
    let kcal = entry["nutrients"]["caloriesKcal"].as_f64().expect("calories known");
    assert!((100.0..=1500.0).contains(&kcal), "a plausible breakfast, got {kcal}");
    assert!(entry["items"].as_array().is_some_and(|i| !i.is_empty()), "foods listed: {entry}");
    let (_, theirs) = call(Method::POST, "/meals/tools/run", Some(&other), Some(json!({"tool":"meals.log.list","parameters":{}})));
    assert!(!theirs.contains("scrambled"), "the second person sees no entries");
    assert!(!log().contains(&model_key), "the model key never reaches the server log");
    println!("PASS live model: gpt-5.6-luna estimated a real entry in {:?}: {kcal} kcal, shown as an estimate; key absent from the log", waited.elapsed());
    println!("PASS live HTTPS: kitchen, household, list and pantry tools, one-use approval, second person refused, private text absent from activity and the server log");
}
