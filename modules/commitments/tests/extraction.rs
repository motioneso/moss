mod common;
use common::{A, B, Fake};
use serde_json::{Value, json};

const CAND: &str = "app.commitment_candidates";
const MSG: &str = "00000000-0000-4000-8000-0000000000f1";

fn fake() -> Fake {
    let f = Fake::new();
    f.clock.set(1_794_312_000_000); // 2026-11-10T12:00:00Z
    f
}

fn notes(f: &Fake, text: &str) {
    f.api_says(
        "notes.listCommitmentText",
        json!({"boundaries":[{"text":text,"occurredAt":"2026-11-09T09:00:00.000Z","sourceRef":"note-1","sourceVersion":3}]}),
    );
}

const PROMISE: &str = r#"{"candidates":[{"kind":"promise","title":"Send Sarah the budget","dueLocalDate":"2026-11-14","counterpartyLabel":"Sarah","evidenceExcerpt":"I will send Sarah the budget by Friday","confidence":"high"}]}"#;

#[test]
fn a_canned_model_answer_becomes_a_pending_suggestion_with_evidence() {
    let f = fake();
    notes(&f, "I will send Sarah the budget by Friday");
    f.model_says(PROMISE);
    f.job("commitments-extraction", json!({"source-kind":"notes"}))
        .unwrap();
    let rows = f.rows(CAND);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["status"], "pending_review");
    assert_eq!(rows[0]["title"], "Send Sarah the budget");
    let evidence = f.rows("app.commitment_candidate_sources");
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0]["source_version"], 3);
    let state = f.route("GET", "/extraction-state", &[], json!(null));
    assert_eq!(state.1[0]["sourceKind"], "notes");
    assert_eq!(f.model_calls(), 1);
    // The same note again folds into the same suggestion.
    notes(&f, "I will send Sarah the budget by Friday");
    f.model_says(PROMISE);
    f.job("commitments-extraction", json!({"source-kind":"notes"}))
        .unwrap();
    assert_eq!(f.rows(CAND).len(), 1);
}

#[test]
fn text_without_a_promise_phrase_never_reaches_the_model() {
    let f = fake();
    notes(&f, "The weather is mild today");
    f.job("commitments-extraction", json!({"source-kind":"notes"}))
        .unwrap();
    assert_eq!(f.model_calls(), 0);
    assert!(f.rows(CAND).is_empty());
}

#[test]
fn a_bad_model_answer_saves_nothing_and_the_warning_carries_no_text() {
    let f = fake();
    notes(&f, "I will send Sarah the budget by Friday");
    f.model_says("sorry, no json here");
    let out = f
        .job("commitments-extraction", json!({"source-kind":"notes"}))
        .unwrap();
    assert!(f.rows(CAND).is_empty());
    assert!(out.contains("commitment-extraction-malformed-output"));
    assert!(!out.contains("Sarah") && !out.contains("budget"));
}

#[test]
fn a_source_with_no_provider_warns_and_returns() {
    let f = fake();
    let out = f
        .job("commitments-extraction", json!({"source-kind":"chat"}))
        .unwrap();
    assert!(out.contains("commitment-extraction-source-provider-missing"));
    assert_eq!(f.model_calls(), 0);
    assert!(f.rows("app.commitment_extraction_state").is_empty());
}

#[test]
fn the_extract_route_queues_a_job_with_the_source_kind_only() {
    let f = fake();
    let (status, body) = f.route(
        "POST",
        "/extract",
        &[],
        json!({"sourceKind":"notes","text":"I will pay the bill"}),
    );
    assert_eq!((status, body), (202, json!({"queued":true})));
    let asked = f.jobs_asked();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].0, "commitments-extraction");
    assert_eq!(asked[0].1["params"], json!({"source-kind":"notes"}));
    assert!(!asked[0].1.to_string().contains("pay the bill"));
    let (status, body) = f.route("POST", "/extract", &[], json!({"sourceKind":"mail"}));
    assert_eq!(status, 400);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .ends_with("body/sourceKind must match a schema in anyOf")
    );
}

fn thread(f: &Fake, newest_from_user: bool, newest_id: &str) {
    f.api_says(
        "email.replyContext",
        json!({"threadId":"th-1","accountId":"acc","externalId":"e1"}),
    );
    f.api_says(
        "email.emailTriageContext",
        json!({"today":"2026-11-10","ownAddresses":["me@example.test"]}),
    );
    f.api_says("email.listThreadMessages", json!({"messages":[
        {"externalId":"e1","fromIsUser":true,"fromAddress":"me@example.test","subject":"Budget","receivedAt":"2026-11-09T08:00:00.000Z","bodyExcerpt":"Hello"},
        {"externalId":newest_id,"fromIsUser":newest_from_user,"fromAddress":"sarah@example.test","subject":"Re: Budget","receivedAt":"2026-11-09T09:00:00.000Z","bodyExcerpt":"Please send it by Friday. SECRET-BODY"}]}));
    f.api_says("people.resolve", json!({"person":null}));
    f.api_says("tasks.listBriefingTasks", json!({"items":[]}));
}

const OWED: &str = r#"{"owed":true,"title":"Send Sarah the budget","counterpartyLabel":"Sarah","counterpartyAddress":"sarah@example.test","dueLocalDate":"2026-11-14","confidence":"high","why":["She asked for it by Friday."],"actions":[{"kind":"task","title":"Send budget","dueLocalDate":"2026-11-14"},{"kind":"dismiss"}]}"#;

#[test]
fn a_thread_the_owner_must_answer_becomes_a_pending_suggestion_once() {
    let f = fake();
    thread(&f, false, "e2");
    f.model_says(OWED);
    f.job("commitments-email-judgement", json!({"message-id":MSG}))
        .unwrap();
    let rows = f.rows(CAND);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["status"], "pending_review");
    assert_eq!(rows[0]["suggested_handling"], "create_task");
    assert_eq!(rows[0]["thread_ref"], "th-1");
    // Nothing reached a task list.
    assert!(
        f.calls
            .borrow()
            .iter()
            .all(|(p, _, r, v)| !(p == "api" && r == "tasks" && v["name"] != "listBriefingTasks"))
    );
    // The newest message did not change, so the model is not asked again.
    f.job("commitments-email-judgement", json!({"message-id":MSG}))
        .unwrap();
    assert_eq!(f.model_calls(), 1);
}

#[test]
fn a_rejected_suggestion_stays_rejected_when_the_thread_is_judged_again() {
    let f = fake();
    thread(&f, false, "e2");
    f.model_says(OWED);
    f.job("commitments-email-judgement", json!({"message-id":MSG}))
        .unwrap();
    let id = f.rows(CAND)[0]["id"].as_str().unwrap().to_owned();
    for row in f.tables.borrow_mut().get_mut(CAND).unwrap() {
        row["status"] = json!("rejected");
    }
    thread(&f, false, "e3");
    f.model_says(OWED);
    f.job("commitments-email-judgement", json!({"message-id":MSG}))
        .unwrap();
    let rows = f.rows(CAND);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], id.as_str());
    assert_eq!(rows[0]["status"], "rejected");
}

#[test]
fn when_the_owner_replied_last_no_model_call_is_made() {
    let f = fake();
    thread(&f, true, "e2");
    f.job("commitments-email-judgement", json!({"message-id":MSG}))
        .unwrap();
    assert_eq!(f.model_calls(), 0);
    assert!(f.rows(CAND).is_empty());
    assert_eq!(
        f.rows("app.commitment_email_thread_judgements")[0]["outcome"],
        "no_item"
    );
}

#[test]
fn an_unreadable_judgement_records_nothing_owed() {
    let f = fake();
    thread(&f, false, "e2");
    f.model_says("not json");
    let out = f
        .job("commitments-email-judgement", json!({"message-id":MSG}))
        .unwrap();
    assert!(f.rows(CAND).is_empty());
    assert!(!out.contains("SECRET-BODY"));
    assert_eq!(
        f.rows("app.commitment_email_thread_judgements")[0]["outcome"],
        "no_item"
    );
}

#[test]
fn asking_for_a_judgement_queues_an_id_only_job_after_a_wait() {
    let f = fake();
    thread(&f, false, "e2");
    let out = f
        .api("requestThreadJudgement", json!({"cacheMessageId":MSG}))
        .unwrap();
    assert_eq!(out, json!({"queued":true}));
    let asked = f.jobs_asked();
    assert_eq!(asked[0].1["params"], json!({"message-id":MSG}));
    assert_eq!(asked[0].1["availableAt"], "2026-11-10T12:03:00.000Z");
    assert!(!asked[0].1.to_string().contains("SECRET-BODY"));
}

fn accepted(f: &Fake, owner: &str, title: &str, due: &str, resolution: Value) -> String {
    f.seed(CAND, owner, json!({
        "candidate_signature": format!("s-{title}"), "kind": "promise", "title": title, "due_local_date": due,
        "counterparty_label": "Sarah", "status": "accepted", "confidence": "high", "suggested_handling": null,
        "resolution_ref": resolution, "suppressed_by": null, "source_count": 1,
        "first_seen_at": "2026-11-09T10:00:00.000Z", "last_seen_at": "2026-11-09T10:00:00.000Z",
        "snoozed_until": null, "expires_at": null, "updated_at": "2026-11-09T10:00:00.000Z",
        "proposed_actions": [], "why_lines": [], "thread_ref": null, "stale": false }))
}

#[test]
fn the_heartbeat_lists_accepted_open_commitments_in_the_window() {
    let f = fake();
    let due = accepted(&f, A, "Send budget", "2026-11-11", Value::Null);
    accepted(&f, A, "Too old", "2026-11-01", Value::Null);
    accepted(&f, A, "Done already", "2026-11-11", json!("task:1"));
    accepted(&f, A, "Far away", "2026-12-30", Value::Null);
    accepted(&f, B, "Not mine", "2026-11-11", Value::Null);
    let out = f
        .tool("commitments.heartbeatOpen", json!({}), None)
        .unwrap();
    let items = out["data"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["entityKey"], format!("commitment:{due}"));
    assert_eq!(items[0]["kind"], "commitment_due");
    assert_eq!(items[0]["facts"]["overdue"], false);
    assert_eq!(out["data"]["source"], "memory");
    assert_eq!(out["data"]["nextBoundaryAt"], "2026-11-11T00:00:00.000Z");
    assert!(out["data"]["revision"].as_str().unwrap().starts_with("1-"));
    assert!(
        f.tool("commitments.heartbeatOpen", json!({"limit":99}), None)
            .is_err()
    );
    assert!(
        f.tool("commitments.heartbeatOpen", json!({"owner":"x"}), None)
            .is_err()
    );
}

#[test]
fn the_heartbeat_marks_overdue_and_truncates() {
    let f = fake();
    for i in 0..3 {
        accepted(&f, A, &format!("Late {i}"), "2026-11-08", Value::Null);
    }
    let out = f
        .tool("commitments.heartbeatOpen", json!({"limit":2}), None)
        .unwrap();
    assert_eq!(out["data"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(out["data"]["truncated"], true);
    assert_eq!(out["data"]["items"][0]["facts"]["overdue"], true);
}

#[test]
fn review_tools_need_a_current_approval_and_change_only_the_owners_rows() {
    let f = fake();
    let id = accepted(&f, A, "Send budget", "2026-11-11", Value::Null);
    for row in f.tables.borrow_mut().get_mut(CAND).unwrap() {
        row["status"] = json!("pending_review");
    }
    let listed = f.tool("commitments.list", json!({}), None).unwrap();
    assert_eq!(listed["data"]["items"][0]["id"], id.as_str());
    assert!(
        f.tool("commitments.list", json!({"status":"bogus"}), None)
            .is_err()
    );

    assert!(
        f.tool("commitments.accept", json!({"candidateId":id}), None)
            .is_err()
    );
    assert!(
        f.tool("commitments.accept", json!({"candidateId":id}), Some("[]"))
            .is_err()
    );
    assert_eq!(f.rows(CAND)[0]["status"], "pending_review");

    let card = f
        .api(
            "prepareCommitmentAction",
            json!({"candidateId":id,"action":"accept"}),
        )
        .unwrap();
    assert_eq!(card["target"], "Send budget");
    let version = card["version"].as_str().unwrap().to_owned();
    // Another person cannot use that card.
    f.as_actor(B);
    assert!(
        f.tool(
            "commitments.accept",
            json!({"candidateId":id}),
            Some(&version)
        )
        .is_err()
    );
    assert_eq!(
        f.tool("commitments.list", json!({}), None).unwrap()["data"]["items"],
        json!([])
    );
    assert_eq!(
        f.tool("commitments.get", json!({"candidateId":id}), None)
            .unwrap()["data"]["error"],
        "Not found"
    );
    f.as_actor(A);
    let done = f
        .tool(
            "commitments.accept",
            json!({"candidateId":id}),
            Some(&version),
        )
        .unwrap();
    assert_eq!(done["data"], json!({"id":id,"status":"accepted"}));
    // The old card is stale now.
    assert!(
        f.tool(
            "commitments.reject",
            json!({"candidateId":id}),
            Some(&version)
        )
        .is_err()
    );
}

#[test]
fn snooze_needs_a_date_and_get_shows_evidence_without_the_resolution_ref() {
    let f = fake();
    let id = accepted(&f, A, "Send budget", "2026-11-11", json!("task:9"));
    f.seed(
        "app.commitment_candidate_sources",
        A,
        json!({"candidate_id":id,"source_kind":"notes","source_ref":"n1",
        "source_version":0,"evidence_excerpt":"I will","occurred_at":null}),
    );
    let got = f
        .tool("commitments.get", json!({"candidateId":id}), None)
        .unwrap();
    assert_eq!(got["data"]["hasResolutionRef"], true);
    assert_eq!(got["data"]["evidence"][0]["evidenceExcerpt"], "I will");
    assert!(!got.to_string().contains("task:9"));
    let version = f
        .api(
            "prepareCommitmentAction",
            json!({"candidateId":id,"action":"snooze","snoozedUntil":"2026-12-01T00:00:00.000Z"}),
        )
        .unwrap()["version"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        f.tool(
            "commitments.snooze",
            json!({"candidateId":id}),
            Some(&version)
        )
        .is_err()
    );
    let done = f
        .tool(
            "commitments.snooze",
            json!({"candidateId":id,"snoozedUntil":"2026-12-01T00:00:00.000Z"}),
            Some(&version),
        )
        .unwrap();
    assert_eq!(done["data"]["snoozedUntil"], "2026-12-01T00:00:00.000Z");
}

#[test]
fn thread_judgements_report_outcomes_for_the_owner_only() {
    let f = fake();
    f.seed("app.commitment_email_thread_judgements", A, json!({"thread_ref":"t1","last_judged_external_id":"e","outcome":"item","judged_at":"2026-11-09T10:00:00.000Z"}));
    f.seed("app.commitment_email_thread_judgements", B, json!({"thread_ref":"t2","last_judged_external_id":"e","outcome":"item","judged_at":"2026-11-09T10:00:00.000Z"}));
    let out = f
        .tool(
            "commitments.threadJudgements",
            json!({"threadRefs":["t1","t2"]}),
            None,
        )
        .unwrap();
    assert_eq!(
        out["data"]["threads"],
        json!([{"threadRef":"t1","judgedAt":"2026-11-09T10:00:00.000Z","outcome":"item"}])
    );
}

#[test]
fn asking_again_after_the_window_queues_a_new_job() {
    let f = fake();
    for _ in 0..2 {
        assert_eq!(
            f.route("POST", "/extract", &[], json!({"sourceKind":"notes"}))
                .0,
            202
        );
    }
    f.clock.set(1_794_312_000_000 + 181_000);
    assert_eq!(
        f.route("POST", "/extract", &[], json!({"sourceKind":"notes"}))
            .0,
        202
    );
    let keys: Vec<String> = f
        .jobs_asked()
        .iter()
        .map(|j| j.1["idempotencyKey"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(keys.len(), 3);
    assert_eq!(
        keys[0], keys[1],
        "inside one window the request folds into one"
    );
    assert_ne!(keys[1], keys[2], "the next window can queue again");
}

#[test]
fn the_chat_list_counts_a_finished_snooze_as_pending_review() {
    let f = fake();
    let id = accepted(&f, A, "Send budget", "2026-11-11", Value::Null);
    for row in f.tables.borrow_mut().get_mut(CAND).unwrap() {
        row["status"] = json!("snoozed");
        row["snoozed_until"] = json!("2026-11-09T00:00:00.000Z");
    }
    let listed = f.tool("commitments.list", json!({}), None).unwrap();
    assert_eq!(listed["data"]["items"][0]["id"], id.as_str());
    let snoozed = f
        .tool("commitments.list", json!({"status":"snoozed"}), None)
        .unwrap();
    assert_eq!(snoozed["data"]["items"], json!([]));
}

#[test]
fn chat_card_adapts_the_common_envelope_to_the_saved_suggestion() {
    let f = fake();
    let id = f.seed(CAND, A, json!({"title":"Saved suggestion","status":"pending_review","updated_at":"2026-11-10T12:00:00.000Z"}));
    for (tool, label) in [
        ("accept", "Accept suggestion"),
        ("reject", "Reject suggestion"),
        ("snooze", "Snooze suggestion"),
    ] {
        let card = f.api("prepareChatAction", json!({"tool":format!("commitments.{tool}"),"parameters":{"candidateId":id,"snoozedUntil":"2026-12-01T09:00:00.000Z"}})).unwrap();
        assert_eq!(card["target"], "Saved suggestion");
        assert_eq!(card["fields"][0], json!({"label":"Action","value":label}));
        assert!(card["version"].as_str().unwrap().contains(&id));
    }
    assert!(
        f.api(
            "prepareChatAction",
            json!({"tool":"commitments.get","parameters":{"candidateId":id}})
        )
        .is_err()
    );
}
