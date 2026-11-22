use moss_calendar_ui::review_model::*;
use serde_json::{json, Value};
fn plan() -> Value {
    json!({"id":"plan","revision":2,"localDay":"2030-05-26","timeZone":"UTC","blocks":[
        {"id":"a","kind":"focus","taskId":"task-a","title":"A","actualPlacement":null,"pendingChange":{"kind":"add","startsAt":"2030-05-26T10:00:00Z","durationMinutes":30}},
        {"id":"b","kind":"focus","taskId":"task-b","title":"B","actualPlacement":{"startsAt":"2030-05-26T12:00:00Z","durationMinutes":45},"pendingChange":null},
        {"id":"c","kind":"break","taskId":null,"title":"Break","actualPlacement":null,"pendingChange":{"kind":"add","startsAt":"2030-05-26T13:00:00Z","durationMinutes":15}}
    ]})
}
#[test]
fn untouched_rows_save_without_becoming_selected_and_accept_only_task_additions() {
    let p = plan();
    let c = Choices::new();
    assert!(selection(&p, &c, false).is_empty());
    assert_eq!(selection(&p, &c, true), ["a"]);
    assert_eq!(draft(&p, &c)["blocks"].as_array().unwrap().len(), 3);
    assert_eq!(
        draft(&p, &c)["blocks"][0]["pendingChange"],
        p["blocks"][0]["pendingChange"]
    );
    assert_eq!(choice(&p["blocks"][1], &c).placement, "keep");
}
#[test]
fn retiming_preserves_duration_and_move_remove_require_review() {
    let p = plan();
    let mut c = Choices::new();
    c.insert(
        "b".into(),
        Choice {
            placement: "move".into(),
            starts_at: Some("2030-05-26T14:00:00Z".into()),
        },
    );
    assert_eq!(
        draft(&p, &c)["blocks"][1]["pendingChange"],
        json!({"kind":"move","startsAt":"2030-05-26T14:00:00Z","durationMinutes":45})
    );
    assert_eq!(selection(&p, &c, false), ["b"]);
    assert!(other_edits(&p, &c));
    c.insert(
        "b".into(),
        Choice {
            placement: "remove".into(),
            starts_at: None,
        },
    );
    assert_eq!(pending(&p["blocks"][1], &c), json!({"kind":"remove"}));
    assert!(other_edits(&p, &c));
}
#[test]
fn leave_clears_proposal_without_deleting_task_or_placed_block() {
    let p = plan();
    let mut c = Choices::new();
    c.insert(
        "a".into(),
        Choice {
            placement: "leave".into(),
            starts_at: None,
        },
    );
    assert!(selection(&p, &c, true).is_empty());
    assert!(selection(&p, &c, false).is_empty());
    let rows = draft(&p, &c);
    assert_eq!(rows["blocks"][0]["taskId"], "task-a");
    assert!(rows["blocks"][0]["pendingChange"].is_null());
    assert_eq!(rows["blocks"][1]["id"], "b");
}
#[test]
fn saved_moves_disable_accept_all_even_untouched() {
    let mut p = plan();
    p["blocks"][1]["pendingChange"] = json!({"kind":"remove"});
    assert!(other_edits(&p, &Choices::new()));
}
#[test]
fn local_times_use_the_plan_zone_and_reject_nonexistent_wall_times() {
    let zone = chrono_tz::America::Los_Angeles;
    assert_eq!(
        instant("2030-05-26", "10:15", zone).as_deref(),
        Some("2030-05-26T17:15:00.000Z")
    );
    assert_eq!(local_time("2030-05-26T17:15:00.000Z", zone), "10:15");
    assert!(instant("2026-03-08", "02:30", zone).is_none());
    assert_eq!(
        instant("2026-11-01", "01:30", zone).as_deref(),
        Some("2026-11-01T08:30:00.000Z")
    );
}
#[test]
fn preview_conflicts_and_ineligible_rows_are_not_selected() {
    let preview = json!({"eligibleBlockIds":["a","b"],"conflicts":[{"blockId":"b"}]});
    assert_eq!(
        eligible(&preview, &["a".into(), "b".into(), "c".into()]),
        ["a"]
    );
}
#[test]
fn retry_only_failed_or_unknown_and_idempotency_keys_ignore_selection_order() {
    let report = json!({"items":[{"itemId":"a","outcome":"applied"},{"itemId":"b","outcome":"failed"},{"itemId":"c","outcome":"unknown"},{"itemId":"d","outcome":"pending"}]});
    assert_eq!(retry_ids(&report), ["b", "c"]);
    let p = plan();
    assert_eq!(
        key(&p, &["a".into(), "b".into()]),
        key(&p, &["b".into(), "a".into()])
    );
    let mut next = p.clone();
    next["revision"] = json!(3);
    assert_ne!(key(&p, &[]), key(&next, &[]));
    assert_eq!(
        report_text(&report),
        "Applied 1; 1 failed; 1 pending; 1 need checking"
    );
}

#[test]
fn refresh_after_partial_apply_reconciles_additions_with_recorded_placements() {
    let mut saved = plan();
    saved["blocks"][0]["actualPlacement"] =
        json!({"startsAt":"2030-05-26T10:30:00Z","durationMinutes":30});
    saved["blocks"][0]["pendingChange"] = Value::Null;
    let mut choices = Choices::new();
    choices.insert(
        "a".into(),
        Choice {
            placement: "add".into(),
            starts_at: Some("2030-05-26T10:30:00.000Z".into()),
        },
    );
    choices.insert(
        "b".into(),
        Choice {
            placement: "add".into(),
            starts_at: Some("2030-05-26T14:00:00Z".into()),
        },
    );
    choices.insert(
        "c".into(),
        Choice {
            placement: "leave".into(),
            starts_at: None,
        },
    );
    reconcile_choices(&saved, &mut choices);
    assert!(
        !choices.contains_key("a"),
        "an already applied choice must not become another addition"
    );
    assert_eq!(
        choices["b"].placement, "move",
        "a changed placement needs move review"
    );
    assert_eq!(
        choices["c"].placement, "leave",
        "keep the person's unsaved choice"
    );
    assert!(selection(&saved, &choices, true).is_empty());
    choices.insert(
        "b".into(),
        Choice {
            placement: "add".into(),
            starts_at: None,
        },
    );
    reconcile_choices(&saved, &mut choices);
    assert!(
        !choices.contains_key("b"),
        "a default-time addition is settled by its saved placement"
    );
}
