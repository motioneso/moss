mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    local::LocalPorts,
    manifest::{Capability, Manifest, Tool},
    runtime::{CallScope, Host, Limits, Ports, Request},
    services::ServicePorts,
};
use safety_core::secret::{Secret, SecretCipher, SecretFields};
use serde_json::{json, Value};
use std::sync::Arc;
struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured embeddings")
    }
}
fn call(
    host: &Host,
    ports: Arc<dyn Ports>,
    manifest: &Manifest,
    actor: uuid::Uuid,
    port: &str,
    request: Value,
) -> Result<Value> {
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat")
            .replace("moss:module/kv@", &format!("moss:module/{port}@")),
    )?;
    let out = host.call(
        &wasm,
        Arc::new(manifest.clone()),
        AccessContext::new(actor, "services"),
        ports,
        "route",
        &request.to_string(),
    )?;
    Ok(serde_json::from_str(&out)?)
}
#[test]
fn installed_signed_packages_read_only_attachments_handed_to_their_account_and_module() {
    use moss_module_host::{
        lifecycle::FileLifecycle, registry::Source, sql::LegacyInventory, store::Installer,
    };
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let a = uuid::Uuid::new_v4();
    let access = AccessContext::new(a, "attachment-install");
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let installer = Installer::new(
        data.path(),
        Arc::new(ServiceCatalog::default()),
        Arc::new(FileLifecycle::new(data.path(), [a].into()).unwrap()),
        Host::new(Limits::default()).unwrap(),
        services.clone(),
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let root = common::Keys::public(&keys.root);
    let catalog = installer
        .refresh(
            &access,
            Source::Folder(registry.path().into()),
            &root,
            &root,
            "sample-registry",
        )
        .unwrap();
    // Manifests are frozen, signed and installed before any upload UUID exists.
    for (id, handed) in [
        ("sample.counter", true),
        ("sample.other", true),
        ("sample.unapproved", false),
    ] {
        let mut manifest = common::manifest("1.0.0");
        manifest.id = id.into();
        manifest.capabilities.push(Capability {
            port: "attachments".into(),
            operations: ["read".into()].into(),
            resources: if handed {
                ["handed".into()].into()
            } else {
                Default::default()
            },
            allow_private: false,
        });
        let mut files = common::files(&manifest);
        files.insert(
            "code/module.wasm".into(),
            wat::parse_str(
                include_str!("../sample/module.wat")
                    .replace("moss:module/kv@", "moss:module/attachments@"),
            )
            .unwrap(),
        );
        let bytes = moss_module_host::archive::pack(&files).unwrap();
        let digest = moss_module_host::trust::digest(&bytes);
        installer
            .import_file(
                &access,
                &catalog,
                &bytes,
                &common::Keys::sign(&keys.publisher, digest.as_bytes()),
                "sample",
                true,
            )
            .unwrap();
    }
    let id = services
        .hand_attachment(
            &access,
            "sample.counter",
            b"actual upload bytes",
            "text/plain",
        )
        .unwrap();
    let request = |resource: &str| {
        json!({"operation":"read","resource":resource,"parameters":{}}).to_string()
    };
    let out = installer
        .call("sample.counter", access.clone(), "route", &request(&id))
        .unwrap();
    let out: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        out,
        json!({"mediaType":"text/plain","base64":"YWN0dWFsIHVwbG9hZCBieXRlcw=="})
    );
    assert!(installer
        .call(
            "sample.counter",
            AccessContext::new(uuid::Uuid::new_v4(), "other-account"),
            "route",
            &request(&id)
        )
        .is_err());
    assert!(installer
        .call("sample.other", access.clone(), "route", &request(&id))
        .is_err());
    let unapproved = services
        .hand_attachment(
            &access,
            "sample.unapproved",
            b"needs permission",
            "text/plain",
        )
        .unwrap();
    assert!(installer
        .call(
            "sample.unapproved",
            access.clone(),
            "route",
            &request(&unapproved)
        )
        .is_err());
    let other = services
        .hand_attachment(&access, "sample.other", b"another module", "text/plain")
        .unwrap();
    for resource in [
        other,
        uuid::Uuid::new_v4().to_string(),
        "handed".into(),
        "../host/credential-api".into(),
    ] {
        assert!(installer
            .call(
                "sample.counter",
                access.clone(),
                "route",
                &request(&resource)
            )
            .is_err());
    }
    println!("PASS signed packages installed before uploads: handed attachment read succeeds; other accounts, modules, unhanded IDs and paths are refused");
}
#[test]
fn install_wide_storage_is_explicit_and_tools_cannot_lower_declared_risk() {
    let data = tempfile::tempdir().unwrap();
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let host = Host::new(Limits::default()).unwrap();
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let mut m = common::manifest("1.0.0");
    call(
        &host,
        services.clone(),
        &m,
        a,
        "kv",
        json!({"operation":"set","resource":"counter","parameters":{"value":7}}),
    )
    .unwrap();
    assert_eq!(
        call(
            &host,
            services.clone(),
            &m,
            b,
            "kv",
            json!({"operation":"get","resource":"counter"})
        )
        .unwrap(),
        Value::Null
    );
    m.install_wide_kv.insert("counter".into());
    call(
        &host,
        services.clone(),
        &m,
        a,
        "kv",
        json!({"operation":"set","resource":"counter","parameters":{"shared":9}}),
    )
    .unwrap();
    assert_eq!(
        call(
            &host,
            services.clone(),
            &m,
            b,
            "kv",
            json!({"operation":"get","resource":"counter"})
        )
        .unwrap(),
        json!({"shared":9})
    );
    m.tools.insert(
        "erase".into(),
        Tool {
            approval_version: false,
            description: "Erase data".into(),
            risk: "destructive".into(),
        },
    );
    m.capabilities.push(Capability {
        port: "tools".into(),
        operations: ["offer".into(), "run".into()].into(),
        resources: ["erase".into()].into(),
        allow_private: false,
    });
    assert_eq!(
        call(
            &host,
            services.clone(),
            &m,
            a,
            "tools",
            json!({"operation":"offer","resource":"erase"})
        )
        .unwrap()["risk"],
        "destructive"
    );
    for parameters in [json!({"risk":"read"}), json!({})] {
        assert!(call(
            &host,
            services.clone(),
            &m,
            a,
            "tools",
            json!({"operation":"run","resource":"erase","parameters":parameters})
        )
        .is_err());
    }
}

struct EchoRemote(std::sync::atomic::AtomicUsize);
impl moss_module_host::network::Transport for EchoRemote {
    fn send(
        &self,
        r: moss_module_host::network::Outbound<'_>,
    ) -> Result<moss_module_host::network::Response> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(r.url.host_str(), Some("example.test"));
        let value = if r.url.path() == "/token" {
            assert_eq!(
                r.body.as_ref().unwrap()["client_secret"],
                "test-only-client-secret"
            );
            assert_eq!(
                r.headers[reqwest::header::CONTENT_TYPE],
                "application/x-www-form-urlencoded"
            );
            json!({"access_token":"test-only-access-token","refresh_token":"test-only-refresh-token","expires_in":3600})
        } else {
            let header = r.headers.get("authorization").unwrap().to_str().unwrap();
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(header);
            json!({"echo":header,"access_token":"should never return this field","nested":{"echo":header,encoded:"safe"}})
        };
        Ok(moss_module_host::network::Response {
            status: 200,
            body: serde_json::to_vec(&value)?,
        })
    }
}
#[test]
fn credential_exchange_and_echo_redaction_use_the_real_guest_and_encrypted_store() {
    use moss_module_host::manifest::{Attachment, Credential, CredentialScope, Exchange};
    let data = tempfile::tempdir().unwrap();
    let remote = Arc::new(EchoRemote(std::sync::atomic::AtomicUsize::new(0)));
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap()
        .with_network(remote.clone()),
    );
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let host = Host::new(Limits::default()).unwrap();
    let mut m = common::manifest("1.0.0");
    m.capabilities.push(Capability {
        port: "credentials".into(),
        operations: ["request".into(), "exchange".into()].into(),
        resources: ["example.test".into(), "other.test".into()].into(),
        allow_private: false,
    });
    m.credentials.insert(
        "api".into(),
        Credential {
            scope: CredentialScope::Account,
            hosts: ["example.test".into()].into(),
            attachment: Attachment::Header("authorization".into()),
            exchange: Some(Exchange {
                endpoint: "https://example.test/token".into(),
                grant_type: "client_credentials".into(),
            }),
        },
    );
    services
        .set_credential(
            &AccessContext::new(a, "configure"),
            &m.id,
            "api",
            &SecretFields::new()
                .with("clientId", Secret::new("test-client"))
                .with("clientSecret", Secret::new("test-only-client-secret")),
        )
        .unwrap();
    let exchange = json!({"operation":"exchange","resource":"example.test","parameters":{"url":"https://example.test/token","credential":"api"}});
    assert_eq!(
        call(&host, services.clone(), &m, a, "credentials", exchange).unwrap(),
        json!({"connected":true})
    );
    let r = json!({"operation":"request","resource":"example.test","parameters":{"url":"https://example.test/data","credential":"api"}});
    let out = call(&host, services.clone(), &m, a, "credentials", r.clone()).unwrap();
    assert_eq!(out["body"]["echo"], "[redacted]");
    assert!(out["body"].get("access_token").is_none());
    use base64::Engine;
    assert!(
        !out.to_string()
            .contains(&base64::engine::general_purpose::STANDARD.encode("test-only-access-token")),
        "A credential encoded in an object key must also be redacted"
    );
    assert!(call(&host, services.clone(), &m, b, "credentials", r.clone()).is_err());
    assert!(call(&host,services.clone(),&m,a,"credentials",json!({"operation":"request","resource":"other.test","parameters":{"url":"https://other.test/data","credential":"api"}})).is_err());
    assert_eq!(remote.0.load(std::sync::atomic::Ordering::SeqCst), 2);
    services
        .remove_credential(&AccessContext::new(a, "disconnect"), &m.id, "api")
        .unwrap();
    assert!(call(&host, services, &m, a, "credentials", r).is_err());
    println!("PASS credential broker with a stand-in upstream: real Wasm, encrypted store, form token exchange, redacted echoes, account and destination checks, disconnect");
}

#[derive(Default)]
struct ServiceCatalog(std::sync::Mutex<moss_module_host::store::State>);
impl moss_module_host::store::CatalogStore for ServiceCatalog {
    fn load(&self) -> Result<moss_module_host::store::State> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn commit(&self, revision: u64, next: &moss_module_host::store::State) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        anyhow::ensure!(state.revision == revision, "Stale catalog");
        *state = next.clone();
        Ok(())
    }
}
#[test]
fn installed_public_apis_events_tool_grants_and_account_routes_use_the_real_host() {
    use moss_module_host::{
        lifecycle::FileLifecycle, registry::Source, sql::LegacyInventory, store::Installer,
    };
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let access = AccessContext::new(a, "services-integration");
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let installer = Arc::new(
        Installer::new(
            data.path(),
            Arc::new(ServiceCatalog::default()),
            Arc::new(FileLifecycle::new(data.path(), [a].into()).unwrap()),
            Host::new(Limits::default()).unwrap(),
            services.clone(),
            "0.1.0".parse().unwrap(),
            LegacyInventory::default(),
        )
        .unwrap(),
    );
    services.bind(&installer);
    let catalog = installer
        .refresh(
            &access,
            Source::Folder(registry.path().into()),
            &common::Keys::public(&keys.root),
            &common::Keys::public(&keys.root),
            "sample-registry",
        )
        .unwrap();
    let mut provider = common::manifest("1.0.0");
    provider.id = "sample.provider".into();
    provider
        .provides
        .insert("changed".into(), "1.0.0".parse().unwrap());
    provider
        .provides
        .insert("read".into(), "1.0.0".parse().unwrap());
    provider.tools.insert(
        "erase".into(),
        Tool {
            approval_version: false,
            description: "Erase".into(),
            risk: "destructive".into(),
        },
    );
    for (port, operations, resources) in [
        ("events", vec!["publish"], vec!["changed"]),
        ("tools", vec!["run"], vec!["erase"]),
    ] {
        provider.capabilities.push(Capability {
            port: port.into(),
            operations: operations.into_iter().map(String::from).collect(),
            resources: resources.into_iter().map(String::from).collect(),
            allow_private: false,
        });
    }
    provider.routes =
        serde_json::from_value(json!([{"method":"POST","path":"/read","signIn":true}])).unwrap();
    let mut consumer = common::manifest("1.0.0");
    consumer.id = "sample.consumer".into();
    consumer
        .requires
        .insert(provider.id.clone(), "^1".parse().unwrap());
    consumer.capabilities.push(Capability {
        port: "events".into(),
        operations: ["subscribe".into(), "poll".into()].into(),
        resources: ["changed".into()].into(),
        allow_private: false,
    });
    consumer.capabilities.push(Capability {
        port: "api".into(),
        operations: ["call".into()].into(),
        resources: [provider.id.clone()].into(),
        allow_private: false,
    });
    for m in [&provider, &consumer] {
        let mut files = common::files(m);
        // A real component exporting a pure successful JSON handler for route/tool dispatch.
        files.insert(
            "code/module.wasm".into(),
            wat::parse_str(
                include_str!("../sample/module.wat")
                    .replace("i32.const 114 i32.eq", "i32.const 0 i32.eq")
                    .replace("\"healthy\"", "\"true   \""),
            )
            .unwrap(),
        );
        let bytes = moss_module_host::archive::pack(&files).unwrap();
        let digest = moss_module_host::trust::digest(&bytes);
        installer
            .import_file(
                &access,
                &catalog,
                &bytes,
                &common::Keys::sign(&keys.publisher, digest.as_bytes()),
                "sample",
                true,
            )
            .unwrap();
    }
    let host = Host::new(Limits::default()).unwrap();
    let request = json!({"operation":"call","resource":provider.id,"parameters":{"name":"read"}});
    assert_eq!(
        call(
            &host,
            services.clone(),
            &consumer,
            a,
            "api",
            request.clone()
        )
        .unwrap(),
        true
    );
    let mut undeclared = consumer.clone();
    undeclared.requires.clear();
    assert!(call(&host, services.clone(), &undeclared, a, "api", request).is_err());
    let subscribe =
        json!({"operation":"subscribe","resource":"changed","parameters":{"module":provider.id}});
    call(&host, services.clone(), &consumer, a, "events", subscribe).unwrap();
    call(
        &host,
        services.clone(),
        &provider,
        a,
        "events",
        json!({"operation":"publish","resource":"changed","parameters":{"count":1}}),
    )
    .unwrap();
    let poll = json!({"operation":"poll","resource":"changed","parameters":{"module":provider.id}});
    assert_eq!(
        call(
            &host,
            services.clone(),
            &consumer,
            a,
            "events",
            poll.clone()
        )
        .unwrap()[0]["data"],
        json!({"count":1})
    );
    assert!(call(
        &host,
        services.clone(),
        &consumer,
        b,
        "events",
        poll.clone()
    )
    .is_err());
    let tool =
        json!({"operation":"run","resource":"erase","parameters":{"parameters":{"count":1}}});
    services
        .approve_tool(&access, &provider.id, "erase", &json!({"count":1}))
        .unwrap();
    assert!(call(&host, services.clone(), &provider, b, "tools", tool.clone()).is_err());
    assert_eq!(
        call(&host, services.clone(), &provider, a, "tools", tool.clone()).unwrap(),
        true
    );
    assert!(
        call(&host, services.clone(), &provider, a, "tools", tool).is_err(),
        "A grant is consumed once"
    );
    assert!(installer
        .dispatch(access.clone(), "GET", "/api/m/sample.provider/read", "{}")
        .is_err());
    assert_eq!(
        installer
            .dispatch(access.clone(), "POST", "/api/m/sample.provider/read", "{}")
            .unwrap()
            .trim(),
        "true"
    );
    installer.set_enabled(&access, &provider.id, false).unwrap();
    assert!(installer
        .dispatch(access.clone(), "POST", "/api/m/sample.provider/read", "{}")
        .is_err());
    assert!(call(&host, services.clone(), &consumer, a, "events", poll).is_err());
    assert_eq!(
        installer
            .dispatch(
                AccessContext::new(b, "other-account"),
                "POST",
                "/api/m/sample.provider/read",
                "{}"
            )
            .unwrap()
            .trim(),
        "true"
    );
    println!("PASS installed Wasm public API/dependency checks, event subscriptions/account boundaries, one-use tool approval, signed-in route declarations and per-account disable");
}

#[test]
fn api_calls_cannot_dispatch_private_provider_routes() {
    use moss_module_host::{
        lifecycle::FileLifecycle, registry::Source, sql::LegacyInventory, store::Installer,
    };
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    keys.write(registry.path(), "1.0.0", 1, vec![]);
    let actor = uuid::Uuid::new_v4();
    let access = AccessContext::new(actor, "api-routing");
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let installer = Arc::new(
        Installer::new(
            data.path(),
            Arc::new(ServiceCatalog::default()),
            Arc::new(FileLifecycle::new(data.path(), [actor].into()).unwrap()),
            Host::new(Limits::default()).unwrap(),
            services.clone(),
            "0.1.0".parse().unwrap(),
            LegacyInventory::default(),
        )
        .unwrap(),
    );
    services.bind(&installer);
    let root = common::Keys::public(&keys.root);
    let catalog = installer
        .refresh(
            &access,
            Source::Folder(registry.path().into()),
            &root,
            &root,
            "sample-registry",
        )
        .unwrap();
    let mut provider = common::manifest("1.0.0");
    provider.id = "sample.provider".into();
    provider
        .provides
        .insert("read".into(), "1.0.0".parse().unwrap());
    let mut consumer = common::manifest("1.0.0");
    consumer.id = "sample.consumer".into();
    consumer
        .requires
        .insert(provider.id.clone(), "^1".parse().unwrap());
    consumer.capabilities = vec![Capability {
        port: "api".into(),
        operations: ["call".into()].into(),
        resources: [provider.id.clone()].into(),
        allow_private: false,
    }];
    let template = include_str!("../sample/module.wat");
    let start = template.find("      local.get $kind").unwrap();
    let end = template.find("      i32.const 32))").unwrap();
    let body = r#"      local.get $kind i32.load8_u i32.const 97 i32.eq
      if
        i32.const 32 i32.const 0 i32.store
        i32.const 36 local.get $payload i32.store
        i32.const 40 local.get $length i32.store
      else
        i32.const 32 i32.const 0 i32.store
        i32.const 36 i32.const 128 i32.store
        i32.const 40 i32.const 16 i32.store
      end
"#;
    let provider_source = format!("{}{}{}", &template[..start], body, &template[end..])
        .replace(r#""healthy""#, r#""{\22private\22:true}""#);
    for (manifest, wasm) in [
        (&provider, wat::parse_str(provider_source).unwrap()),
        (
            &consumer,
            wat::parse_str(template.replace("moss:module/kv@", "moss:module/api@")).unwrap(),
        ),
    ] {
        let mut files = common::files(manifest);
        files.insert("code/module.wasm".into(), wasm);
        let bytes = moss_module_host::archive::pack(&files).unwrap();
        let digest = moss_module_host::trust::digest(&bytes);
        installer
            .import_file(
                &access,
                &catalog,
                &bytes,
                &common::Keys::sign(&keys.publisher, digest.as_bytes()),
                "sample",
                true,
            )
            .unwrap();
    }
    let request = |parameters: Value| {
        json!({"operation":"call","resource":"sample.provider","parameters":parameters}).to_string()
    };
    assert!(installer
        .call(
            "sample.consumer",
            access.clone(),
            "route",
            &request(json!({"name":"read","method":"POST","path":"/private","body":{}}))
        )
        .is_err());
    let result = installer
        .call(
            "sample.consumer",
            access,
            "route",
            &request(json!({"name":"read","parameters":{"method":"POST","path":"/private"}})),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result).unwrap(),
        json!({"name":"read","parameters":{"method":"POST","path":"/private"}})
    );
    println!("PASS real installed API guest: forged route envelope refused; route-shaped arguments reach only the dedicated public API handler");
}

struct ActorModels;
#[async_trait::async_trait]
impl moss_platform_routing::ConfigurationStore for ActorModels {
    async fn for_actor(
        &self,
        actor: moss_platform_contracts::Actor,
    ) -> std::result::Result<moss_platform_routing::Configuration, moss_platform_contracts::Error>
    {
        use moss_platform_routing::{Capability, Configuration, Model, Tier};
        Ok(Configuration {
            pinned_model: Some(actor.user_id()),
            models: vec![Model {
                id: actor.user_id(),
                provider_id: actor.user_id(),
                provider_model_id: "host-selected".into(),
                capabilities: vec![Capability::Summarization],
                tier: Tier::Interactive,
                active: true,
                provider_active: true,
                assistant: true,
                automatic_eligible: true,
                default_sentinel: false,
                shared_transcription_eligible: false,
                voice_endpoint: false,
                allow_user_override: false,
                released_at: None,
                created_at: "2026-11-08".into(),
            }],
            ..Default::default()
        })
    }
}
struct RecordingAi;
#[async_trait::async_trait]
impl moss_platform_routing::CapabilityTransport for RecordingAi {
    async fn generate(
        &self,
        actor: moss_platform_contracts::Actor,
        model: &moss_platform_routing::Model,
        messages: &[moss_platform_routing::Turn],
        max: u32,
    ) -> std::result::Result<String, moss_platform_contracts::Error> {
        assert_eq!(model.id, actor.user_id());
        assert_eq!(model.provider_model_id, "host-selected");
        assert_eq!(messages[0].content, "Summarize this");
        assert_eq!(max, 16);
        Ok(actor.user_id().to_string())
    }
}
struct NoEmbeddings;
#[async_trait::async_trait]
impl moss_module_host::ai::EmbeddingStore for NoEmbeddings {
    async fn for_actor(
        &self,
        _: moss_platform_contracts::Actor,
    ) -> Result<moss_module_host::ai::EmbeddingEndpoint> {
        anyhow::bail!("Not configured")
    }
}
#[test]
fn wasm_ai_uses_phase2b_router_and_host_actor_model_selection() {
    let data = tempfile::tempdir().unwrap();
    let intelligence =
        moss_module_host::ai::RouterIntelligence::new(ActorModels, RecordingAi, NoEmbeddings)
            .unwrap();
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(intelligence),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap(),
    );
    let mut m = common::manifest("1.0.0");
    m.capabilities.push(Capability {
        port: "ai".into(),
        operations: ["generate".into()].into(),
        resources: ["summarization".into()].into(),
        allow_private: false,
    });
    let host = Host::new(Limits::default()).unwrap();
    let r = json!({"operation":"generate","resource":"summarization","parameters":{"prompt":"Summarize this","maxOutputTokens":16,"model":"guest-untrusted-choice","actorUserId":uuid::Uuid::new_v4()}});
    // A guest cannot smuggle an actor even as an ignored provider option.
    assert!(call(&host, services.clone(), &m, uuid::Uuid::new_v4(), "ai", r).is_err());
    let r = json!({"operation":"generate","resource":"summarization","parameters":{"prompt":"Summarize this","maxOutputTokens":16,"model":"guest-untrusted-choice"}});
    assert!(call(&host, services.clone(), &m, uuid::Uuid::new_v4(), "ai", r).is_err());
    let r = json!({"operation":"generate","resource":"summarization","parameters":{"prompt":"Summarize this","maxOutputTokens":16}});
    for actor in [uuid::Uuid::new_v4(), uuid::Uuid::new_v4()] {
        assert_eq!(
            call(&host, services.clone(), &m, actor, "ai", r.clone()).unwrap()["text"],
            actor.to_string()
        );
    }
    println!("PASS real Wasm + Phase2b Router: authenticated actor chooses account model, guest model name refused; AI transport is a test stand-in");
}
