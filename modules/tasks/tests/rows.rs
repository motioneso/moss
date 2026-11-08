use moss_tasks_module::{recurrence, rows::Task};
use serde_json::{json, Value};
#[test]
fn task_dto_keeps_the_existing_shape_without_internal_columns() {
    let task:Task=serde_json::from_value(json!({
        "id":"task","owner_user_id":"owner","list_id":"list","parent_task_id":null,
        "title":"Existing task","description":null,"status":"suggested","priority":null,
        "position":2,"due_at":"2026-11-08T12:34:56+01:00","do_at":null,"effort":null,
        "source":"email","source_ref":"message","completed_at":null,
        "created_at":"2026-11-07T00:00:00Z","updated_at":"2026-11-08T00:00:00.000Z",
        "suggestion_metadata":{"version":1},"recurrence":{"freq":"daily","interval":1,"occurrence_date":"2026-11-08"},
        "external_key":"private-internal-key","recurrence_series_id":"series"
    })).unwrap();
    let dto = task.dto(&[]);
    assert_eq!(dto["dueAt"], "2026-11-08T11:34:56.000Z");
    assert_eq!(dto["status"], "suggested");
    assert_eq!(dto["createdAt"], "2026-11-07T00:00:00.000Z");
    assert!(dto.get("externalKey").is_none() && dto.get("external_key").is_none());
    assert!(dto.get("recurrenceSeriesId").is_none());
    assert_eq!(dto.as_object().unwrap().len(), 20);
    assert_eq!(dto["tags"], json!([]));
}
#[test]
fn recurrence_rejects_bad_dates_and_clamps_month_ends() {
    for day in ["2026-02-30", "2026-1-01", "２０２６-01-01"] {
        assert!(
            recurrence::parse(&json!({"freq":"daily","interval":1,"occurrence_date":day}))
                .is_none()
        );
    }
    let spec =
        recurrence::parse(&json!({"freq":"monthly","interval":1,"occurrence_date":"2024-01-31"}))
            .unwrap();
    assert_eq!(spec.next().as_deref(), Some("2024-02-29"));
    assert_eq!(
        spec.at_or_after("2024-01-31").as_deref(),
        Some("2024-01-31")
    );
    assert_eq!(
        spec.at_or_after("2024-03-01").as_deref(),
        Some("2024-03-29")
    );
}
#[test]
fn host_failure_response_does_not_include_internal_detail() {
    let err = moss_tasks_module::repository::Error::Host(moss_module_sdk::Error::new(
        "database credential detail",
    ));
    let reply = err.response();
    assert_eq!(reply.status, 500);
    assert_eq!(reply.body, json!({"error":"Internal server error"}));
    let _: Value = reply.body;
}
