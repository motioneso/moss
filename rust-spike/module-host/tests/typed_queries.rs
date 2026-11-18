mod common;
use moss_module_host::{
    manifest::Capability,
    runtime::{authorize, Request},
};
use serde_json::json;

fn manifest() -> moss_module_host::manifest::Manifest {
    let mut m = common::manifest("1.0.0");
    m.database.owned_tables = vec!["app.sample_counter".into()];
    m.capabilities.push(Capability {
        port: "db".into(),
        operations: ["query".into()].into(),
        resources: ["app.sample_counter".into()].into(),
        allow_private: false,
    });
    m
}
#[test]
fn typed_queries_support_composite_keys_without_a_sql_escape() {
    let m = manifest();
    let request = Request {
        operation: "query".into(),
        resource: "app.sample_counter".into(),
        parameters: json!({"kind":"delete","filter":{"type":"and","filters":[
            {"type":"compare","column":"task_id","op":"eq","value":"one"},
            {"type":"compare","column":"tag_id","op":"eq","value":"two"}
        ]}}),
    };
    authorize(&m, "db", &request).unwrap();
    let mut forged = request.clone();
    forged.parameters["sql"] = json!("DELETE FROM app.users");
    assert!(authorize(&m, "db", &forged).is_err());
    forged = request.clone();
    forged.resource = "app.users".into();
    assert!(authorize(&m, "db", &forged).is_err());
}

#[test]
fn typed_query_values_remain_parameters_and_identifiers_are_checked() {
    use moss_module_sdk::query::{Filter, Query};
    let query = Query::select(Filter::eq("title", "'; DELETE FROM app.users; --"));
    let statement = moss_module_host::typed_query::compile("app.sample_counter", &query).unwrap();
    assert!(!statement.sql.contains("DELETE"));
    assert_eq!(
        statement.parameters,
        vec![json!({"title":"'; DELETE FROM app.users; --"})]
    );
    let bad = Query::select(Filter::eq("id) OR true --", "one"));
    assert!(moss_module_host::typed_query::compile("app.sample_counter", &bad).is_err());
    assert!(moss_module_host::typed_query::compile("app.users; DROP TABLE x", &query).is_err());
    let bad = Query::delete(Filter::All);
    assert!(moss_module_host::typed_query::compile("app.sample_counter", &bad).is_err());
}

#[test]
fn typed_upsert_keeps_conflicts_atomic_and_values_bound() {
    let query = serde_json::from_value(json!({
        "kind":"insert", "values":{"id":"one","title":"first"},
        "conflict":{"update":{"columns":["id"],"values":{"title":"'; DELETE FROM app.users; --"}}}
    }))
    .unwrap();
    let statement = moss_module_host::typed_query::compile("app.sample_counter", &query).unwrap();
    assert!(statement.sql.contains("ON CONFLICT (\"id\") DO UPDATE"));
    assert!(statement
        .sql
        .contains("WHERE row.owner_user_id = app.current_actor_user_id()"));
    assert!(!statement.sql.contains("DELETE"));
    assert_eq!(
        statement.parameters[1],
        json!({"title":"'; DELETE FROM app.users; --"})
    );
    for conflict in [
        json!({"update":{"columns":[],"values":{"title":"x"}}}),
        json!({"update":{"columns":["id) OR true --"],"values":{"title":"x"}}}),
        json!({"update":{"columns":["id"],"values":{"owner_user_id":"forged"}}}),
        json!({"update":{"columns":["id"],"values":{}}}),
        json!({"update":{"columns":["missing"],"values":{"title":"x"}}}),
    ] {
        let query = serde_json::from_value(
            json!({"kind":"insert","values":{"id":"one"},"conflict":conflict}),
        )
        .unwrap();
        assert!(moss_module_host::typed_query::compile("app.sample_counter", &query).is_err());
    }
}

#[test]
fn null_ordering_preserves_legacy_literals_and_rejects_unordered_options() {
    use moss_module_host::typed_query::{compile, compile_with_nulls_first, parse, validate};
    use moss_module_sdk::query::{Order, Query};
    let mut query = Query::default();
    query.order.push(Order {
        column: "created_at".into(),
        descending: true,
    });
    assert!(compile("app.sample_counter", &query)
        .unwrap()
        .sql
        .contains("DESC NULLS LAST"));
    let mut parameters = serde_json::to_value(&query).unwrap();
    parameters["nullsFirst"] = json!(["created_at"]);
    validate(parameters.clone()).unwrap();
    let (query, first) = parse(parameters.clone()).unwrap();
    assert!(
        compile_with_nulls_first("app.sample_counter", &query, &first)
            .unwrap()
            .sql
            .contains("DESC NULLS FIRST")
    );
    for invalid in [
        json!(true),
        json!(["missing"]),
        json!(["created_at", "created_at"]),
        json!(["created_at) OR true --"]),
    ] {
        parameters["nullsFirst"] = invalid;
        assert!(validate(parameters.clone()).is_err());
    }
    parameters["nullsFirst"] = json!(["created_at"]);
    parameters["sql"] = json!("SELECT * FROM app.users");
    assert!(validate(parameters).is_err());
}
