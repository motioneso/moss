use super::{fixture::*, params};
use access_context::AccessContext;
use moss_module_host::{
    local::LocalPorts,
    manifest::{Attachment, Credential, CredentialScope},
};
use safety_core::secret::{Secret, SecretFields};
use serde_json::{json, Value};
use std::sync::Arc;

fn redacted_outputs() -> Vec<Value> {
    use base64::Engine;
    const ACCOUNT: &str = "planted-chat-account-value-361";
    const INSTANCE: &str = "planted-chat-instance-value-361";
    let encoded = base64::engine::general_purpose::STANDARD.encode(ACCOUNT);
    let mut m = manifest();
    for (name, scope) in [
        ("remote", CredentialScope::Account),
        ("shared", CredentialScope::Instance),
    ] {
        m.credentials.insert(
            name.into(),
            Credential {
                exchange: None,
                scope,
                hosts: ["example.test".into()].into(),
                attachment: Attachment::Header("authorization".into()),
                with: vec![],
                expose_fields: Default::default(),
            },
        );
    }
    m.tools.get_mut("sample.read").unwrap().description =
        format!("Read {ACCOUNT} {INSTANCE} {encoded}");
    m.tools
        .get_mut("sample.read")
        .unwrap()
        .input_schema
        .as_mut()
        .unwrap()["properties"]["text"]["description"] = json!(format!("Echo {ACCOUNT}"));
    m.tools
        .get_mut("sample.read")
        .unwrap()
        .input_schema
        .as_mut()
        .unwrap()["properties"]["text"]["maxLength"] = json!(1000);
    let raw = json!({"title":ACCOUNT,"target":format!("{ACCOUNT} {INSTANCE}"),"fields":[{"label":"Text","value":encoded}],"content":ACCOUNT,"version":"v1"});
    let f = Fixture::new(m, raw, None);
    for (access, name, secret) in [
        (&f.a, "remote", ACCOUNT),
        (
            &AccessContext::new(uuid::Uuid::nil(), "instance"),
            "shared",
            INSTANCE,
        ),
    ] {
        let fields = SecretFields::new().with("accessToken", Secret::new(secret));
        f.services
            .set_credential(access, MODULE, name, &fields)
            .unwrap();
    }
    let tool = f
        .host
        .run_chat_tool(
            &f.a,
            MODULE,
            "sample.read",
            json!({"text":format!("{ACCOUNT} {INSTANCE} {encoded}")}),
        )
        .unwrap();
    let approved = f
        .host
        .run_approved_chat_tool(&f.a, MODULE, "sample.erase", json!({"text":ACCOUNT}), None)
        .unwrap();
    let card = f
        .host
        .chat_tool_card(&f.a, MODULE, "sample.erase", &params())
        .unwrap()
        .unwrap();
    let list = f.host.chat_tools(&f.a).unwrap();
    vec![
        tool,
        approved,
        serde_json::to_value(card).unwrap(),
        serde_json::to_value(list).unwrap(),
    ]
}
fn assert_redacted(value: Value) {
    use base64::Engine;
    let text = value.to_string();
    for planted in [
        "planted-chat-account-value-361".to_owned(),
        "planted-chat-instance-value-361".to_owned(),
        base64::engine::general_purpose::STANDARD.encode("planted-chat-account-value-361"),
    ] {
        assert!(
            !text.contains(&planted),
            "Planted credential reached chat output"
        );
    }
    assert!(text.contains("[redacted]"));
}
#[test]
fn planted_credentials_tool_result() {
    assert_redacted(redacted_outputs().remove(0));
}
#[test]
fn planted_credentials_approved_result() {
    assert_redacted(redacted_outputs().remove(1));
}
#[test]
fn planted_credentials_card() {
    assert_redacted(redacted_outputs().remove(2));
}
#[test]
fn planted_credentials_tool_list() {
    assert_redacted(redacted_outputs().remove(3));
}

#[test]
fn calls_use_the_authenticated_account_for_real_host_storage() {
    let f = Fixture::new(
        manifest(),
        card(),
        Some(json!({"operation":"get","resource":"counter","parameters":{}})),
    );
    for (access, text) in [(&f.a, "A note"), (&f.b, "B note")] {
        f.host
            .call(
                MODULE,
                access.clone(),
                "route",
                &json!({"operation":"set","resource":"counter","parameters":{"note":text}})
                    .to_string(),
            )
            .unwrap();
    }
    assert_eq!(
        f.host
            .run_chat_tool(&f.a, MODULE, "sample.read", params())
            .unwrap(),
        json!({"note":"A note"})
    );
    assert_eq!(
        f.host
            .run_chat_tool(&f.b, MODULE, "sample.read", params())
            .unwrap(),
        json!({"note":"B note"})
    );
    assert_eq!(
        f.host
            .run_chat_tool(&f.admin, MODULE, "sample.read", params())
            .unwrap(),
        Value::Null
    );
}

#[test]
#[ignore = "Only through scripts/run-gate.sh test:rust-chat-host"]
fn chat_tool_reads_use_the_actor_under_real_rls_including_admin() {
    use moss_module_host::{
        database::DatabasePorts,
        manifest::{Capability, TableAccess},
        migrations::PostgresLifecycle,
    };
    use safety_core::db::{Database, RuntimeRole};
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let a = AccessContext::new(
        "00000000-0000-4000-8000-000000000361".parse().unwrap(),
        "chat-rls-a",
    );
    let b = AccessContext::new(
        "00000000-0000-4000-8000-000000000362".parse().unwrap(),
        "chat-rls-b",
    );
    let admin = AccessContext::new(uuid::Uuid::new_v4(), "chat-rls-admin");
    let db = rt.block_on(async {
        let (db,c) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = c.await; });
        // Removal controls repeat this test in the same disposable gate database.
        let initialized: bool = db.query_one("SELECT to_regnamespace('moss_modules') IS NOT NULL", &[]).await.unwrap().get(0);
        if !initialized {
            db.batch_execute(moss_module_host::postgres::MIGRATION).await.unwrap();
            db.batch_execute(moss_module_host::migrations::MIGRATION).await.unwrap();
            db.batch_execute(moss_module_host::jobs::QUEUE_MIGRATION).await.unwrap();
            db.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
        }
        let admin_email = format!("chat-{}@example.test", admin.actor_user_id());
        for (access,email,is_admin) in [(&a,"chat-a@example.test",true),(&b,"chat-b@example.test",false),(&admin,admin_email.as_str(),true)] {
            db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Chat fixture',$3) ON CONFLICT(id) DO NOTHING",&[&access.actor_user_id(),&email,&is_admin]).await.unwrap();
        }
        Database::connect(&std::env::var("JS43_APP_URL").unwrap(),4,RuntimeRole::App).await.unwrap()
    });
    // Exercise the real server assembly, including its outer transaction and adapter layers.
    let assembled_data = tempfile::tempdir().unwrap();
    let assembled = moss_module_host::application::Application::open_extended_with(
        assembled_data.path(),
        db.clone(),
        a.clone(),
        moss_module_host::application::Configuration {
            migrations: Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS43_APP_URL").unwrap()),
            cipher: Arc::new(
                safety_core::secret::SecretCipher::connectors(&Default::default()).unwrap(),
            ),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: None,
            browser_dir: None,
        },
        |services| {
            Ok(Arc::new(moss_module_host::context::ContextPorts::new(
                services,
            )))
        },
    )
    .unwrap();
    assert!(assembled.installer.chat_tools(&a).unwrap().is_empty());
    drop(assembled);
    let data = tempfile::tempdir().unwrap();
    let next = Arc::new(
        DatabasePorts::new(db.clone(), Arc::new(LocalPorts::new(data.path()).unwrap())).unwrap(),
    );
    let lifecycle = Arc::new(
        PostgresLifecycle::new(
            Secret::new(std::env::var("JS43_BOOTSTRAP_URL").unwrap()),
            db,
            data.path(),
        )
        .unwrap(),
    );
    let module = format!(
        "sample.chat{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let table = format!("app.{}_notes", module.replace('.', "_"));
    let mut m = manifest();
    m.id = module.clone();
    m.database.owned_tables = vec![table.clone()];
    m.database.migrations = vec!["sql/0001_chat_notes.sql".into()];
    m.database
        .access
        .insert(table.clone(), TableAccess::OwnerOnly);
    m.capabilities = vec![Capability {
        port: "db".into(),
        operations: ["select".into(), "insert".into()].into(),
        resources: [table.clone()].into(),
        allow_private: false,
    }];
    let f = Fixture::open(
        data,
        a,
        b,
        admin,
        m,
        card(),
        "db",
        Some(json!({"operation":"select","resource":table,"parameters":{}})),
        lifecycle,
        next,
    );
    for (access, note) in [(&f.a, "A private note"), (&f.b, "B private note")] {
        f.host.call(&module,access.clone(),"route",&json!({"operation":"insert","resource":table,"parameters":{"values":{"id":uuid::Uuid::new_v4(),"note":note}}}).to_string()).unwrap();
    }
    let read = |access| {
        f.host
            .run_chat_tool(access, &module, "sample.read", params())
            .unwrap()
    };
    assert_eq!(read(&f.a).as_array().unwrap().len(), 1);
    assert_eq!(read(&f.a)[0]["note"], "A private note");
    assert_eq!(read(&f.b)[0]["note"], "B private note");
    assert_eq!(read(&f.admin), json!([]));
    println!("PASS signed installed Wasm chat tool -> ServicePorts -> DatabasePorts -> actor DataContext -> owner-only PostgreSQL RLS; A/B/admin");
}
