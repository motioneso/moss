mod common;
#[path = "chat_tools/fixture.rs"]
mod fixture;
#[path = "chat_tools/privacy.rs"]
mod privacy;
#[path = "chat_tools/schema.rs"]
mod schema;
use fixture::*;
use moss_module_host::{
    chat_tools::{chat_tool_rule, ChatToolRule},
    store::CatalogStore,
};
use serde_json::{json, Value};

fn params() -> Value {
    json!({"text":"hello"})
}
#[test]
fn rule_table_and_account_policy_agree_with_execution() {
    let f = Fixture::new(manifest(), card(), None);
    for policy in [None, Some(false), Some(true)] {
        for (risk, pinned, expected) in [
            ("read", false, ChatToolRule::Run),
            ("read", true, ChatToolRule::Card { pinned: true }),
            (
                "write",
                false,
                if policy == Some(true) {
                    ChatToolRule::Card { pinned: false }
                } else {
                    ChatToolRule::RunUnlessPolicy
                },
            ),
            ("write", true, ChatToolRule::Card { pinned: true }),
            ("destructive", false, ChatToolRule::Card { pinned: false }),
            ("outbound", false, ChatToolRule::Card { pinned: false }),
        ] {
            assert_eq!(chat_tool_rule(&tool(risk, pinned), policy), expected);
        }
    }
    assert_eq!(f.host.chat_tools(&f.a).unwrap().len(), 5);
    assert_eq!(
        f.host
            .run_chat_tool(&f.a, MODULE, "sample.read", params())
            .unwrap()["parameters"],
        params()
    );
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.write", params())
        .is_ok());
    f.services
        .set_action_policy(
            &f.a,
            MODULE,
            &[("sample.write".into(), true), ("sample.read".into(), true)].into(),
        )
        .unwrap();
    let list = f.host.chat_tools(&f.a).unwrap();
    assert_eq!(
        list.iter().find(|t| t.tool == "sample.write").unwrap().rule,
        ChatToolRule::Card { pinned: false }
    );
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.write", params())
        .is_err());
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.read", params())
        .is_ok());
    assert!(f
        .host
        .run_chat_tool(&f.b, MODULE, "sample.write", params())
        .is_ok());
}
#[test]
fn card_required_auto_run_is_refused() {
    let f = Fixture::new(manifest(), card(), None);
    for name in ["sample.erase", "sample.send", "sample.pin"] {
        assert!(
            f.host.run_chat_tool(&f.a, MODULE, name, params()).is_err(),
            "{name}"
        );
    }
}
#[test]
fn approved_call_forwards_shown_version_and_consumes_grant_before_guest() {
    let f = Fixture::new(manifest(), card(), None);
    assert!(f
        .host
        .run_approved_chat_tool(&f.a, MODULE, "sample.pin", params(), None)
        .is_err());
    for version in ["", &"v".repeat(257)] {
        assert!(f
            .host
            .run_approved_chat_tool(&f.a, MODULE, "sample.pin", params(), Some(version))
            .is_err());
    }
    let out = f
        .host
        .run_approved_chat_tool(&f.a, MODULE, "sample.pin", params(), Some("shown-version"))
        .unwrap();
    assert_eq!(
        out,
        json!({"tool":"sample.pin","parameters":params(),"approvalVersion":"shown-version"})
    );
    assert!(f
        .host
        .run_approved_chat_tool(&f.a, MODULE, "sample.erase", params(), None)
        .is_ok());
    // The existing tools.run port shares the consuming gate, but cannot reuse chat's grant.
    assert!(legacy_run(&f, &f.a, "sample.pin", params()).is_err());
}
fn legacy_run(
    f: &Fixture,
    access: &access_context::AccessContext,
    name: &str,
    params: Value,
) -> anyhow::Result<String> {
    let mut m = manifest();
    m.capabilities.push(moss_module_host::manifest::Capability {
        port: "tools".into(),
        operations: ["run".into()].into(),
        resources: m.tools.keys().cloned().collect(),
        allow_private: false,
    });
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/tools@"),
    )
    .unwrap();
    moss_module_host::runtime::Host::new(Default::default())
        .unwrap()
        .call(
            &wasm,
            std::sync::Arc::new(m),
            access.clone(),
            f.services.clone(),
            "route",
            &json!({"operation":"run","resource":name,"parameters":{"parameters":params}})
                .to_string(),
        )
}
#[test]
fn grant_binds_actor_module_tool_exact_parameters_and_single_use() {
    let f = Fixture::new(manifest(), card(), None);
    f.services
        .approve_tool(&f.a, MODULE, "sample.erase", &params())
        .unwrap();
    assert!(legacy_run(&f, &f.b, "sample.erase", params()).is_err());
    assert!(legacy_run(&f, &f.admin, "sample.erase", params()).is_err());
    assert!(legacy_run(&f, &f.a, "sample.send", params()).is_err());
    assert!(legacy_run(&f, &f.a, "sample.erase", json!({"text":"changed"})).is_err());
    assert!(legacy_run(&f, &f.a, "sample.erase", params()).is_ok());
    assert!(legacy_run(&f, &f.a, "sample.erase", params()).is_err());
}
#[test]
fn switched_off_tools_vanish_and_forged_calls_are_refused() {
    let f = Fixture::new(manifest(), card(), None);
    f.host.set_enabled(&f.a, MODULE, false).unwrap();
    assert!(f.host.chat_tools(&f.a).unwrap().is_empty());
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.read", params())
        .is_err());
    assert!(f
        .host
        .run_approved_chat_tool(&f.a, MODULE, "sample.erase", params(), None)
        .is_err());
    assert!(f
        .host
        .chat_tool_card(&f.a, MODULE, "sample.erase", &params())
        .is_err());
    assert_eq!(f.host.chat_tools(&f.b).unwrap().len(), 5);
    let mut state = f.catalog.load().unwrap();
    let revision = state.revision;
    state.installed.get_mut(MODULE).unwrap().disabled = Some("disabled".into());
    state.revision += 1;
    f.catalog.commit(revision, &state).unwrap();
    assert!(f.host.chat_tools(&f.b).unwrap().is_empty());
    assert!(f
        .host
        .run_chat_tool(&f.b, MODULE, "sample.read", params())
        .is_err());
}
#[test]
fn public_dispatch_cannot_bypass_the_tool_gate() {
    let f = Fixture::new(manifest(), card(), None);
    assert!(f
        .host
        .call(
            MODULE,
            f.a.clone(),
            "tool",
            &json!({"tool":"sample.erase","parameters":params()}).to_string()
        )
        .is_err());
}
#[test]
fn card_fixed_parts_come_from_host_and_manifest() {
    let f = Fixture::new(manifest(), card(), None);
    let card = f
        .host
        .chat_tool_card(&f.a, MODULE, "sample.erase", &json!({"text":"MODEL VALUE"}))
        .unwrap()
        .unwrap();
    assert_eq!(card.title, "Action request");
    assert_eq!(card.target, "Sample counter: Change saved item");
    assert_eq!(card.fields[0].label, "Item");
    assert_eq!(card.fields[0].value, "MODEL VALUE");
    assert!(card
        .fields
        .iter()
        .all(|field| !field.label.contains("MODEL VALUE")));
    assert!(card.danger);
    assert_eq!(card.version.as_deref(), Some("row-v1"));
}
#[test]
fn malformed_and_failed_cards_return_errors_missing_builder_is_absent() {
    for raw in [
        Value::Null,
        json!({}),
        json!({"fields":"bad"}),
        json!({"fields":[]}),
        json!({"fields":[],"version":null}),
        json!({"fields":[],"version":""}),
        json!({"fields":[{"label":"x","value":3}]}),
        json!({"fields":[],"version":"x".repeat(257)}),
    ] {
        let f = Fixture::new(manifest(), raw, None);
        assert!(f
            .host
            .chat_tool_card(&f.a, MODULE, "sample.pin", &params())
            .is_err());
    }
    let mut m = manifest();
    m.tools.get_mut("sample.erase").unwrap().card = None;
    let f = Fixture::new(m, card(), None);
    assert!(f
        .host
        .chat_tool_card(&f.a, MODULE, "sample.erase", &params())
        .unwrap()
        .is_none());
}
#[test]
fn schema_validation_precedes_all_guest_entry_points() {
    let f = Fixture::new(manifest(), card(), None);
    for p in [
        json!({}),
        json!({"text":4}),
        json!({"text":"x".repeat(101)}),
        json!({"text":"ok","extra":true}),
        json!(null),
    ] {
        assert!(f
            .host
            .run_chat_tool(&f.a, MODULE, "sample.read", p.clone())
            .is_err());
        assert!(f
            .host
            .run_approved_chat_tool(&f.a, MODULE, "sample.erase", p.clone(), None)
            .is_err());
        assert!(f
            .host
            .chat_tool_card(&f.a, MODULE, "sample.erase", &p)
            .is_err());
    }
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.legacy", params())
        .is_err());
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "missing", params())
        .is_err());
}

#[test]
fn grant_does_not_cross_modules() {
    let f = Fixture::new(manifest(), card(), None);
    f.services
        .approve_tool(&f.a, "sample.other", "sample.erase", &params())
        .unwrap();
    assert!(legacy_run(&f, &f.a, "sample.erase", params()).is_err());
}
#[test]
fn expired_grant_is_refused() {
    let f = Fixture::new(manifest(), card(), None);
    f.services
        .approve_tool(&f.a, MODULE, "sample.erase", &params())
        .unwrap();
    let root = vault::Root::open(&f._data.path().join("modules/files").join(MODULE)).unwrap();
    let context = vault::VaultContext::for_module_files(&root, &f.a).unwrap();
    let key =
        moss_module_host::trust::digest(&serde_json::to_vec(&("sample.erase", params())).unwrap());
    context
        .write(
            &format!("host/approval-{key}.json"),
            br#"{"expires":0,"version":null}"#,
        )
        .unwrap();
    assert!(legacy_run(&f, &f.a, "sample.erase", params()).is_err());
}
#[test]
fn duplicate_wire_names_are_refused() {
    let f = Fixture::new(manifest(), card(), None);
    let mut state = f.catalog.load().unwrap();
    let revision = state.revision;
    let mut duplicate = state.installed[MODULE].clone();
    duplicate.manifest.id = "sample.other".into();
    state.installed.insert("sample.other".into(), duplicate);
    state.revision += 1;
    f.catalog.commit(revision, &state).unwrap();
    assert!(f.host.chat_tools(&f.a).is_err());
}

#[test]
fn oversized_card_and_arguments_are_complete_and_still_require_exact_approval() {
    let mut m = manifest();
    m.tools
        .get_mut("sample.erase")
        .unwrap()
        .input_schema
        .as_mut()
        .unwrap()["properties"]["text"]["maxLength"] = json!(100000);
    let raw = json!({"batch":true,"fields":(0..128).map(|index|
        json!({"label":format!("Row {index}"),"value":"界".repeat(4000)})).collect::<Vec<_>>(),
        "content":"Long content ".repeat(1000)});
    assert!(raw.to_string().len() > 1024 * 1024);
    let f = Fixture::new(m, raw.clone(), None);
    // Stored records may produce a large disclosure even when the call only carries an ID.
    let short = f
        .host
        .chat_tool_card(&f.a, MODULE, "sample.erase", &params())
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_value(&short.fields).unwrap(), raw["fields"]);
    assert!(
        f.host
            .call(
                MODULE,
                f.a.clone(),
                "api",
                &json!({"name":"prepare","parameters":{}}).to_string()
            )
            .is_err(),
        "ordinary API response budget remains unchanged"
    );
    let p = json!({"text":"p".repeat(70000)});
    let card = f
        .host
        .chat_tool_card(&f.a, MODULE, "sample.erase", &p)
        .unwrap()
        .unwrap();
    assert!(card.batch);
    assert_eq!(serde_json::to_value(&card.fields).unwrap(), raw["fields"]);
    assert_eq!(card.content.as_deref(), raw["content"].as_str());
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.erase", p.clone())
        .is_err());
    assert_eq!(
        f.host
            .run_approved_chat_tool(&f.a, MODULE, "sample.erase", p.clone(), None)
            .unwrap()["parameters"],
        p
    );
}

#[test]
fn explicit_public_builder_error_survives_as_a_sanitized_preparation_failure() {
    let public =
        moss_module_sdk::Error::public("stale_source", "Read the current revision and try again.");
    let f = Fixture::new(manifest(), json!({"fixtureError":public.message}), None);
    let error = f
        .host
        .chat_tool_card(&f.a, MODULE, "sample.erase", &params())
        .unwrap_err();
    let error = error
        .downcast_ref::<moss_module_host::chat_tools::CardBuildError>()
        .unwrap();
    assert_eq!(error.code, "stale_source");
    assert_eq!(error.message, "Read the current revision and try again.");
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.erase", params())
        .is_err());
}
