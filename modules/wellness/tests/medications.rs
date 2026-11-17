mod common;
use common::{Fake, A, B};
use serde_json::{json, Value};

const MEDS: &str = "app.medications";
const LOGS: &str = "app.medication_logs";

fn add(f: &Fake, body: Value) -> Value {
    let (status, out) = f.route("POST", "/wellness/medications", &[], body);
    assert_eq!(status, 201, "{out}");
    out["medication"].clone()
}

fn slots(f: &Fake, date: &str) -> Vec<Value> {
    let (status, out) = f.route_query("GET", "/wellness/medications/schedule", &[], &[("date", date)], Value::Null);
    assert_eq!(status, 200, "{out}");
    out["slots"].as_array().unwrap().clone()
}

fn log(f: &Fake, id: &str, body: Value) -> (u16, Value) {
    f.route("POST", "/wellness/medications/:id/logs", &[("id", id)], body)
}

fn times(slots: &[Value]) -> Vec<String> {
    slots.iter().map(|s| s["scheduledFor"].as_str().unwrap_or("prn").to_owned()).collect()
}

#[test]
fn create_stores_the_schedule_and_the_person_zone() {
    let f = Fake::new();
    let m = add(&f, json!({"name":"  Vit D ","frequencyType":"times_per_day","timesPerDay":2,"scheduleTimes":["08:00","20:00"],"dosage":"1000 IU"}));
    assert_eq!(m["name"], "Vit D");
    assert_eq!(m["frequencyType"], "times_per_day");
    assert_eq!(m["timeZone"], "America/Los_Angeles");
    assert_eq!(m["active"], true);
    assert_eq!(m["remindersEnabled"], false);
    let (_, list) = f.route("GET", "/wellness/medications", &[], Value::Null);
    assert_eq!(list["medications"].as_array().unwrap().len(), 1);
}

#[test]
fn bad_bodies_get_plain_400s_and_store_nothing() {
    let f = Fake::new();
    let cases = [
        (json!({}), "body must have required property 'name'"),
        (json!({"name":"x"}), "body must have required property 'frequencyType'"),
        (json!({"name":"x","frequencyType":"hourly"}), "body/frequencyType must be equal to one of the allowed values"),
        (json!({"name":"x","frequencyType":"once_daily"}), "scheduleTimes is required for once_daily"),
        (json!({"name":"x","frequencyType":"times_per_day","timesPerDay":2,"scheduleTimes":["08:00"]}), "scheduleTimes length must equal timesPerDay"),
        (json!({"name":"x","frequencyType":"specific_weekdays","weekdays":[0],"scheduleTimes":["08:00"]}), "weekdays is required for specific_weekdays"),
        (json!({"name":"x","frequencyType":"specific_weekdays","weekdays":[8],"scheduleTimes":["08:00"]}), "body/weekdays/0 must be <= 7, body/weekdays must be null, body/weekdays must match a schema in anyOf"),
        (json!({"name":"x","frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["8am"]}), "scheduleTimes must be clock times such as 08:00"),
    ];
    for (body, message) in cases {
        let (status, out) = f.route("POST", "/wellness/medications", &[], body.clone());
        assert_eq!((status, out["error"].as_str().unwrap()), (400, message), "{body}");
    }
    assert!(f.rows(MEDS).is_empty());
}

#[test]
fn a_daily_medicine_makes_a_slot_per_time_and_a_log_marks_it() {
    let f = Fake::new();
    let m = add(&f, json!({"name":"A","frequencyType":"times_per_day","timesPerDay":2,"scheduleTimes":["08:00","20:00"]}));
    let day = slots(&f, "2026-11-11");
    assert_eq!(times(&day), ["2026-11-11T08:00:00.000Z", "2026-11-11T20:00:00.000Z"]);
    assert!(day.iter().all(|s| s["status"] == "pending" && s["asNeeded"] == false));
    let id = m["id"].as_str().unwrap();
    let (status, out) = log(&f, id, json!({"status":"taken","scheduledFor":"2026-11-11T08:00:00Z"}));
    assert_eq!(status, 201, "{out}");
    let (status, _) = log(&f, id, json!({"status":"skipped","scheduledFor":"2026-11-11T20:00:00.000Z"}));
    assert_eq!(status, 201);
    let statuses: Vec<_> = slots(&f, "2026-11-11").iter().map(|s| s["status"].clone()).collect();
    assert_eq!(statuses, [json!("taken"), json!("skipped")]);
}

#[test]
fn logging_one_slot_twice_corrects_the_record() {
    let f = Fake::new();
    let m = add(&f, json!({"name":"A","frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"]}));
    let id = m["id"].as_str().unwrap();
    log(&f, id, json!({"status":"skipped","scheduledFor":"2026-11-11T08:00:00Z"}));
    let (status, _) = log(&f, id, json!({"status":"taken","scheduledFor":"2026-11-11T08:00:00Z"}));
    assert_eq!(status, 201);
    let rows = f.rows(LOGS);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["status"], "taken");
}

#[test]
fn an_as_needed_medicine_counts_its_doses_and_takes_no_schedule() {
    let f = Fake::new();
    let m = add(&f, json!({"name":"Ibuprofen","frequencyType":"as_needed"}));
    let id = m["id"].as_str().unwrap();
    for _ in 0..2 {
        let (status, out) = log(&f, id, json!({"status":"prn","prnReason":"headache"}));
        assert_eq!(status, 201, "{out}");
    }
    let day = slots(&f, "2026-11-11");
    assert_eq!(day.len(), 1);
    assert_eq!(day[0]["asNeeded"], true);
    assert_eq!(day[0]["prnCount"], 2);
    let (status, out) = f.route("PATCH", "/wellness/medications/:id", &[("id", id)], json!({"remindersEnabled":true}));
    assert_eq!((status, out["error"].as_str().unwrap()), (400, "remindersEnabled is not allowed for as_needed"));
}

#[test]
fn weekday_and_cycle_schedules_pick_the_right_days() {
    let f = Fake::new();
    // 2026-11-11 is a Wednesday (3). Mondays only never fires on it.
    add(&f, json!({"name":"W","frequencyType":"specific_weekdays","weekdays":[1],"timesPerDay":1,"scheduleTimes":["09:00"]}));
    assert!(slots(&f, "2026-11-11").is_empty());
    assert_eq!(slots(&f, "2026-11-09").len(), 1);
    // Two days on, one off, from the 9th: 9 on, 10 on, 11 off.
    add(&f, json!({"name":"C","frequencyType":"cyclical","cycleDaysOn":2,"cycleDaysOff":1,"cycleAnchorDate":"2026-11-09","timesPerDay":1,"scheduleTimes":["10:00"]}));
    assert!(slots(&f, "2026-11-11").is_empty());
    assert_eq!(slots(&f, "2026-11-10").len(), 1);
}

#[test]
fn every_n_hours_fills_the_day_from_the_first_time() {
    let f = Fake::new();
    add(&f, json!({"name":"H","frequencyType":"every_n_hours","intervalHours":8,"timesPerDay":3,"scheduleTimes":["06:00"]}));
    let day = slots(&f, "2026-11-11");
    assert_eq!(times(&day), ["2026-11-11T06:00:00.000Z", "2026-11-11T14:00:00.000Z", "2026-11-11T22:00:00.000Z"]);
}

#[test]
fn every_interval_and_monthly_follow_the_medication_zone() {
    let f = Fake::new();
    let body = json!({"name":"I","frequencyType":"every_interval","intervalUnit":"days","intervalCount":2,"startDate":"2026-11-09","timesPerDay":1,"scheduleTimes":["08:00"]});
    add(&f, body);
    // Los Angeles is UTC-8 in November, so 08:00 local is 16:00 UTC, on the 9th, 11th, 13th.
    assert_eq!(times(&slots(&f, "2026-11-11")), ["2026-11-11T16:00:00.000Z"]);
    assert!(slots(&f, "2026-11-12").is_empty());
    add(&f, json!({"name":"M","frequencyType":"monthly","monthKind":"date","monthDay":11,"startDate":"2026-01-01","timesPerDay":1,"scheduleTimes":["07:30"]}));
    assert_eq!(slots(&f, "2026-11-11").len(), 2);
    assert_eq!(slots(&f, "2026-11-10").len(), 0);
}

#[test]
fn an_unreal_date_and_bad_window_get_a_400() {
    let f = Fake::new();
    for date in ["2026-02-30", "soon", ""] {
        let (status, out) = f.route_query("GET", "/wellness/medications/schedule", &[], &[("date", date)], Value::Null);
        assert_eq!((status, out["error"].as_str().unwrap()), (400, "date must be an ISO date (YYYY-MM-DD)"), "{date}");
    }
    for days in ["0", "91", "x"] {
        let (status, out) = f.route_query("GET", "/wellness/medications/logs", &[], &[("sinceDays", days)], Value::Null);
        assert_eq!((status, out["error"].as_str().unwrap()), (400, "sinceDays must be 1\u{2013}90"), "{days}");
    }
}

#[test]
fn the_thirty_day_summary_counts_taken_against_scheduled() {
    let f = Fake::new();
    let m = add(&f, json!({"name":"A","frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"]}));
    let id = m["id"].as_str().unwrap();
    for day in ["2026-11-09", "2026-11-10"] {
        log(&f, id, json!({"status":"taken","scheduledFor":format!("{day}T08:00:00Z")}));
    }
    let (status, out) = f.route("GET", "/wellness/medications/logs", &[], Value::Null);
    assert_eq!(status, 200);
    let days = out["days"].as_array().unwrap();
    assert_eq!(days.len(), 30);
    assert_eq!(days[29]["date"], "2026-11-11");
    let on = |d: &str| days.iter().find(|x| x["date"] == d).unwrap().clone();
    assert_eq!((on("2026-11-10")["scheduledCount"].clone(), on("2026-11-10")["takenCount"].clone()), (json!(1), json!(1)));
    assert_eq!((on("2026-11-11")["scheduledCount"].clone(), on("2026-11-11")["takenCount"].clone()), (json!(1), json!(0)));
}

#[test]
fn change_replaces_the_schedule_and_clears_unused_columns() {
    let f = Fake::new();
    let m = add(&f, json!({"name":"A","frequencyType":"every_n_hours","intervalHours":6,"timesPerDay":4,"scheduleTimes":["00:00"]}));
    let id = m["id"].as_str().unwrap();
    let (status, out) = f.route("PATCH", "/wellness/medications/:id", &[("id", id)], json!({"frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["09:00"],"active":true}));
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["medication"]["intervalHours"], Value::Null);
    assert_eq!(out["medication"]["frequencyType"], "once_daily");
    let (status, out) = f.route("PATCH", "/wellness/medications/:id", &[("id", "00000000-0000-4000-8000-0000000000ff")], json!({"name":"B"}));
    assert_eq!((status, out), (404, json!({"error":"Medication not found"})));
    let (status, out) = log(&f, "00000000-0000-4000-8000-0000000000ff", json!({"status":"taken","scheduledFor":"2026-11-11T08:00:00Z"}));
    assert_eq!((status, out), (404, json!({"error":"Medication not found"})));
}

#[test]
fn each_person_sees_only_their_own_medicines_and_doses() {
    let f = Fake::new();
    let m = add(&f, json!({"name":"A","frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"]}));
    let id = m["id"].as_str().unwrap();
    log(&f, id, json!({"status":"taken","scheduledFor":"2026-11-11T08:00:00Z"}));
    f.as_actor(B);
    let (_, list) = f.route("GET", "/wellness/medications", &[], Value::Null);
    assert_eq!(list["medications"], json!([]));
    assert!(slots(&f, "2026-11-11").is_empty());
    assert_eq!(log(&f, id, json!({"status":"taken","scheduledFor":"2026-11-11T08:00:00Z"})).0, 404);
    assert_eq!(f.route("PATCH", "/wellness/medications/:id", &[("id", id)], json!({"name":"Z"})).0, 404);
    f.as_actor(A);
    assert_eq!(slots(&f, "2026-11-11").len(), 1);
}

fn counts(f: &Fake) -> Value {
    serde_json::from_str(&moss_wellness_module::handle(f, "api", r#"{"name":"medicationAdherence","parameters":{}}"#).unwrap()).unwrap()
}

#[test]
fn other_modules_get_counts_only_and_only_with_consent() {
    let f = Fake::new();
    let m = add(&f, json!({"name":"SECRET-NAME","dosage":"SECRET-DOSE","frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"]}));
    let id = m["id"].as_str().unwrap();
    log(&f, id, json!({"status":"taken","scheduledFor":"2026-11-11T08:00:00Z","dose":"SECRET-DOSE"}));
    let out = counts(&f);
    assert_eq!(out["taken"], 1);
    assert_eq!(out["windowDays"], 7);
    let text = out.to_string();
    for banned in ["SECRET-NAME", "SECRET-DOSE", id] {
        assert!(!text.contains(banned), "{text}");
    }
    let (status, _) = f.route("PUT", "/wellness/ai-consent", &[], json!({"granted":false}));
    assert_eq!(status, 200);
    assert_eq!(counts(&f), json!({"error":"Consent not granted","code":"WELLNESS_CONSENT_REQUIRED"}));
}
