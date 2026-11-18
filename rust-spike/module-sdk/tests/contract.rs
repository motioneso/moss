use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};
use std::cell::RefCell;

struct Recording(RefCell<Vec<Value>>);
impl Host for Recording {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        self.0
            .borrow_mut()
            .push(json!([port, operation, resource, parameters]));
        Ok(json!([{"task_id":"one","tag_id":"two"}]))
    }
}
#[test]
fn composite_key_delete_reaches_the_host_as_a_typed_query() {
    let host = Recording(RefCell::default());
    let query = Query::delete(Filter::And {
        filters: vec![Filter::eq("task_id", "one"), Filter::eq("tag_id", "two")],
    });
    let rows = Client(&host)
        .query("app.task_tag_assignments", &query)
        .unwrap();
    assert_eq!(rows, vec![json!({"task_id":"one","tag_id":"two"})]);
    let calls = host.0.borrow();
    assert_eq!(calls[0][0], "db");
    assert_eq!(calls[0][1], "query");
    assert_eq!(calls[0][2], "app.task_tag_assignments");
    assert_eq!(calls[0][3], serde_json::to_value(query).unwrap());
}
#[test]
fn a_page_render_reaches_the_host_as_a_browser_call_on_the_public_web() {
    let host = Recording(RefCell::default());
    Client(&host)
        .render_page("https://example.test/news", &["example.test"])
        .unwrap();
    let calls = host.0.borrow();
    assert_eq!(calls[0][0], "browser");
    assert_eq!(calls[0][1], "render");
    assert_eq!(calls[0][2], "public-web");
    assert_eq!(
        calls[0][3],
        json!({"url":"https://example.test/news","allowedHosts":["example.test"]})
    );
}
#[test]
fn public_api_arguments_cannot_choose_a_provider_handler() {
    let host = Recording(RefCell::default());
    Client(&host)
        .api(
            "people",
            "resolve",
            json!({"kind":"route","path":"/private"}),
        )
        .unwrap();
    assert_eq!(
        host.0.borrow()[0],
        json!(["api","call","people",{
            "name":"resolve","parameters":{"kind":"route","path":"/private"}
        }])
    );
}
