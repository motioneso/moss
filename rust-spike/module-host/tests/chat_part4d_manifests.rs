//! Part 4d's real manifests pass the install-time schema and example validator.
use moss_module_host::{
    chat_tools::{chat_tool_rule, ChatToolRule},
    manifest::Manifest,
};
use std::path::Path;

#[test]
fn all_part4d_tools_have_install_validated_schemas_examples_and_cards() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut count = 0;
    for module in ["meals", "calendar", "connectors", "web-research"] {
        let text = std::fs::read_to_string(root.join(format!("modules/{module}/moss.module.json")))
            .unwrap();
        let manifest: Manifest = serde_json::from_str(&text).unwrap();
        manifest.validate(&"0.1.0".parse().unwrap()).unwrap();
        for (name, tool) in &manifest.tools {
            let schema = tool
                .input_schema
                .as_ref()
                .unwrap_or_else(|| panic!("{name} has no schema"));
            if tool.risk != "read" {
                assert!(
                    schema["examples"].as_array().is_some_and(|x| !x.is_empty()),
                    "{name}"
                );
                assert_eq!(tool.card.as_deref(), Some("prepareChatAction"), "{name}");
            }
            count += 1;
        }
    }
    assert_eq!(count, 46);
}

#[test]
fn sending_tools_always_declare_destructive_and_require_a_card() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../modules");
    // Send-path audit: email.sendReply reaches Gmail/SMTP send. Calendar deletion also
    // changes the external calendar; create has no attendee input and moving guests is refused.
    for (module, name) in [
        ("connectors", "email.sendReply"),
        ("calendar", "calendar.deleteEvent"),
    ] {
        let text = std::fs::read_to_string(root.join(module).join("moss.module.json")).unwrap();
        let manifest: Manifest = serde_json::from_str(&text).unwrap();
        let tool = &manifest.tools[name];
        assert_eq!(tool.risk, "destructive", "{name}");
        for policy in [None, Some(false), Some(true)] {
            assert!(
                matches!(chat_tool_rule(tool, policy), ChatToolRule::Card { .. }),
                "{name}"
            );
        }
    }
}
