//! The meal log: add, list, the estimate job, retry, correct, delete and the privacy rules. The
//! model is a queue of canned answers, so every estimate here is checked against the schema the
//! module sends the model before it is used.
mod common;

use common::{pacific, Fake, A, B};
use moss_meals_module::estimate;
use serde_json::{json, Value};

const JOB: &str = "meals-log-estimate";

/// Checks an answer against the schema the module hands the model. It covers what that schema
/// uses: object, array, string, number and null types, required keys, enums and closed objects.
fn fits(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    if let Some(options) = schema["enum"].as_array() {
        if !options.contains(value) {
            return Err(format!("{path} is not one of the allowed values"));
        }
    }
    let kinds: Vec<&str> = match &schema["type"] {
        Value::String(one) => vec![one.as_str()],
        Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    let kind_ok = kinds.is_empty()
        || kinds.iter().any(|k| match *k {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "number" => value.is_number(),
            "null" => value.is_null(),
            _ => false,
        });
    if !kind_ok {
        return Err(format!("{path} has the wrong type"));
    }
    if let Some(map) = value.as_object() {
        for key in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            if !map.contains_key(key) {
                return Err(format!("{path}.{key} is missing"));
            }
        }
        for (key, inner) in map {
            match schema["properties"].get(key) {
                Some(sub) => fits(sub, inner, &format!("{path}.{key}"))?,
                None if schema["additionalProperties"] == false => {
                    return Err(format!("{path}.{key} is not allowed"))
                }
                None => {}
            }
        }
    }
    if let (Some(list), true) = (value.as_array(), schema["items"].is_object()) {
        for (i, inner) in list.iter().enumerate() {
            fits(&schema["items"], inner, &format!("{path}[{i}]"))?;
        }
    }
    Ok(())
}

fn item(label: &str, note: Value, kcal: Value, sodium: Value) -> Value {
    json!({"label":label,"portionNote":note,"caloriesKcal":kcal,"proteinG":10,
        "carbohydratesG":20,"fatG":5,"fiberG":2,"sugarG":3,"sodiumMg":sodium})
}

fn canned(items: Vec<Value>) -> String {
    let answer = json!({"outcome":"estimated","items":items,"missingDetails":null,
        "clarificationQuestion":null});
    fits(&estimate::schema(), &answer, "answer").expect("the canned answer fits the schema");
    answer.to_string()
}

fn queue_answer(f: &Fake, text: String) {
    f.model.borrow_mut().push_back(Ok(text));
}

fn add(f: &Fake, description: &str, key: &str) -> Value {
    f.ok("meals.log.add", json!({"description":description,"idempotencyKey":key}))["entry"].clone()
}

fn run_job(f: &Fake, entry: &Value) {
    let payload = json!({"queue":JOB,"parameters":{
        "entry-id":entry["entryId"],"revision":entry["estimateRevision"]}})
    .to_string();
    moss_meals_module::handle(f, "job", &payload).expect("the job runs");
}

fn day(f: &Fake, date: &str) -> Value {
    f.ok("meals.log.list", json!({"localDate":date}))
}

#[test]
fn canned_answers_are_checked_against_the_schema() {
    let ok = json!({"outcome":"estimated","items":[item("egg", json!("1"), json!(70), json!(60))],
        "missingDetails":null,"clarificationQuestion":null});
    assert!(fits(&estimate::schema(), &ok, "a").is_ok());
    let extra = json!({"outcome":"estimated","items":[],"missingDetails":null,
        "clarificationQuestion":null,"confidence":0.9});
    assert!(fits(&estimate::schema(), &extra, "a").is_err());
    let missing = json!({"outcome":"estimated","items":[]});
    assert!(fits(&estimate::schema(), &missing, "a").is_err());
    let bad_enum = json!({"outcome":"guess","items":[],"missingDetails":null,
        "clarificationQuestion":null});
    assert!(fits(&estimate::schema(), &bad_enum, "a").is_err());
}

#[test]
fn a_new_meal_is_saved_pending_with_no_figures_and_one_job() {
    let f = Fake::new();
    let entry = add(&f, "two eggs and toast", "k1");
    assert_eq!(entry["estimateState"], "pending");
    assert_eq!(entry["estimateRevision"], 1);
    assert!(entry["nutrients"].is_null(), "a pending meal has no figures, not zero");
    assert_eq!(entry["localDate"], "2026-11-06");
    let queued = f.queued.borrow();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].0, JOB);
    assert_eq!(queued[0].1, json!({"entry-id":entry["entryId"],"revision":1}));
}

#[test]
fn a_retry_with_the_same_key_returns_the_same_meal_and_queues_nothing_more() {
    let f = Fake::new();
    let first = add(&f, "two eggs", "same");
    let second = add(&f, "two eggs", "same");
    assert_eq!(first["entryId"], second["entryId"]);
    assert_eq!(f.queued.borrow().len(), 1);
    assert_eq!(day(&f, "2026-11-06")["totalCount"], 1);
}

#[test]
fn the_job_stores_an_estimate_that_is_the_sum_of_its_foods() {
    let f = Fake::new();
    let entry = add(&f, "6 hot wings and a 32 oz Coke Zero", "k");
    queue_answer(
        &f,
        canned(vec![
            item("hot wings", json!("6"), json!(480), json!(1200)),
            item("Coke Zero", json!("32 oz"), json!(0), Value::Null),
        ]),
    );
    run_job(&f, &entry);
    let listed = day(&f, "2026-11-06");
    let shown = &listed["entries"][0];
    assert_eq!(shown["estimateState"], "estimated");
    assert_eq!(shown["items"].as_array().unwrap().len(), 2);
    assert_eq!(shown["items"][0]["label"], "hot wings");
    assert_eq!(shown["nutrients"]["caloriesKcal"], 480.0);
    assert_eq!(shown["nutrients"]["proteinG"], 20.0);
    // One food reported no sodium, so the total is the figure the other food knows.
    assert_eq!(shown["nutrients"]["sodiumMg"], 1200.0);
    assert!(shown["items"][1]["nutrients"]["sodiumMg"].is_null());
    assert_eq!(listed["totals"]["nutrients"]["caloriesKcal"], 480.0);
    assert_eq!(listed["totals"]["incomplete"], false);
}

#[test]
fn an_unknown_figure_stays_unknown_and_never_becomes_zero() {
    let f = Fake::new();
    let entry = add(&f, "a mystery bowl", "k");
    queue_answer(&f, canned(vec![item("bowl", Value::Null, Value::Null, Value::Null)]));
    run_job(&f, &entry);
    let shown = &day(&f, "2026-11-06")["entries"][0];
    assert!(shown["nutrients"]["caloriesKcal"].is_null());
    assert!(shown["nutrients"]["sodiumMg"].is_null());
    assert_eq!(shown["nutrients"]["proteinG"], 10.0);
    assert!(shown["items"][0]["portionNote"].is_null());
}

#[test]
fn a_figure_beyond_any_real_meal_is_dropped_to_unknown() {
    let f = Fake::new();
    let entry = add(&f, "salad", "k");
    let mut wild = item("salad", json!("1"), json!(999_999), json!(-5));
    wild["proteinG"] = json!(40);
    queue_answer(&f, json!({"outcome":"estimated","items":[wild],"missingDetails":null,
        "clarificationQuestion":null}).to_string());
    run_job(&f, &entry);
    let shown = &day(&f, "2026-11-06")["entries"][0];
    assert_eq!(shown["estimateState"], "estimated");
    assert!(shown["nutrients"]["caloriesKcal"].is_null());
    assert!(shown["nutrients"]["sodiumMg"].is_null());
    assert_eq!(shown["nutrients"]["proteinG"], 40.0);
}

#[test]
fn a_vague_meal_asks_a_question_and_adds_nothing_to_the_day() {
    let f = Fake::new();
    let entry = add(&f, "some food", "k");
    queue_answer(&f, json!({"outcome":"needs_details","items":[],
        "missingDetails":"no food or amount","clarificationQuestion":"What did you eat?"}).to_string());
    run_job(&f, &entry);
    let listed = day(&f, "2026-11-06");
    let shown = &listed["entries"][0];
    assert_eq!(shown["estimateState"], "needs_details");
    assert_eq!(shown["clarificationQuestion"], "What did you eat?");
    assert!(shown["nutrients"].is_null());
    assert_eq!(listed["totals"]["entriesWithoutEstimate"], 1);
    assert_eq!(listed["totals"]["incomplete"], true);
    assert!(listed["totals"]["nutrients"]["caloriesKcal"].is_null());
}

#[test]
fn an_answer_that_breaks_the_schema_fails_the_estimate() {
    for bad in [
        "not json at all".to_owned(),
        json!({"outcome":"estimated","items":[],"missingDetails":null,"clarificationQuestion":null}).to_string(),
        json!({"outcome":"estimated","items":[item("egg", json!("1"), json!(70), json!(60))],
            "missingDetails":null,"clarificationQuestion":null,"extra":1}).to_string(),
        json!({"outcome":"estimated","items":[{"label":"egg","caloriesKcal":70}],
            "missingDetails":null,"clarificationQuestion":null}).to_string(),
    ] {
        let f = Fake::new();
        let entry = add(&f, "an egg", "k");
        queue_answer(&f, bad.clone());
        run_job(&f, &entry);
        let shown = &day(&f, "2026-11-06")["entries"][0];
        assert_eq!(shown["estimateState"], "failed", "{bad}");
        assert!(shown["nutrients"].is_null());
    }
}

#[test]
fn a_model_that_is_down_fails_the_estimate_and_retry_queues_a_fresh_job() {
    let f = Fake::new();
    let entry = add(&f, "an egg", "k");
    run_job(&f, &entry);
    assert_eq!(day(&f, "2026-11-06")["entries"][0]["estimateState"], "failed");
    let retried = f.ok("meals.log.reestimate", json!({"entryId":entry["entryId"]}))["entry"].clone();
    assert_eq!(retried["estimateState"], "pending");
    let queued = f.queued.borrow();
    assert_eq!(queued.len(), 2);
    assert_ne!(queued[0].2, queued[1].2, "a retry must not reuse the key of the attempt before it");
    drop(queued);
    queue_answer(&f, canned(vec![item("egg", json!("1"), json!(70), json!(60))]));
    run_job(&f, &retried);
    assert_eq!(day(&f, "2026-11-06")["entries"][0]["estimateState"], "estimated");
}

#[test]
fn retry_leaves_an_estimated_meal_alone() {
    let f = Fake::new();
    let entry = add(&f, "an egg", "k");
    queue_answer(&f, canned(vec![item("egg", json!("1"), json!(70), json!(60))]));
    run_job(&f, &entry);
    let again = f.ok("meals.log.reestimate", json!({"entryId":entry["entryId"]}))["entry"].clone();
    assert_eq!(again["estimateState"], "estimated");
    assert_eq!(f.queued.borrow().len(), 1);
}

#[test]
fn a_job_for_an_old_revision_changes_nothing() {
    let f = Fake::new();
    let entry = add(&f, "an egg", "k");
    f.ok("meals.log.correct", json!({"entryId":entry["entryId"],"expectedRevision":1,
        "description":"two eggs"}));
    queue_answer(&f, canned(vec![item("egg", json!("1"), json!(70), json!(60))]));
    run_job(&f, &entry);
    let shown = &day(&f, "2026-11-06")["entries"][0];
    assert_eq!(shown["estimateState"], "pending");
    assert_eq!(shown["description"], "two eggs");
    assert_eq!(f.queued.borrow().len(), 2, "the correction queued its own job");
}

#[test]
fn a_queue_that_is_down_marks_the_meal_failed_but_still_saves_it() {
    let f = Fake::new();
    f.queue_refuses.set(true);
    let entry = add(&f, "an egg", "k");
    assert_eq!(entry["estimateState"], "failed");
    assert_eq!(day(&f, "2026-11-06")["totalCount"], 1);
}

#[test]
fn correcting_an_estimated_meal_recalculates_its_totals_from_the_foods() {
    let f = Fake::new();
    let entry = add(&f, "wings and coke", "k");
    queue_answer(
        &f,
        canned(vec![
            item("hot wings", json!("6"), json!(480), json!(1200)),
            item("Coke Zero", json!("32 oz"), json!(0), json!(40)),
        ]),
    );
    run_job(&f, &entry);
    let before = day(&f, "2026-11-06")["entries"][0].clone();
    let fixed = f.ok("meals.log.correct", json!({"entryId":entry["entryId"],
        "expectedRevision":before["estimateRevision"],
        "items":[{"nutrients":{"caloriesKcal":600}}, null]}))["entry"].clone();
    assert_eq!(fixed["estimateState"], "estimated");
    assert_eq!(fixed["nutrients"]["caloriesKcal"], 600.0);
    assert_eq!(fixed["items"][0]["nutrients"]["proteinG"], 10.0, "a figure not named stays");
    assert_eq!(fixed["items"][1]["nutrients"]["caloriesKcal"], 0.0, "a null leaves the item alone");
    assert_eq!(fixed["nutrients"]["sodiumMg"], 1240.0);
}

#[test]
fn correcting_with_an_out_of_date_revision_is_refused() {
    let f = Fake::new();
    let entry = add(&f, "an egg", "k");
    f.ok("meals.log.correct", json!({"entryId":entry["entryId"],"expectedRevision":1,
        "description":"two eggs"}));
    let (code, message) = f.refused("meals.log.correct", json!({"entryId":entry["entryId"],
        "expectedRevision":1,"description":"three eggs"}));
    assert_eq!(code, "invalid_input");
    assert_eq!(message, "That entry changed since it was read. Read it again and retry.");
    assert_eq!(day(&f, "2026-11-06")["entries"][0]["description"], "two eggs");
}

#[test]
fn delete_removes_the_meal_with_its_estimate_and_cannot_repeat() {
    let f = Fake::new();
    let entry = add(&f, "an egg", "k");
    queue_answer(&f, canned(vec![item("egg", json!("1"), json!(70), json!(60))]));
    run_job(&f, &entry);
    let gone = f.ok("meals.log.delete", json!({"entryId":entry["entryId"]}));
    assert_eq!(gone["deleted"], true);
    assert_eq!(day(&f, "2026-11-06")["totalCount"], 0);
    for table in ["app.meals_log_entries", "app.meals_log_estimates", "app.meals_log_estimate_items"] {
        assert!(f.rows(table).is_empty(), "{table}");
    }
    let (_, message) = f.refused("meals.log.delete", json!({"entryId":entry["entryId"]}));
    assert_eq!(message, "There is no log entry with that id");
}

#[test]
fn a_time_with_an_offset_is_taken_as_written() {
    let f = Fake::new();
    f.zone.set(pacific);
    let entry = f.ok("meals.log.add", json!({"description":"late snack","idempotencyKey":"k",
        "consumedAt":"2026-11-10T23:30:00-08:00"}))["entry"].clone();
    assert_eq!(entry["consumedAt"], "2026-11-11T07:30:00.000Z");
    assert_eq!(entry["localDate"], "2026-11-10");
    assert_eq!(entry["timezoneOffset"], -480);
}

#[test]
fn a_local_time_the_clock_skipped_or_repeated_is_refused() {
    let f = Fake::new();
    f.zone.set(pacific);
    for (at, key) in [("2026-03-08T02:30:00", "gap"), ("2026-11-01T01:30:00", "fold")] {
        let (code, _) = f.refused("meals.log.add", json!({"description":"x","idempotencyKey":key,
            "consumedAt":at}));
        assert_eq!(code, "invalid_input", "{at}");
    }
    let ordinary = f.ok("meals.log.add", json!({"description":"x","idempotencyKey":"fine",
        "consumedAt":"2026-07-01T12:00:00"}))["entry"].clone();
    assert_eq!(ordinary["consumedAt"], "2026-07-01T19:00:00.000Z");
    assert_eq!(ordinary["timezoneOffset"], -420);
}

#[test]
fn a_meal_type_picks_the_usual_time_of_day() {
    let f = Fake::new();
    let entry = f.ok("meals.log.add", json!({"description":"oats","idempotencyKey":"k",
        "mealType":"breakfast"}))["entry"].clone();
    assert_eq!(entry["consumedAt"], "2026-11-06T16:00:00.000Z");
}

#[test]
fn a_day_reports_how_its_calories_sit_against_the_target() {
    let f = Fake::new();
    let kitchen = f.ok("meals.kitchen.get", json!({}));
    let me = kitchen["members"].as_array().unwrap().iter().find(|m| m["isSelf"] == true).unwrap();
    f.ok("meals.household.save", json!({"memberId":me["memberId"],"calorieTarget":2000}));
    let entry = add(&f, "a big lunch", "k");
    queue_answer(&f, canned(vec![item("lunch", json!("1"), json!(2100), json!(900))]));
    run_job(&f, &entry);
    let listed = day(&f, "2026-11-06");
    assert_eq!(listed["targets"]["caloriesKcal"], 2000);
    assert_eq!(listed["calorieFit"]["band"], "on");
    assert_eq!(listed["calorieFit"]["differenceKcal"], 100.0);
}

#[test]
fn a_range_lists_and_summarises_without_counting_waiting_meals_as_zero() {
    let f = Fake::new();
    let one = add(&f, "breakfast", "a");
    add(&f, "lunch", "b");
    queue_answer(&f, canned(vec![item("oats", json!("1"), json!(300), json!(100))]));
    run_job(&f, &one);
    let range = json!({"fromLocalDate":"2026-11-01","toLocalDate":"2026-11-30"});
    let listed = f.ok("meals.log.list", range.clone());
    assert_eq!(listed["entries"].as_array().unwrap().len(), 2);
    let summary = f.ok("meals.log.summarize", range);
    assert_eq!(summary["nutrients"]["caloriesKcal"], 300.0);
    assert_eq!(summary["entriesWithoutEstimate"], 1);
    assert_eq!(summary["incomplete"], true);
    assert_eq!(summary["daysWithEntries"], 1);
}

#[test]
fn inputs_outside_the_old_limits_are_refused() {
    let f = Fake::new();
    let long = "x".repeat(2001);
    assert_eq!(f.refused("meals.log.add", json!({"description":long,"idempotencyKey":"k"})).0, "invalid_input");
    assert_eq!(f.refused("meals.log.add", json!({"description":"  ","idempotencyKey":"k"})).0, "invalid_input");
    assert_eq!(f.refused("meals.log.add", json!({"description":"x"})).0, "invalid_input");
    assert_eq!(f.refused("meals.log.add", json!({"description":"x","idempotencyKey":"k","nope":1})).0, "invalid_input");
    let wide = json!({"fromLocalDate":"2026-01-01","toLocalDate":"2026-03-01"});
    assert_eq!(f.refused("meals.log.list", wide).0, "invalid_input");
    assert_eq!(f.refused("meals.log.list", json!({"localDate":"2026-13-01"})).0, "invalid_input");
}

#[test]
fn each_person_sees_and_changes_only_their_own_log() {
    let f = Fake::new();
    let mine = add(&f, "my egg", "k");
    f.as_actor(B);
    assert_eq!(day(&f, "2026-11-06")["totalCount"], 0);
    let id = mine["entryId"].clone();
    for (tool, params) in [
        ("meals.log.delete", json!({"entryId":id})),
        ("meals.log.reestimate", json!({"entryId":id})),
        ("meals.log.correct", json!({"entryId":id,"expectedRevision":1,"description":"stolen"})),
    ] {
        let (_, message) = f.refused(tool, params);
        assert!(
            message == "There is no log entry with that id" || message.starts_with("That entry changed"),
            "{tool}: {message}"
        );
    }
    // The same idempotency key belongs to each person separately.
    let theirs = add(&f, "their egg", "k");
    assert_ne!(theirs["entryId"], id);
    f.as_actor(A);
    let listed = day(&f, "2026-11-06");
    assert_eq!(listed["totalCount"], 1);
    assert_eq!(listed["entries"][0]["description"], "my egg");
}
