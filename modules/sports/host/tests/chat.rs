//! Chat entry points against the installed Sports component.
use super::*;

#[test]
#[ignore = "Only through verify-gate"]
fn chat_follows_show_done_and_the_optional_policy_has_a_card() {
    let w = World::new();
    let access = w.f.access(w.f.a);
    let installer = &w.app.installer;
    assert_eq!(installer.chat_tools(&access).unwrap().len(), 14);
    let source = w.plant_source(w.f.a, "read.example.com", "Chat source read");
    let listed = installer.run_chat_tool(&access, "sports", "sports.listSources", json!({})).unwrap();
    assert!(listed["data"]["sources"].as_array().unwrap().iter().any(|row| row["id"] == source.to_string()), "{listed}");
    let parameters = json!({"competitionKey":"nfl"});
    let done = installer.run_chat_tool(&access, "sports", "sports.followTeam", parameters.clone()).unwrap();
    assert_eq!(done["data"]["changed"][2], json!({"label":"Following","before":"Not followed","after":"Following"}));
    w.app.services.set_action_policy(&access, "sports", &[("sports.unfollowTeam".into(), true)].into()).unwrap();
    let card = installer.chat_tool_card(&access, "sports", "sports.unfollowTeam", &parameters).unwrap().unwrap();
    assert_eq!(card.title, "Action request");
    assert!(card.version.is_none());
    assert_eq!(card.fields.iter().find(|f| f.label == "Action").unwrap().value, "Unfollow");
    let done = installer.run_approved_chat_tool(&access, "sports", "sports.unfollowTeam", parameters, None).unwrap();
    assert_eq!(done["data"]["changed"][2]["after"], "Not followed");
}

#[test]
#[ignore = "Only through verify-gate"]
fn chat_source_card_passes_the_shown_compact_version_to_the_installed_tool() {
    let w = World::new();
    let access = w.f.access(w.f.a);
    let id = w.plant_source(w.f.a, "news.example.com", "A saved sports source");
    let parameters = json!({"sourceId":id});
    let installer = &w.app.installer;
    let card = installer.chat_tool_card(&access, "sports", "sports.removeSource", &parameters).unwrap().unwrap();
    assert_eq!(card.title, "Action request");
    assert_eq!(card.version.as_ref().unwrap().len(), 64);
    assert!(card.danger);
    w.f.rt.block_on(w.f.root.execute(
        "UPDATE app.sports_custom_sources SET label='Updated source', updated_at=updated_at+interval '1 second' WHERE id=$1", &[&id],
    )).unwrap();
    let stale = installer.run_approved_chat_tool(&access, "sports", "sports.removeSource", parameters.clone(), card.version.as_deref()).unwrap();
    assert!(stale["data"]["error"].as_str().unwrap().contains("approval no longer matches"));
    assert_eq!(w.source_rows(&id.to_string()), 1);
    let fresh = installer.chat_tool_card(&access, "sports", "sports.removeSource", &parameters).unwrap().unwrap();
    assert_ne!(fresh.version, card.version);
    let done = installer.run_approved_chat_tool(&access, "sports", "sports.removeSource", parameters, fresh.version.as_deref()).unwrap();
    assert_eq!(done["data"]["removed"], true);
    assert_eq!(w.source_rows(&id.to_string()), 0);
}
