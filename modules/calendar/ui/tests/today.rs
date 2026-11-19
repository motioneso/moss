//! Saved-record parity: proposed placement takes priority, removal retains the actual time.
use moss_calendar_ui::today_model::{gaps, items};
use serde_json::json;

#[test]
fn saved_proposals_and_actual_blocks_keep_the_typescript_labels_and_order() {
    let saved = json!({"plan":{"eveningIntent":null,"blocks":[
        {"id":"actual","kind":"focus","position":0,"taskId":"a","title":"Old title","actualPlacement":{"startsAt":"2030-05-26T19:00:00Z","durationMinutes":30},"pendingChange":null},
        {"id":"new","kind":"prep","position":1,"taskId":"b","title":"Saved title","actualPlacement":null,"pendingChange":{"kind":"add","startsAt":"2030-05-26T18:00:00Z","durationMinutes":45}},
        {"id":"removed","kind":"focus","position":2,"taskId":null,"title":"Still on calendar","actualPlacement":{"startsAt":"2030-05-26T20:00:00Z","durationMinutes":15},"pendingChange":{"kind":"remove"}},
        {"id":"untimed","kind":"unscheduled","position":3,"taskId":"c","title":"Unscheduled work","actualPlacement":null,"pendingChange":null}
    ]},"tasks":[{"id":"a","title":"Current task title","status":"todo"}],"unavailableTaskIds":["b"]});
    let result = items(
        &saved,
        &json!({"events":[]}),
        "2030-05-26".parse().unwrap(),
        chrono_tz::UTC,
        false,
    );
    assert_eq!(
        result.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        [
            "block:new",
            "block:actual",
            "block:removed",
            "block:untimed"
        ]
    );
    assert!(result[0].first_proposal);
    assert!(result[0].unavailable);
    assert_eq!(result[0].title, "Saved title");
    assert!(result[1].flexible);
    assert_eq!(result[1].title, "Current task title");
    assert_eq!(result[1].label, "On the calendar");
    assert_eq!(result[2].label, "Change pending");
    assert!(result[2].start.is_some());
    assert_eq!(result[3].label, "Proposed, not on the calendar yet");
}

#[test]
fn completed_task_and_pending_move_are_never_first_proposals_or_flexible() {
    for (status, expected) in [("done", "completed"), ("todo", "pending")] {
        let saved = json!({"plan":{"blocks":[{"id":"a","kind":"focus","taskId":"t","actualPlacement":{"startsAt":"2030-05-26T18:00:00Z","durationMinutes":30},"pendingChange":{"kind":"move","startsAt":"2030-05-26T20:00:00Z","durationMinutes":45}}]},"tasks":[{"id":"t","title":"Task","status":status}]});
        let result = items(
            &saved,
            &json!({"events":[]}),
            "2030-05-26".parse().unwrap(),
            chrono_tz::UTC,
            false,
        );
        assert_eq!(result[0].state, expected);
        assert_eq!(result[0].minutes, Some(45));
        assert!(!result[0].first_proposal);
        assert!(!result[0].flexible);
    }
}

#[test]
fn overlapping_calendar_events_do_not_invent_gaps_and_filter_by_account_day() {
    let events = json!({"events":[
        {"id":"long","title":"Workshop","startsAt":"2030-05-27T00:00:00Z","endsAt":"2030-05-27T03:00:00Z"},
        {"id":"short","title":"Check in","startsAt":"2030-05-27T01:00:00Z","endsAt":"2030-05-27T01:30:00Z"},
        {"id":"later","title":"Wrap up","startsAt":"2030-05-27T04:00:00Z","endsAt":"2030-05-27T04:15:00Z"},
        {"id":"tomorrow","title":"Tomorrow","startsAt":"2030-05-27T17:00:00Z","endsAt":"2030-05-27T18:00:00Z"}
    ]});
    let result = items(
        &json!({"plan":null}),
        &events,
        "2030-05-26".parse().unwrap(),
        chrono_tz::America::Los_Angeles,
        false,
    );
    assert_eq!(result.len(), 3);
    let (rows, closing) = gaps(&result);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].after, "event:short");
    assert_eq!(rows[0].label, "Open time");
    assert_eq!(closing, result[2].end);
}
