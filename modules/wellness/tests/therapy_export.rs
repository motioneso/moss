mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const NOTES: &str = "app.wellness_therapy_notes";
const MARK: &str = "THERAPY-MARKER-91c3be";
const CHECKIN_MARK: &str = "CHECKIN-MARKER-5a07d2";

fn note(f: &Fake, body: Value) -> (u16, Value) {
    f.route("POST", "/wellness/therapy-notes", &[], body)
}

fn checkin(f: &Fake, text: &str) -> Value {
    f.route("POST", "/wellness/checkins", &[], json!({"feelingCore":"happy","note":text})).1["checkin"].clone()
}

fn export(f: &Fake, categories: Value) -> (u16, Value) {
    f.route("POST", "/wellness/export", &[], json!({"from":"2026-11-01","to":"2026-11-30","categories":categories}))
}

fn build(f: &Fake, categories: Value) -> String {
    let (status, out) = export(f, categories);
    assert_eq!(status, 202, "{out}");
    f.run_queued();
    out["jobId"].as_str().unwrap().to_owned()
}

fn download(f: &Fake, id: &str) -> (u16, Value) {
    f.route("GET", "/wellness/export/:id/download", &[("id", id)], Value::Null)
}

#[test]
fn notes_are_saved_listed_newest_first_and_deleted() {
    let f = Fake::new();
    let c = checkin(&f, "x");
    let (status, made) = note(&f, json!({"body":"  first  ","linkedCheckinId":c["id"],"linkedEmotion":"sad"}));
    assert_eq!(status, 201, "{made}");
    assert_eq!(made["note"]["body"], "first");
    assert_eq!(made["note"]["linkedEmotion"], "sad");
    assert_eq!(made["note"]["ownerUserId"], A);
    note(&f, json!({"body":"second"}));
    let (_, listed) = f.route("GET", "/wellness/therapy-notes", &[], Value::Null);
    assert_eq!(listed["notes"].as_array().unwrap().len(), 2);
    let id = made["note"]["id"].as_str().unwrap();
    let (status, gone) = f.route("DELETE", "/wellness/therapy-notes/:id", &[("id", id)], Value::Null);
    assert_eq!((status, gone), (200, json!({"deleted": true})));
    let (status, again) = f.route("DELETE", "/wellness/therapy-notes/:id", &[("id", id)], Value::Null);
    assert_eq!((status, again["error"].as_str().unwrap()), (404, "Therapy note not found"));
    assert_eq!(f.rows(NOTES).len(), 1);
}

#[test]
fn bad_note_bodies_get_the_old_wording() {
    let f = Fake::new();
    let cases = [
        (json!([]), "Expected JSON object body"),
        (json!({}), "body must have required property 'body'"),
        (json!({"body":"   "}), "body is required"),
        (json!({"body":"a","linkedCheckinId":5}), "linkedCheckinId must be a UUID string or null"),
        (json!({"body":"a","linkedEmotion":"glad"}), "linkedEmotion must be one of happy, sad, fear, anger, disgust, surprise"),
    ];
    for (body, message) in cases {
        let (status, out) = note(&f, body.clone());
        assert_eq!((status, out["error"].as_str().unwrap()), (400, message), "{body}");
    }
    assert!(f.rows(NOTES).is_empty());
}

#[test]
fn another_persons_notes_and_check_ins_stay_out_of_reach() {
    let f = Fake::new();
    let theirs = checkin(&f, "mine");
    let (_, made) = note(&f, json!({"body":"private"}));
    f.as_actor(B);
    let (status, out) = note(&f, json!({"body":"x","linkedCheckinId":theirs["id"]}));
    assert_eq!((status, out["error"].as_str().unwrap()), (404, "linked check-in not found"));
    let (status, out) = note(&f, json!({"body":"x","linkedCheckinId":"not-an-id"}));
    assert_eq!((status, out["error"].as_str().unwrap()), (404, "linked check-in not found"));
    let (_, listed) = f.route("GET", "/wellness/therapy-notes", &[], Value::Null);
    assert_eq!(listed["notes"], json!([]));
    let id = made["note"]["id"].as_str().unwrap();
    let (status, _) = f.route("DELETE", "/wellness/therapy-notes/:id", &[("id", id)], Value::Null);
    assert_eq!(status, 404);
    assert_eq!(f.rows(NOTES).len(), 1);
}

#[test]
fn export_requests_are_checked_the_old_way() {
    let f = Fake::new();
    let ask = |body: Value| f.route("POST", "/wellness/export", &[], body);
    let ok = json!(["checkins"]);
    let cases = [
        (json!([]), "body must be object"),
        (json!({"from":"2026-11-01","to":"2026-11-02"}), "body must have required property 'categories'"),
        (json!({"from":"soon","to":"2026-11-02","categories":ok}), "body/from must match pattern \"^\\d{4}-\\d{2}-\\d{2}$\""),
        (json!({"from":"2026-02-31","to":"2026-03-02","categories":ok}), "from and to must be valid dates"),
        (json!({"from":"2026-11-05","to":"2026-11-02","categories":ok}), "from must be on or before to"),
        (json!({"from":"2025-01-01","to":"2026-11-02","categories":ok}), "Date range must be at most 366 days"),
        (json!({"from":"2026-11-01","to":"2026-11-02","categories":[]}), "body/categories must NOT have fewer than 1 items"),
        (json!({"from":"2026-11-01","to":"2026-11-02","categories":["feelings"]}), "body/categories/0 must be equal to one of the allowed values"),
        (json!({"from":"2026-11-01","to":"2026-11-02","categories":["insights"]}), "The insights export is not available yet"),
        (json!({"from":"2026-11-01","to":"2026-11-02","categories":["checkins","medications"]}), "The medications export is not available yet"),
    ];
    for (body, message) in cases {
        let (status, out) = ask(body.clone());
        assert_eq!((status, out["error"].as_str().unwrap()), (400, message), "{body}");
    }
    assert!(f.queued.borrow().is_empty());
}

#[test]
fn a_second_request_reuses_the_same_job_or_conflicts() {
    let f = Fake::new();
    let (status, first) = export(&f, json!(["checkins", "therapyNotes"]));
    assert_eq!((status, &first["status"]), (202, &json!("pending")));
    let (status, again) = export(&f, json!(["therapyNotes", "checkins"]));
    assert_eq!((status, &again["jobId"]), (202, &first["jobId"]));
    assert_eq!(f.queued.borrow().len(), 1);
    let (status, other) = export(&f, json!(["checkins"]));
    assert_eq!(status, 409);
    assert_eq!(other["error"], "An export is already in progress with different parameters. Wait for it to finish before starting a new one.");
}

#[test]
fn a_stalled_export_stops_blocking_new_ones() {
    let f = Fake::new();
    let (_, first) = export(&f, json!(["checkins"]));
    f.set_clock("2026-11-11T18:16:00.000Z");
    let (status, other) = export(&f, json!(["therapyNotes"]));
    assert_eq!(status, 202, "{other}");
    let (_, old) = f.route("GET", "/wellness/export/:id", &[("id", first["jobId"].as_str().unwrap())], Value::Null);
    assert_eq!(old["status"], "failed");
    assert_eq!(old["errorMessage"], "The export did not finish. Start it again.");
}

#[test]
fn a_finished_export_holds_only_the_chosen_categories() {
    let f = Fake::new();
    checkin(&f, CHECKIN_MARK);
    note(&f, json!({"body": MARK, "linkedEmotion": "fear"}));
    let id = build(&f, json!(["therapyNotes"]));
    let (_, state) = f.route("GET", "/wellness/export/:id", &[("id", &id)], Value::Null);
    assert_eq!(state["status"], "ready");
    assert_eq!(state["expiresAt"], "2026-11-12T18:00:00.000Z");
    let (status, file) = download(&f, &id);
    assert_eq!(status, 200);
    assert_eq!(file["filename"], "wellness-export-2026-11-01-to-2026-11-30.html");
    let page = file["html"].as_str().unwrap();
    assert!(page.contains(MARK) && page.contains("Therapy notes") && page.contains("(fear)"));
    assert!(!page.contains(CHECKIN_MARK) && !page.contains("Mood check-ins"), "unchosen category leaked");
    let id = build(&f, json!(["checkins"]));
    let page = download(&f, &id).1["html"].as_str().unwrap().to_owned();
    assert!(page.contains(CHECKIN_MARK) && page.contains("Mood check-ins"));
    assert!(!page.contains(MARK) && !page.contains("Therapy notes"), "unchosen category leaked");
}

#[test]
fn an_empty_chosen_category_says_so_and_text_is_escaped() {
    let f = Fake::new();
    let id = build(&f, json!(["checkins"]));
    assert!(download(&f, &id).1["html"].as_str().unwrap().contains("No Mood check-ins in this range."));
    note(&f, json!({"body": "<script>alert('x')</script> & more"}));
    let id = build(&f, json!(["therapyNotes"]));
    let page = download(&f, &id).1["html"].as_str().unwrap().to_owned();
    assert!(page.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; more"));
    assert!(!page.contains("<script>"));
}

#[test]
fn notes_outside_the_window_are_left_out() {
    let f = Fake::new();
    note(&f, json!({"body": MARK}));
    let (_, out) = f.route("POST", "/wellness/export", &[], json!({"from":"2026-10-01","to":"2026-10-31","categories":["therapyNotes"]}));
    f.run_queued();
    let page = download(&f, out["jobId"].as_str().unwrap()).1["html"].as_str().unwrap().to_owned();
    assert!(!page.contains(MARK) && page.contains("No Therapy notes in this range."));
}

#[test]
fn an_unfinished_export_is_not_ready_and_unknown_ids_are_missing() {
    let f = Fake::new();
    let (_, out) = export(&f, json!(["checkins"]));
    let id = out["jobId"].as_str().unwrap();
    let (status, body) = download(&f, id);
    assert_eq!((status, body["error"].as_str().unwrap()), (404, "Export not ready"));
    let (status, body) = download(&f, "00000000-0000-4000-8000-0000000000ff");
    assert_eq!((status, body["error"].as_str().unwrap()), (404, "Export job not found"));
    f.as_actor(B);
    let (status, _) = f.route("GET", "/wellness/export/:id", &[("id", id)], Value::Null);
    assert_eq!(status, 404, "another person must not see the export");
}

#[test]
fn an_export_reads_as_gone_after_24_hours() {
    let f = Fake::new();
    note(&f, json!({"body": MARK}));
    let id = build(&f, json!(["therapyNotes"]));
    f.set_clock("2026-11-12T17:59:59.999Z");
    assert_eq!(download(&f, &id).0, 200);
    f.set_clock("2026-11-12T18:00:00.000Z");
    let (status, body) = download(&f, &id);
    assert_eq!((status, body["error"].as_str().unwrap()), (410, "Export has expired"));
    let (_, state) = f.route("GET", "/wellness/export/:id", &[("id", &id)], Value::Null);
    assert_eq!(state["status"], "expired");
    let kept = f.stored.borrow().get(&(A.to_owned(), "wellness.export-files".to_owned())).cloned();
    assert!(!kept.is_some_and(|files| files.to_string().contains(MARK)), "the file must be removed");
}

#[test]
fn old_records_are_dropped_after_a_week() {
    let f = Fake::new();
    let id = build(&f, json!(["checkins"]));
    f.set_clock("2026-11-13T18:00:00.000Z");
    assert_eq!(download(&f, &id).0, 410);
    f.set_clock("2026-11-19T18:00:00.000Z");
    assert_eq!(download(&f, &id).0, 404);
}

#[test]
fn private_text_never_reaches_jobs_clocks_or_other_stores() {
    let f = Fake::new();
    checkin(&f, CHECKIN_MARK);
    note(&f, json!({"body": MARK}));
    let (_, out) = export(&f, json!(["checkins"]));
    let id = out["jobId"].as_str().unwrap().to_owned();
    let (queue, request) = f.queued.borrow().first().cloned().unwrap();
    f.run_queued();
    download(&f, &id);
    for (port, operation, resource, parameters) in f.calls.borrow().iter() {
        let text = parameters.to_string();
        let writes_row = port == "db" && operation == "query";
        let writes_file = port == "kv" && resource == "wellness.export-files";
        if !writes_row && !writes_file {
            assert!(!text.contains(MARK) && !text.contains(CHECKIN_MARK), "{port} {operation} {resource} carried private text");
        }
    }
    assert_eq!(queue, "wellness-export");
    assert_eq!(request["params"], json!({"export-id": id}));
    assert_eq!(request["idempotencyKey"], id);
}

#[test]
fn a_failed_build_says_so_without_echoing_text() {
    let f = Fake::new();
    note(&f, json!({"body": MARK}));
    let (_, out) = export(&f, json!(["therapyNotes"]));
    *f.db_failure.borrow_mut() = Some(format!("failed on {MARK}"));
    f.run_queued();
    let id = out["jobId"].as_str().unwrap();
    let (_, state) = f.route("GET", "/wellness/export/:id", &[("id", id)], Value::Null);
    assert_eq!(state["status"], "failed");
    assert_eq!(state["errorMessage"], "The export could not be built. Start it again.");
    assert!(!state.to_string().contains(MARK));
}

#[test]
fn a_queue_failure_leaves_no_stuck_export() {
    let f = Fake::new();
    f.queue_failure.set(true);
    let (status, _) = export(&f, json!(["checkins"]));
    assert_eq!(status, 500);
    f.queue_failure.set(false);
    assert_eq!(export(&f, json!(["therapyNotes"])).0, 202);
}

#[test]
fn account_sections_cover_only_the_signed_in_person() {
    let f = Fake::new();
    checkin(&f, "mine");
    note(&f, json!({"body": MARK}));
    build(&f, json!(["checkins"]));
    f.as_actor(B);
    checkin(&f, "theirs");
    note(&f, json!({"body": "theirs"}));
    f.as_actor(A);
    let call = |name: &str, p: Value| moss_wellness_module::handle(&f, "api", &json!({"name": name, "parameters": p}).to_string());
    let section: Value = serde_json::from_str(&call("collectWellnessExportSection", json!({})).unwrap()).unwrap();
    assert_eq!(section["checkins"].as_array().unwrap().len(), 1);
    assert_eq!(section["therapy_notes"][0]["body"], MARK);
    assert!(call("collectWellnessExportSection", json!({"x": 1})).is_err());
    assert!(call("somethingElse", json!({})).is_err());
    call("deleteWellnessAccountData", json!({})).unwrap();
    assert_eq!(f.rows(NOTES).len(), 1);
    assert_eq!(f.rows("app.wellness_checkins").len(), 1);
    let left = f.stored.borrow().keys().filter(|(who, _)| who == A).count();
    assert_eq!(left, 0, "saved exports must go with the account data");
    f.as_actor(B);
    let theirs: Value = serde_json::from_str(&call("collectWellnessExportSection", json!({})).unwrap()).unwrap();
    assert_eq!(theirs["therapy_notes"][0]["body"], "theirs");
}
