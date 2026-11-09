mod common;
use access_context::AccessContext;
use moss_module_host::{
    account_contracts::{PolicyRoute, PolicyTier},
    manifest::Capability,
    runtime::{DenyPorts, Host, Limits},
    transactional_database::TransactionalDatabasePorts,
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
};

#[test]
fn declarations_cannot_name_another_module_preference() {
    let mut m = common::manifest("1.0.0");
    for family in ["other.family", "", "../other"] {
        m.policy_routes = [(
            family.into(),
            PolicyRoute {
                install_tier: PolicyTier::AskEachTime,
                legacy_boolean: None,
            },
        )]
        .into();
        assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
    }
    m.policy_routes = [(
        "changes".into(),
        PolicyRoute {
            install_tier: PolicyTier::AskEachTime,
            legacy_boolean: Some("other.key".into()),
        },
    )]
    .into();
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
}

#[test]
#[ignore = "Only through verify-gate account-contracts gate"]
fn compiled_contracts_preserve_policy_rows_privacy_and_account_days() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let owner = uuid::Uuid::new_v4();
    let other = uuid::Uuid::new_v4();
    let admin = uuid::Uuid::new_v4();
    let (bootstrap,database) = rt.block_on(async {
        let (db,conn) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(),tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {let _=conn.await;});
        for (id,is_admin) in [(owner,false),(other,false),(admin,true)] {
            db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Contract proof',$3)", &[&id,&format!("{id}@example.test"),&is_admin]).await.unwrap();
        }
        let database=Database::connect(&std::env::var("JS43_APP_URL").unwrap(),4,RuntimeRole::App).await.unwrap();
        (db,database)
    });
    let host = Host::new(Limits::default()).unwrap();
    let ports = Arc::new(TransactionalDatabasePorts::new(database, Arc::new(DenyPorts)).unwrap());
    let mut m = common::manifest("1.0.0");
    m.policy_routes = [(
        "changes".into(),
        PolicyRoute {
            install_tier: PolicyTier::TrustedAuto,
            legacy_boolean: Some("auto_execute".into()),
        },
    )]
    .into();
    m.capabilities = vec![
        Capability {
            port: "action-policy".into(),
            operations: ["route-read".into(), "route-write".into()].into(),
            resources: ["changes".into()].into(),
            allow_private: false,
        },
        Capability {
            port: "context".into(),
            operations: ["local-date".into()].into(),
            resources: ["account".into()].into(),
            allow_private: false,
        },
    ];
    m.validate(&"0.1.0".parse().unwrap()).unwrap();
    let call = |actor, port: &str, op: &str, resource: &str, parameters: Value| {
        let wasm = wat::parse_str(
            include_str!("../sample/module.wat")
                .replace("moss:module/kv@1.0.0", &format!("moss:module/{port}@1.0.0")),
        )
        .unwrap();
        host.call(
            &wasm,
            Arc::new(m.clone()),
            AccessContext::new(actor, "account-contracts"),
            ports.clone(),
            "route",
            &json!({"operation":op,"resource":resource,"parameters":parameters}).to_string(),
        )
        .map(|reply| serde_json::from_str::<Value>(&reply).unwrap())
    };
    let set = |actor, tier: &str| {
        call(
            actor,
            "action-policy",
            "route-write",
            "changes",
            json!({"tier":tier}),
        )
        .unwrap()
    };
    let read = |actor| call(actor, "action-policy", "route-read", "changes", json!({})).unwrap();
    assert_eq!(read(owner), json!({"tier":"trusted_auto"}));
    set(owner, "always_confirm");
    rt.block_on(async {
        let rows=bootstrap.query("SELECT key,value_json FROM app.preferences WHERE owner_user_id=$1 ORDER BY key",&[&owner]).await.unwrap();
        assert_eq!(rows.len(),2);
        assert_eq!(rows[0].get::<_,String>(0),"assistant.action_policy.v1.sample.counter.changes");
        assert_eq!(rows[0].get::<_,Value>(1),"always_confirm");
        assert_eq!(rows[1].get::<_,Value>(1),false);
        bootstrap.execute("UPDATE app.preferences SET value_json='true' WHERE owner_user_id=$1 AND key='sample.counter.auto_execute'",&[&owner]).await.unwrap();
    });
    assert_eq!(read(owner), json!({"tier":"always_confirm"}));
    let trapped = wat::parse_str(
        include_str!("../sample/module.wat")
            .replace("moss:module/kv@1.0.0", "moss:module/action-policy@1.0.0")
            .replace("i32.const 32))", "unreachable))"),
    )
    .unwrap();
    assert!(host.call(&trapped,Arc::new(m.clone()),AccessContext::new(owner,"rollback-policy"),ports.clone(),"route",&json!({"operation":"route-write","resource":"changes","parameters":{"tier":"ask_each_time"}}).to_string()).is_err());
    assert_eq!(read(owner), json!({"tier":"always_confirm"}));

    // One legacy opt-out must suppress the install grant.
    rt.block_on(bootstrap.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'sample.counter.auto_execute','false')",&[&other])).unwrap();
    assert_eq!(read(other), json!({"tier":"ask_each_time"}));
    assert_eq!(read(admin), json!({"tier":"trusted_auto"}));
    assert!(call(
        owner,
        "action-policy",
        "route-write",
        "changes",
        json!({"tier":"trusted_auto","actorUserId":other})
    )
    .is_err());
    assert!(call(owner, "action-policy", "route-read", "other", json!({})).is_err());
    rt.block_on(async {
        bootstrap
            .execute(
                "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale',$2)",
                &[&owner, &json!({"timezone":"asia/tokyo"})],
            )
            .await
            .unwrap();
    });
    let day = |actor| {
        call(
            actor,
            "context",
            "local-date",
            "account",
            json!({"instant":"2026-03-08T07:30:00Z"}),
        )
        .unwrap()
    };
    assert_eq!(day(owner)["date"], "2026-03-08");
    assert_eq!(day(owner)["timezone"], "asia/tokyo");
    let local = |parameters| call(other, "context", "local-date", "account", parameters).unwrap();
    let spring = local(json!({"date":"2026-03-08"}));
    assert_eq!(spring["start"], "2026-03-08T08:00:00.000Z");
    assert_eq!(spring["nextStart"], "2026-03-09T07:00:00.000Z");
    let fall = local(json!({"date":"2026-11-01"}));
    assert_eq!(fall["start"], "2026-11-01T07:00:00.000Z");
    assert_eq!(fall["nextStart"], "2026-11-02T08:00:00.000Z");
    for parameters in [
        json!({"actorUserId":owner}),
        json!({"date":"bad"}),
        json!({"offsetDays":36601}),
        json!({"date":"2026-03-08","instant":"2026-03-08T00:00:00Z"}),
    ] {
        assert!(call(other, "context", "local-date", "account", parameters).is_err());
    }

    let private = || {
        for actor in [other, admin] {
            assert_eq!(
                day(actor)["timezone"],
                "America/Los_Angeles",
                "another account must not see the owner's locale"
            );
        }
    };
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"))
        .unwrap();
    let red = catch_unwind(AssertUnwindSafe(private));
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY; ALTER TABLE app.preferences FORCE ROW LEVEL SECURITY")).unwrap();
    assert!(
        red.is_err(),
        "the privacy assertion must fail with RLS removed"
    );
    println!("PASS account-date privacy control: assertion failed with RLS removed");
    private();
    for actor in [other, admin] {
        set(actor, "ask_each_time");
    }
    assert_eq!(read(owner), json!({"tier":"always_confirm"}));
    // Cross-account writes must not change the owner's canonical choice.
    // Leave just the owner's policy keys so the removal control cannot depend
    // on which of several visible accounts PostgreSQL happens to return first.
    rt.block_on(bootstrap.execute(
        "DELETE FROM app.preferences WHERE owner_user_id=ANY($1::uuid[]) AND key <> 'locale'",
        &[&vec![other, admin]],
    ))
    .unwrap();
    let private_policy = || assert_eq!(read(other), json!({"tier":"trusted_auto"}));
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.preferences DISABLE ROW LEVEL SECURITY"))
        .unwrap();
    let red = catch_unwind(AssertUnwindSafe(private_policy));
    rt.block_on(bootstrap.batch_execute("ALTER TABLE app.preferences ENABLE ROW LEVEL SECURITY; ALTER TABLE app.preferences FORCE ROW LEVEL SECURITY")).unwrap();
    assert!(
        red.is_err(),
        "policy privacy assertion must fail with RLS removed"
    );
    private_policy();
    println!("PASS policy privacy control: assertion failed with RLS removed, passed restored");
}
