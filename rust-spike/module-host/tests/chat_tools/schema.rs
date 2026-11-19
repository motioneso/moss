use super::{fixture::*, params};
use serde_json::{json, Value};
#[test]
fn install_refuses_unsupported_schemas_missing_descriptions_and_missing_card_apis() {
    let bad = [
        json!(true),
        json!({"type":"string"}),
        json!({"type":"object","properties":{},"$ref":"https://example.test/schema"}),
        json!({"type":"object","properties":{"x":{"type":"string"}}}),
        json!({"type":"object","properties":{},"required":["x"]}),
        json!({"type":"object","properties":{},"required":[5]}),
        json!({"type":"object","properties":{},"additionalProperties":true}),
        json!({"type":"object","properties":{"x":{"type":"array","description":"Items"}}}),
        json!({"type":"object","properties":{"x":{"type":"integer","description":"Count","minimum":5,"maximum":3}}}),
        json!({"type":"object","properties":{},"examples":[{"unknown":3}]}),
    ];
    for schema in bad {
        let mut m = manifest();
        m.tools.get_mut("sample.read").unwrap().input_schema = Some(schema.clone());
        assert!(m.validate(&"0.1.0".parse().unwrap()).is_err(), "{schema}");
        let bytes = moss_module_host::archive::pack(&crate::common::files(&m)).unwrap();
        assert!(moss_module_host::archive::Package::read(
            &bytes,
            &moss_module_host::trust::digest(&bytes),
            &"0.1.0".parse().unwrap()
        )
        .is_err());
    }
    let mut m = manifest();
    m.tools.get_mut("sample.read").unwrap().card = Some("missing".into());
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
    let mut m = manifest();
    m.tools
        .get_mut("sample.write")
        .unwrap()
        .input_schema
        .as_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("examples");
    assert!(m.validate(&"0.1.0".parse().unwrap()).is_err());
}
#[test]
fn nested_types_enum_required_and_bounds_are_checked_at_chat_boundary() {
    let mut m = manifest();
    m.tools.get_mut("sample.read").unwrap().input_schema = Some(json!({
        "type":"object","properties":{
            "nested":{"type":"object","description":"Nested","properties":{"flag":{"type":"boolean","description":"Enabled"}},"required":["flag"]},
            "items":{"type":"array","description":"Tags","items":{"type":"string","enum":["a","é"]},"maxItems":2},
            "count":{"type":"integer","description":"Count","minimum":1,"maximum":3},
            "ratio":{"type":"number","description":"Ratio","minimum":0,"maximum":1},
            "text":{"type":"string","description":"Text","maxLength":1}
        },"required":["nested","items","count","ratio","text"]}));
    let f = Fixture::new(m, card(), None);
    let valid = json!({"nested":{"flag":false},"items":["a","é"],"count":2,"ratio":0.5,"text":"é"});
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.read", valid.clone())
        .is_ok());
    for (key, value) in [
        ("nested", json!({})),
        ("nested", json!({"flag":"false"})),
        ("nested", json!({"flag":true,"extra":1})),
        ("items", json!(["a", "a", "a"])),
        ("items", json!(["b"])),
        ("count", json!(1.5)),
        ("count", json!(4)),
        ("ratio", json!(-0.1)),
        ("text", json!("ab")),
    ] {
        let mut p = valid.clone();
        p[key] = value;
        assert!(
            f.host
                .run_chat_tool(&f.a, MODULE, "sample.read", p)
                .is_err(),
            "{key}"
        );
    }
    assert!(f
        .host
        .run_chat_tool(&f.a, MODULE, "sample.read", params())
        .is_err());
    let _: Value = valid;
}

#[test]
fn integer_bounds_do_not_round_large_values_into_range() {
    let mut m = manifest();
    m.tools.get_mut("sample.read").unwrap().input_schema = Some(
        json!({"type":"object","properties":{"count":{"type":"integer","description":"Count","maximum":9007199254740992_u64}},"required":["count"]}),
    );
    let f = Fixture::new(m, card(), None);
    assert!(f
        .host
        .run_chat_tool(
            &f.a,
            MODULE,
            "sample.read",
            json!({"count":9007199254740992_u64})
        )
        .is_ok());
    assert!(f
        .host
        .run_chat_tool(
            &f.a,
            MODULE,
            "sample.read",
            json!({"count":9007199254740993_u64})
        )
        .is_err());
}
