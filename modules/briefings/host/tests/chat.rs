//! Common-envelope cards and their shown versions through the installed package.
use super::*;

#[test]
#[ignore = "Only through verify-gate"]
fn chat_rerun_uses_the_shown_definition_version() {
    let w = World::new("UTC");
    let access = w.f.access(w.f.a);
    let id = make_definition(&w, w.f.a, "manual");
    let parameters = json!({"definitionId":id});
    let installer = &w.app.installer;
    assert_eq!(installer.chat_tools(&access).unwrap().len(), 2);
    let shown = installer.chat_tool_card(&access, "briefings", "briefings.rerun", &parameters).unwrap().unwrap();
    assert_eq!(shown.title, "Action request");
    assert_eq!(shown.version.as_ref().unwrap().len(), 64);
    w.f.rt.block_on(w.f.root.execute(
        "UPDATE app.briefing_definitions SET updated_at=updated_at+interval '1 second' WHERE id::text=$1", &[&id],
    )).unwrap();
    let stale = installer.run_approved_chat_tool(&access, "briefings", "briefings.rerun", parameters.clone(), shown.version.as_deref()).unwrap();
    assert_eq!(stale["data"]["error"], "Briefing changed since approval. Prepare the action again.");
    let fresh = installer.chat_tool_card(&access, "briefings", "briefings.rerun", &parameters).unwrap().unwrap();
    assert_ne!(fresh.version, shown.version);
    let queued = installer.run_approved_chat_tool(&access, "briefings", "briefings.rerun", parameters, fresh.version.as_deref()).unwrap();
    assert_eq!(queued["data"]["status"], "queued", "{queued}");
    let status = installer.run_chat_tool(&access, "briefings", "briefings.getRunStatus", json!({"runId":queued["data"]["runId"],"jobId":queued["data"]["jobId"]})).unwrap();
    assert_eq!(status["data"]["state"], "pending");
}
