//! Real email cache API -> Commitments judgement job -> saved suggestions -> Today.
//! The browser hold never inserts commitment candidates or replaces HTTP responses.
use super::*;
use moss_module_host::application::{Application, Configuration};
use safety_core::secret::{Secret, SecretCipher, SecretFields};
use std::sync::Arc;
struct NoModel;
impl moss_module_host::ai::Intelligence for NoModel {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("The running server owns model calls")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("No embeddings")
    }
}
#[allow(clippy::too_many_arguments)]
pub fn run(
    root: &Path,
    rt: &tokio::runtime::Runtime,
    bootstrap: &str,
    app_url: &str,
    owner: &uuid::Uuid,
    ai_key: &str,
    client: &reqwest::blocking::Client,
    origin: &str,
    cookie: &str,
) {
    // Runtime credentials are read only by this process, encrypted immediately, and never printed.
    let proxy = Path::new(&std::env::var("HOME").unwrap()).join(".config/cliproxyapi");
    let key =
        fs::read_to_string(proxy.join("client-key")).expect("Local Codex model proxy required");
    let port = fs::read_to_string(proxy.join("port")).unwrap();
    let sealed = SecretCipher::ai(&[("JARVIS_AI_SECRET_KEY".into(), ai_key.to_owned())].into())
        .unwrap()
        .seal(&SecretFields::new().with("apiKey", Secret::new(key.trim())));
    let account = uuid::Uuid::new_v4();
    let database = rt.block_on(async {
        let (db, conn) = tokio_postgres::connect(bootstrap, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = conn.await; });
        let (provider, model) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        db.execute("INSERT INTO app.ai_provider_configs(id,owner_user_id,provider_kind,display_name,base_url,encrypted_credential,is_instance_default) VALUES($1,$2,'openai-compatible','Local Codex proxy',$3,$4,true)", &[&provider, owner, &format!("http://127.0.0.1:{}",port.trim()), &sealed]).await.unwrap();
        db.execute("INSERT INTO app.ai_configured_models(id,provider_config_id,owner_user_id,provider_model_id,display_name,capabilities) VALUES($1,$2,$3,'gpt-6.1-sol','Small Codex model',ARRAY['chat','json'])", &[&model,&provider,owner]).await.unwrap();
        db.execute("INSERT INTO app.connector_accounts(id,provider_id,owner_user_id,scopes,status,encrypted_secret) VALUES($1,'google',$2,ARRAY['https://www.googleapis.com/auth/gmail.modify'],'active','{}')", &[&account,owner]).await.unwrap();
        Database::connect(app_url, 4, RuntimeRole::App).await.unwrap()
    });
    let access = AccessContext::new(*owner, "commitments-screen-demo");
    let db_for_email = database.clone();
    let app = Application::open_extended_with(
        &root.join("data"),
        database,
        access.clone(),
        Configuration {
            migrations: Secret::new(bootstrap),
            producer: Secret::new(app_url),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence: Arc::new(NoModel),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: Some(250_000_000),
            browser_dir: None,
        },
        |next| {
            Ok(Arc::new(moss_email_host::EmailPorts::new(
                db_for_email,
                next,
            )?))
        },
    )
    .unwrap();
    // Each short thread contains an owner promise followed by the other person's reminder.
    // These are input documents, not precomputed model answers or inserted suggestions.
    for (index, (name, promise)) in [
        (
            "Priya",
            "I will send Priya the budget draft by November 25, 2026.",
        ),
        (
            "Dana",
            "I will book the room for Dana's leaving drinks by November 26, 2026.",
        ),
        (
            "Alex",
            "I will return the ladder to Alex by November 27, 2026.",
        ),
        (
            "Kim",
            "I will send Kim the garden plan by November 28, 2026.",
        ),
    ]
    .iter()
    .enumerate()
    {
        let mut message_id = Value::Null;
        for step in 0..2 {
            let input = json!({"connectorAccountId":account,"externalId":format!("demo-{index}-{step}"),
                "sender":if step == 0 { "commitments-owner@example.test".to_string() } else { format!("{name} <{name}@example.test>") },
                "recipients":["commitments-owner@example.test"],"subject":format!("Following up: {name}"),
                "bodyExcerpt":if step == 0 { promise.to_string() } else { format!("Thank you. I am waiting for this: {promise} Please remember our agreement.") },
                "receivedAt":if step == 0 { "2026-11-18T09:00:00Z" } else { "2026-11-18T10:00:00Z" },
                "externalMetadata":{"threadId":format!("demo-thread-{index}")}});
            let out = app
                .installer
                .call(
                    "email",
                    access.clone(),
                    "api",
                    &json!({"name":"insertCachedMessage","parameters":input}).to_string(),
                )
                .unwrap();
            message_id = serde_json::from_str::<Value>(&out).unwrap()["message"]["id"].clone();
            assert!(message_id.is_string());
        }
        let queued = app.installer.call("commitments", access.clone(), "api", &json!({"name":"requestThreadJudgement","parameters":{"cacheMessageId":message_id}}).to_string()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&queued).unwrap()["queued"],
            true
        );
    }
    drop(app);
    // The production debounce and worker run unchanged, including the real capability router.
    let deadline = Instant::now() + Duration::from_secs(420);
    loop {
        let reply: Value = client
            .get(format!(
                "{origin}/api/m/commitments/candidates?status=pending_review"
            ))
            .header("cookie", cookie)
            .send()
            .unwrap()
            .json()
            .unwrap();
        if reply.as_array().is_some_and(|r| r.len() >= 4) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "real email judgement did not produce four review suggestions; inspect the job state"
        );
        std::thread::sleep(Duration::from_secs(3));
    }
    println!("PASS live demo: four email threads inserted through Email's API, judged by the real Codex proxy model and saved as pending review by the worker");
    {
        let Ok(hold) = std::env::var("COMMITMENTS_SCREEN_HOLD") else { return };
        fs::create_dir_all(&hold).unwrap();
        fs::write(Path::new(&hold).join("url.txt"), origin).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2400);
        while !Path::new(&hold).join("finished").exists() {
            assert!(Instant::now() < deadline, "browser proof deadline");
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}
