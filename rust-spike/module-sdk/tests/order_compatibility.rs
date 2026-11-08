use moss_module_sdk::{
    query::{Order, Query},
    Client, Host, Result,
};
use serde_json::json;

#[test]
fn legacy_order_literals_remain_source_and_wire_compatible() {
    // Calendar and other already-merged guests construct this public type directly.
    let order = Order {
        column: "starts_at".into(),
        descending: false,
    };
    assert_eq!(
        serde_json::to_value(order).unwrap(),
        json!({"column":"starts_at","descending":false})
    );
}

struct Echo;
impl Host for Echo {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: serde_json::Value,
    ) -> Result<serde_json::Value> {
        assert_eq!((port, operation, resource), ("db", "query", "app.example"));
        Ok(json!([parameters]))
    }
}

#[test]
fn nullable_ordering_is_an_explicit_query_extension() {
    let mut query = Query::default();
    query.order.push(Order {
        column: "created_at".into(),
        descending: true,
    });
    let client = Client(&Echo);
    let legacy = client.query("app.example", &query).unwrap();
    assert!(legacy[0].get("nullsFirst").is_none());
    assert_eq!(
        client
            .query_with_nulls_first("app.example", &query, &[])
            .unwrap(),
        legacy
    );
    let extended = client
        .query_with_nulls_first("app.example", &query, &["created_at"])
        .unwrap();
    assert_eq!(extended[0]["nullsFirst"], json!(["created_at"]));
    assert_eq!(extended[0]["order"], legacy[0]["order"]);
}
