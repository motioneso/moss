use moss_module_host::typed_query::{compile, compile_with_nulls_first};
use moss_module_sdk::query::{Compare, Filter, Order, Query};
use serde_json::json;

#[test]
fn people_exact_case_lookup_is_not_a_pattern_or_sql_expression() {
    let query = Query::select(Filter::Compare {
        column: "display_name".into(),
        op: Compare::LowerEq,
        value: json!("alice_%' OR true --"),
    });
    let statement = compile("app.person_context_people", &query).unwrap();
    assert_eq!(
        statement.parameters,
        vec![json!({"display_name":"alice_%' OR true --"})]
    );
    assert!(statement
        .sql
        .contains("lower(row.\"display_name\"::text) = ($1::jsonb ->> 'display_name')"));
    assert!(!statement.sql.contains("OR true"));
    let mut bad = query;
    bad.filter = Filter::Compare {
        column: "display_name".into(),
        op: Compare::LowerEq,
        value: json!(42),
    };
    assert!(compile("app.person_context_people", &bad).is_err());
}

#[test]
fn recent_people_links_keep_legacy_nulls_first_without_changing_the_default() {
    let query = Query {
        order: vec![Order {
            column: "occurred_at".into(),
            descending: true,
        }],
        ..Query::default()
    };
    assert!(
        compile_with_nulls_first("app.person_context_links", &query, &["occurred_at".into()])
            .unwrap()
            .sql
            .contains("DESC NULLS FIRST")
    );
    let old: Query = serde_json::from_value(
        json!({"kind":"select","order":[{"column":"occurred_at","descending":true}]}),
    )
    .unwrap();
    assert!(compile("app.person_context_links", &old)
        .unwrap()
        .sql
        .contains("DESC NULLS LAST"));
}
