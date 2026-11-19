mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    archive::Package,
    runtime::{authorize, CallScope, Host, Limits, Ports, Request},
    trust,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
struct Capture(Mutex<Vec<(uuid::Uuid, String)>>);
impl Ports for Capture {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        self.0
            .lock()
            .unwrap()
            .push((scope.access().actor_user_id(), port.into()));
        Ok(json!({"value":request.parameters}))
    }
}
#[test]
fn tampered_package_is_refused() {
    let bytes = common::bytes("1.0.0");
    let digest = trust::digest(&bytes);
    let mut files = common::files(&common::manifest("1.0.0"));
    files.insert(
        "CHANGELOG.md".into(),
        b"Tampered but valid archive".to_vec(),
    );
    let bytes = moss_module_host::archive::pack(&files).unwrap();
    assert!(Package::read(&bytes, &digest, &"0.1.0".parse().unwrap()).is_err());
}
#[test]
fn package_is_reproducible() {
    assert_eq!(common::bytes("1.0.0"), common::bytes("1.0.0"));
}
#[test]
fn no_file_socket_or_database_escape_imports() {
    let host = Host::new(Limits::default()).unwrap();
    let manifest = common::manifest("1.0.0");
    for name in [
        "wasi:filesystem/types@0.2.0",
        "wasi:sockets/tcp@0.2.0",
        "postgres:client/connection@1.0.0",
        "wasi:cli/environment@0.2.0",
    ] {
        let component = format!(r#"(component (import "{name}" (instance)))"#);
        let wasm = wat::parse_str(&component).unwrap();
        let error = host.validate(&wasm, &manifest).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("undeclared or forbidden host service"),
            "{name}: {error:#}"
        );
    }
}
#[test]
fn undeclared_moss_import_is_refused() {
    let host = Host::new(Limits::default()).unwrap();
    let mut m = common::manifest("1.0.0");
    m.capabilities.clear();
    assert!(host.validate(&common::wasm(), &m).is_err());
}
#[test]
fn sample_runs_through_real_component_and_host_port() {
    let host = Host::new(Limits::default()).unwrap();
    let m = Arc::new(common::manifest("1.0.0"));
    let ports = Arc::new(Capture(Mutex::new(vec![])));
    let actor = uuid::Uuid::new_v4();
    let response = host
        .call(
            &common::wasm(),
            m,
            AccessContext::new(actor, "sample"),
            ports.clone(),
            "route",
            r#"{"operation":"set","resource":"counter","parameters":{"count":7}}"#,
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response).unwrap(),
        json!({"value":{"count":7}})
    );
    assert_eq!(*ports.0.lock().unwrap(), vec![(actor, "kv".into())]);
}
#[test]
fn guest_cannot_select_another_actor_or_resource() {
    let m = common::manifest("1.0.0");
    for parameters in [
        json!({"actorUserId":"other"}),
        json!({"nested":{"role":"admin"}}),
    ] {
        assert!(authorize(
            &m,
            "kv",
            &Request {
                operation: "get".into(),
                resource: "counter".into(),
                parameters
            }
        )
        .is_err());
    }
    assert!(authorize(
        &m,
        "kv",
        &Request {
            operation: "get".into(),
            resource: "another-module".into(),
            parameters: json!({})
        }
    )
    .is_err());
}
#[test]
fn manifest_refuses_unknown_fields_and_model_selection() {
    let mut value = serde_json::to_value(common::manifest("1.0.0")).unwrap();
    value["newPermission"] = json!(true);
    assert!(serde_json::from_value::<moss_module_host::manifest::Manifest>(value).is_err());
    let mut m = common::manifest("1.0.0");
    m.features = vec![json!({"model":"chosen-by-module"})];
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
}
#[test]
fn fuel_and_memory_limits_stop_the_sample() {
    let limits = Limits {
        fuel: 1,
        ..Limits::default()
    };
    let host = Host::new(limits).unwrap();
    let access = AccessContext::new(uuid::Uuid::new_v4(), "limited");
    assert!(host
        .call(
            &common::wasm(),
            Arc::new(common::manifest("1.0.0")),
            access.clone(),
            Arc::new(moss_module_host::runtime::DenyPorts),
            "health",
            "{}"
        )
        .is_err());
    let limits = Limits {
        memory_bytes: 65536,
        ..Limits::default()
    };
    let host = Host::new(limits).unwrap();
    assert!(host
        .call(
            &common::wasm(),
            Arc::new(common::manifest("1.0.0")),
            access,
            Arc::new(moss_module_host::runtime::DenyPorts),
            "health",
            "{}"
        )
        .is_err());
}

#[test]
fn health_failure_fixture_succeeds_during_install() {
    let host = Host::new(Limits::default()).unwrap();
    let wasm = wat::parse_str(common::unhealthy_source()).unwrap();
    let manifest = Arc::new(common::manifest("1.0.0"));
    let access = AccessContext::new(uuid::Uuid::new_v4(), "health-only");
    host.call(
        &wasm,
        manifest.clone(),
        access.clone(),
        Arc::new(moss_module_host::runtime::DenyPorts),
        "install",
        "{}",
    )
    .unwrap();
    assert!(host
        .call(
            &wasm,
            manifest,
            access,
            Arc::new(moss_module_host::runtime::DenyPorts),
            "health",
            "{}"
        )
        .is_err());
}
#[test]
fn permission_growth_has_visible_operations_and_private_network_detail() {
    let old = common::manifest("1.0.0");
    let mut new = old.clone();
    new.capabilities[0].operations.insert("delete".into());
    let permissions = new.newly_requested(&old);
    assert_eq!(permissions.len(), 1);
    assert!(permissions[0].operations.contains("delete"));
    assert!(permissions[0]
        .details
        .iter()
        .any(|detail| detail.contains("delete")));
    new.capabilities = vec![moss_module_host::manifest::Capability {
        port: "fetch".into(),
        operations: ["get".into()].into(),
        resources: ["example.test".into()].into(),
        allow_private: true,
    }];
    let permissions = new.newly_requested(&old);
    assert!(permissions[0].allow_private);
    assert!(permissions[0]
        .details
        .iter()
        .any(|detail| detail.contains("private networks")));
}

#[test]
fn approval_describes_changed_credential_tool_and_install_scope() {
    use moss_module_host::manifest::{Attachment, Credential, CredentialScope, Tool};
    let mut old = common::manifest("1.0.0");
    old.capabilities
        .push(moss_module_host::manifest::Capability {
            port: "credentials".into(),
            operations: ["request".into()].into(),
            resources: ["example.test".into()].into(),
            allow_private: false,
        });
    old.capabilities
        .push(moss_module_host::manifest::Capability {
            port: "tools".into(),
            operations: ["run".into()].into(),
            resources: ["save".into()].into(),
            allow_private: false,
        });
    let mut new = old.clone();
    new.credentials.insert(
        "api".into(),
        Credential {
            exchange: None,
            scope: CredentialScope::Instance,
            hosts: ["example.test".into()].into(),
            attachment: Attachment::Header("authorization".into()),
            with: vec![],
            expose_fields: Default::default(),
        },
    );
    new.tools.insert(
        "save".into(),
        Tool {
            approval_version: false,
            input_schema: None,
            card: None,
            description: "Save".into(),
            risk: "destructive".into(),
        },
    );
    new.install_wide_kv.insert("counter".into());
    let added = new.newly_requested(&old);
    for port in ["kv", "credentials", "tools"] {
        assert!(
            added.iter().any(|p| p.port == port),
            "Missing approval for {port}"
        );
    }
    let descriptions = serde_json::to_string(&new.permissions()).unwrap();
    assert!(descriptions.contains("destructive"));
    assert!(descriptions.contains("instance"));
    assert!(descriptions.contains("counter"));
}

#[test]
fn target_approval_requirement_changes_are_visible_to_install_approval() {
    let mut old = common::manifest("1.0.0");
    old.capabilities
        .push(moss_module_host::manifest::Capability {
            port: "tools".into(),
            operations: ["run".into()].into(),
            resources: ["save".into()].into(),
            allow_private: false,
        });
    old.tools.insert(
        "save".into(),
        moss_module_host::manifest::Tool {
            description: "Save".into(),
            risk: "write".into(),
            approval_version: false,
            input_schema: None,
            card: None,
        },
    );
    let mut versioned = old.clone();
    versioned.tools.get_mut("save").unwrap().approval_version = true;
    for (next, previous) in [(&versioned, &old), (&old, &versioned)] {
        assert!(next
            .newly_requested(previous)
            .iter()
            .any(|p| p.port == "tools"));
    }
    assert!(serde_json::to_string(&versioned.permissions())
        .unwrap()
        .contains("displayed target approval required"));
    // Preserve serialization of existing signed package manifests.
    assert!(serde_json::to_value(&old.tools["save"])
        .unwrap()
        .get("approvalVersion")
        .is_none());
}

#[test]
fn migrations_are_numbered_forward_and_table_prefixes_do_not_alias() {
    let mut m = common::manifest("1.0.0");
    m.database.migrations = vec!["sql/0002_next.sql".into(), "sql/0001_first.sql".into()];
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
    m.database.migrations.clear();
    m.id = "sample.counter-more".into();
    m.database.owned_tables = vec!["app.sample_counter_more_entries".into()];
    assert!(
        m.validate(&"0.1.0".parse().unwrap()).is_err(),
        "Hyphens and dots must not alias table namespaces"
    );
}

#[test]
fn authenticated_compile_cache_rebuilds_tampered_native_bytes() {
    use safety_core::secret::Secret;
    let cache = tempfile::tempdir().unwrap();
    let m = common::manifest("1.0.0");
    let host = Host::cached(
        Limits::default(),
        cache.path(),
        Secret::new("test-only-cache-key-with-thirty-two-bytes"),
    )
    .unwrap();
    host.validate(&common::wasm(), &m).unwrap();
    drop(host);
    let path = std::fs::read_dir(cache.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let original = std::fs::read(&path).unwrap();
    let mut tampered = original.clone();
    tampered[0] ^= 1;
    std::fs::write(&path, tampered).unwrap();
    let host = Host::cached(
        Limits::default(),
        cache.path(),
        Secret::new("test-only-cache-key-with-thirty-two-bytes"),
    )
    .unwrap();
    host.validate(&common::wasm(), &m).unwrap();
    assert_eq!(
        std::fs::read(path).unwrap(),
        original,
        "Unauthenticated native code must be rebuilt"
    );
}

#[test]
fn nested_app_map_fields_are_checked_instead_of_silently_dropped() {
    let mut m = common::manifest("1.0.0");
    m.validate(&"0.1.0".parse().unwrap()).unwrap();
    m.navigation =
        vec![json!({"id":"counter","label":"Counter","path":"/counter","newPermission":true})];
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
    m.navigation.clear();
    m.features[0]["errors"][0]["newLimit"] = json!(true);
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
}

#[test]
fn manifest_fuel_request_is_clamped_to_the_host_ceiling() {
    let call = |limits: Limits, request: Option<u64>| {
        let mut manifest = common::manifest("1.0.0");
        manifest.fuel_limit = request;
        Host::new(limits)
            .unwrap()
            .call(
                &common::wasm(),
                Arc::new(manifest),
                AccessContext::new(uuid::Uuid::new_v4(), "fuel"),
                Arc::new(moss_module_host::runtime::DenyPorts),
                "health",
                "{}",
            )
            .is_ok()
    };
    let small = |ceiling| Limits {
        fuel: 1,
        fuel_ceiling: ceiling,
        ..Limits::default()
    };
    assert!(!call(small(10_000_000), None));
    assert!(call(small(10_000_000), Some(10_000_000)));
    assert!(!call(small(1), Some(10_000_000)));
    assert!(Host::new(Limits {
        fuel: 5,
        fuel_ceiling: 1,
        ..Limits::default()
    })
    .is_err());
    let mut manifest = common::manifest("1.0.0");
    manifest.fuel_limit = Some(0);
    assert!(manifest.validate(&"0.1.0".parse().unwrap()).is_err());
    manifest.fuel_limit = Some(moss_module_host::manifest::MAX_FUEL_REQUEST + 1);
    assert!(manifest.validate(&"0.1.0".parse().unwrap()).is_err());
}

#[test]
fn manifest_call_limit_defaults_grants_and_clamps() {
    use std::time::Duration;
    let limits = Limits {
        deadline: Duration::from_secs(5),
        deadline_ceiling: Duration::from_secs(30),
        ..Limits::default()
    };
    assert_eq!(limits.effective_deadline(None), Duration::from_secs(5));
    assert_eq!(limits.effective_deadline(Some(20_000)), Duration::from_secs(20));
    assert_eq!(limits.effective_deadline(Some(100_000)), Duration::from_secs(30));
    assert_eq!(limits.effective_deadline(Some(1_000)), Duration::from_secs(5));
    assert!(Host::new(Limits {
        deadline: Duration::from_secs(5),
        deadline_ceiling: Duration::from_secs(1),
        ..Limits::default()
    })
    .is_err());
    let mut manifest = common::manifest("1.0.0");
    manifest.call_limit_ms = Some(0);
    assert!(manifest.validate(&"0.1.0".parse().unwrap()).is_err());
    manifest.call_limit_ms = Some(moss_module_host::manifest::MAX_CALL_LIMIT_REQUEST_MS + 1);
    assert!(manifest.validate(&"0.1.0".parse().unwrap()).is_err());
    manifest.call_limit_ms = Some(15_000);
    manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
}

/// A host service that takes 6 seconds, like a slow AI model, but gives up at the call limit.
struct SlowPort;
impl moss_module_host::runtime::Ports for SlowPort {
    fn invoke(
        &self,
        scope: &moss_module_host::runtime::CallScope,
        _: &str,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<serde_json::Value> {
        let wanted = std::time::Duration::from_secs(6);
        if scope.remaining() < wanted {
            std::thread::sleep(scope.remaining());
            anyhow::bail!("deadline exceeded");
        }
        std::thread::sleep(wanted);
        Ok(json!("done"))
    }
}

#[test]
fn a_call_slower_than_five_seconds_needs_the_module_to_ask_for_more() {
    let run = |request: Option<u64>| {
        let mut manifest = common::manifest("1.0.0");
        manifest.call_limit_ms = request;
        let started = std::time::Instant::now();
        let result = Host::new(Limits::default()).unwrap().call(
            &common::wasm(),
            Arc::new(manifest),
            AccessContext::new(uuid::Uuid::new_v4(), "slow"),
            Arc::new(SlowPort),
            "route",
            r#"{"operation":"get","resource":"counter","parameters":{}}"#,
        );
        (result.is_ok(), started.elapsed())
    };
    let (ok, took) = run(None);
    assert!(!ok);
    assert!(took < std::time::Duration::from_millis(5_900), "{took:?}");
    let (ok, took) = run(Some(15_000));
    assert!(ok);
    assert!(took >= std::time::Duration::from_secs(6), "{took:?}");
}

#[test]
fn manifest_job_retries_reach_the_queue_spec_and_are_bounded() {
    let mut manifest = common::manifest("1.0.0");
    let job = manifest.jobs.keys().next().cloned();
    let Some(job) = job else {
        manifest.jobs.insert("sweep".into(), Default::default());
        return manifest_job_retries_reach_the_queue_spec_and_are_bounded_with(
            manifest,
            "sweep".into(),
        );
    };
    manifest_job_retries_reach_the_queue_spec_and_are_bounded_with(manifest, job);
}

fn manifest_job_retries_reach_the_queue_spec_and_are_bounded_with(
    mut manifest: moss_module_host::manifest::Manifest,
    job: String,
) {
    let spec = |m: &moss_module_host::manifest::Manifest| {
        moss_module_host::jobs::specs(m)
            .into_iter()
            .find(|s| s.name.ends_with(&format!(".{job}")))
            .unwrap()
            .retry_limit
    };
    assert_eq!(spec(&manifest), 3);
    manifest.job_retries.insert(job.clone(), 0);
    assert_eq!(spec(&manifest), 0);
    let moss = "0.1.0".parse().unwrap();
    assert!(manifest.validate(&moss).is_ok());
    manifest
        .job_retries
        .insert(job.clone(), moss_module_host::manifest::MAX_JOB_RETRIES);
    assert_eq!(spec(&manifest), moss_module_host::manifest::MAX_JOB_RETRIES);
    assert!(manifest.validate(&moss).is_ok());
    manifest
        .job_retries
        .insert(job, moss_module_host::manifest::MAX_JOB_RETRIES + 1);
    assert!(manifest.validate(&moss).is_err());
    manifest.job_retries.clear();
    manifest.job_retries.insert("not-a-job".into(), 0);
    assert!(manifest.validate(&moss).is_err());
}
