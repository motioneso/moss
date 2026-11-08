use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

struct NoData;
impl Host for NoData {
    fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
        panic!("An empty name request needs no private data");
    }
}

#[test]
fn public_name_lookup_caps_raw_names_before_discarding_empty_names() {
    let mut names = vec![" \u{feff}"; 30];
    names.push("Alice");
    let payload = json!({"name":"findPeopleByNames","parameters":{"names":names}});
    assert_eq!(
        moss_people::guest::handle(&NoData, "api", &payload.to_string()).unwrap(),
        "[]"
    );
}
