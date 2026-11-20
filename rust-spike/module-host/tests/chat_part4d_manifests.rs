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
    // Reviewed non-sending paths in this slice. New declarations must be audited here,
    // even if they describe themselves as reads. Drafts stay in the owner's mailbox;
    // Calendar create has no attendee input, and rescheduling rejects attendee events.
    let non_sending = [
        "calendar.createEvent",
        "calendar.dayPlanDraft",
        "calendar.heartbeatWindow",
        "calendar.listLiveEvents",
        "calendar.listVisibleEvents",
        "calendar.rescheduleEvent",
        "connectors.startGoogleGuidance",
        "email.draftReply",
        "email.listVisibleMessages",
        "gmail.getLiveMessage",
        "gmail.searchLive",
        "meals.day.edit",
        "meals.favourites.edit",
        "meals.household.save",
        "meals.kitchen.get",
        "meals.kitchen.save",
        "meals.list.bought",
        "meals.list.build",
        "meals.list.edit",
        "meals.list.get",
        "meals.log.add",
        "meals.log.correct",
        "meals.log.list",
        "meals.log.reestimate",
        "meals.log.summarize",
        "meals.meal.cooked",
        "meals.meal.edit",
        "meals.meal.get",
        "meals.meal.rate",
        "meals.meal.servings",
        "meals.meal.swap",
        "meals.pantry.edit",
        "meals.pantry.get",
        "meals.plan.control",
        "meals.plan.create",
        "meals.plan.current",
        "meals.plan.get",
        "meals.undo",
        "web.read",
        "web.search",
    ];
    let mut sending = 0;
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path().join("moss.module.json");
        if !path.is_file() {
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let module = value["id"].as_str().unwrap();
        let Some(tools) = value["tools"].as_object() else {
            continue;
        };
        for (name, declaration) in tools {
            let verb = name.rsplit('.').next().unwrap().to_ascii_lowercase();
            let sends = ["send", "publish", "invite", "forward"]
                .iter()
                .any(|v| verb.starts_with(v));
            let external_delete = name == "calendar.deleteEvent";
            let risk = declaration["risk"].as_str().unwrap();
            if ["meals", "calendar", "connectors", "web"].contains(&module) && risk != "destructive"
            {
                assert!(
                    non_sending.contains(&name.as_str()),
                    "Audit the new tool's provider effects: {name}"
                );
            }
            if !sends && !external_delete {
                continue;
            }
            sending += 1;
            assert_eq!(risk, "destructive", "{name}");
            let tool: moss_module_host::manifest::Tool =
                serde_json::from_value(declaration.clone()).unwrap();
            for policy in [None, Some(false), Some(true)] {
                assert!(
                    matches!(chat_tool_rule(&tool, policy), ChatToolRule::Card { .. }),
                    "{name}"
                );
            }
        }
    }
    assert!(
        sending >= 2,
        "The known email send and external calendar delete must be audited"
    );
}
