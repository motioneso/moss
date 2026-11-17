//! Log proofs through the installed Wasm component, the real database and the old handlers.
use super::tools::run;
use super::*;

// The three tests share one job queue, so any of them can pick up another's job. They take turns.
static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

const LOG_TABLES: [&str; 3] = [
    "app.meals_log_entries",
    "app.meals_log_estimates",
    "app.meals_log_estimate_items",
];

fn item(label: &str, note: Value, kcal: Value, sodium: Value) -> Value {
    json!({"label":label,"portionNote":note,"caloriesKcal":kcal,"proteinG":10,
        "carbohydratesG":20.5,"fatG":5,"fiberG":2,"sugarG":3,"sodiumMg":sodium})
}

fn estimated(items: Vec<Value>) -> String {
    json!({"outcome":"estimated","items":items,"missingDetails":null,"clarificationQuestion":null}).to_string()
}

/// One step of the comparison. An estimate step runs the job on the newest waiting entry.
enum Step {
    Tool(&'static str, Value),
    Estimate(Option<String>),
}

fn fill(params: &Value, entry: &str) -> Value {
    params.to_string().replace("{entry}", entry).parse().unwrap()
}

#[test]
#[ignore = "Only through verify-gate"]
fn installed_log_tools_match_the_old_handlers_step_for_step() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let w = World::new();
    let (new_actor, old_actor) = (w.f.a, w.add_user());
    let setup = json!({"unitsSystem":"metric"});
    run(&w, new_actor, "meals.kitchen.save", setup.clone(), true);
    replay::old_tool(old_actor, &role(), "meals.kitchen.save", setup);
    let at = |hour: u32| format!("2026-11-10T{hour:02}:15:00-08:00");
    let missing = "99999999-9999-4999-8999-999999999999";
    let wings = estimated(vec![
        item("hot wings", json!("6"), json!(480.123), json!(1200)),
        item("Coke Zero", json!("32 oz"), json!(0), Value::Null),
    ]);
    let vague = json!({"outcome":"needs_details","items":[],"missingDetails":"no amount",
        "clarificationQuestion":"How much?"}).to_string();
    let steps: Vec<Step> = vec![
        Step::Tool("meals.log.list", json!({"localDate":"2026-11-10"})),
        Step::Tool("meals.log.list", json!({})),
        Step::Tool("meals.log.add", json!({"description":"6 hot wings and a Coke Zero","idempotencyKey":"k1","consumedAt":at(12)})),
        Step::Tool("meals.log.add", json!({"description":"6 hot wings and a Coke Zero","idempotencyKey":"k1","consumedAt":at(12)})),
        Step::Tool("meals.log.add", json!({"description":"some food","idempotencyKey":"k2","consumedAt":at(18),"servingNote":"a big bowl","captureKind":"voice"})),
        Step::Tool("meals.log.add", json!({"description":"  ","idempotencyKey":"k3"})),
        Step::Tool("meals.log.add", json!({"description":"x"})),
        Step::Tool("meals.log.add", json!({"description":"x","idempotencyKey":"k4","consumedAt":"not a time"})),
        Step::Tool("meals.log.add", json!({"description":"x","idempotencyKey":"k4","captureKind":"smell"})),
        Step::Tool("meals.log.add", json!({"description":"x","idempotencyKey":"k4","extra":1})),
        Step::Tool("meals.log.list", json!({"localDate":"2026-11-10"})),
        Step::Estimate(Some(wings.clone())),
        Step::Tool("meals.log.list", json!({"localDate":"2026-11-10"})),
        Step::Tool("meals.log.list", json!({"fromLocalDate":"2026-11-01","toLocalDate":"2026-11-30","limit":1})),
        Step::Tool("meals.log.summarize", json!({"fromLocalDate":"2026-11-01","toLocalDate":"2026-11-30"})),
        Step::Tool("meals.log.summarize", json!({"fromLocalDate":"2026-01-01","toLocalDate":"2026-11-30"})),
        Step::Tool("meals.log.reestimate", json!({"entryId":"{entry}"})),
        Step::Tool("meals.log.reestimate", json!({"entryId":missing})),
        Step::Tool("meals.log.correct", json!({"entryId":"{entry}","expectedRevision":1,"items":[{"nutrients":{"caloriesKcal":600}},null]})),
        Step::Tool("meals.log.correct", json!({"entryId":"{entry}","expectedRevision":1,"description":"stale"})),
        Step::Tool("meals.log.correct", json!({"entryId":"{entry}","expectedRevision":2,"description":"six wings","servingNote":null})),
        Step::Tool("meals.log.correct", json!({"entryId":"{entry}","expectedRevision":3,"consumedAt":at(13)})),
        Step::Tool("meals.log.correct", json!({"entryId":"{entry}","expectedRevision":4,"items":[{"label":"  "}]})),
        Step::Tool("meals.log.list", json!({"localDate":"2026-11-10"})),
        Step::Tool("meals.log.delete", json!({"entryId":"{entry}"})),
        Step::Tool("meals.log.delete", json!({"entryId":"{entry}"})),
        Step::Tool("meals.log.delete", json!({"entryId":"nope"})),
        Step::Estimate(Some(vague)),
        Step::Tool("meals.log.list", json!({"localDate":"2026-11-10"})),
        Step::Estimate(None),
        Step::Tool("meals.log.summarize", json!({"fromLocalDate":"2026-11-10","toLocalDate":"2026-11-10"})),
    ];
    let (mut new_entry, mut old_entry) = (String::new(), String::new());
    for (n, step) in steps.iter().enumerate() {
        match step {
            Step::Tool(tool, params) => {
                let new = run(&w, new_actor, tool, fill(params, &new_entry), true);
                assert_eq!(new["status"], 200, "step {n} {tool}: {new}");
                let (old, _) = replay::old_log(old_actor, &role(), tool, fill(params, &old_entry), None);
                if *tool == "meals.log.add" {
                    if let (Some(a), Some(b)) = (
                        new["body"]["data"]["entry"]["entryId"].as_str(),
                        old["data"]["entry"]["entryId"].as_str(),
                    ) {
                        (new_entry, old_entry) = (a.to_owned(), b.to_owned());
                    }
                }
                let (mut a, mut b) = (new["body"].clone(), old.clone());
                replay::mask(&mut a);
                replay::mask(&mut b);
                assert_eq!(a, b, "step {n} {tool} {params}");
            }
            Step::Estimate(answer) => {
                // The job runs on the entry the last add made. Its revision is read from each side.
                let revision = |actor: uuid::Uuid, id: &str| -> i64 {
                    rows_as(&w.f, actor, &format!("SELECT estimate_revision FROM app.meals_log_entries WHERE entry_id = '{id}'"))
                        .first()
                        .map_or(1, |r| i64::from(r.get::<_, i32>(0)))
                };
                w.answer(answer.clone());
                w.run_jobs();
                replay::old_log(
                    old_actor,
                    &role(),
                    "job",
                    json!({"entryId":old_entry,"revision":revision(old_actor, &old_entry)}),
                    answer.as_deref(),
                );
            }
        }
    }
    println!("PASS parity: {} log steps match the old handlers", steps.len());
}

fn digest(w: &World, table: &str, owner: uuid::Uuid) -> String {
    w.f.rt
        .block_on(w.f.root.query_one(
            &format!("SELECT coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)),'') FROM {table} t WHERE owner_user_id = '{owner}'"),
            &[],
        ))
        .unwrap()
        .get(0)
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_log_is_private_and_the_job_and_estimate_carry_no_text_beyond_the_meal() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    let added = run(&w, a, "meals.log.add", json!({"description":MARK,"idempotencyKey":"mark-1","consumedAt":"2026-11-10T12:00:00-08:00"}), true);
    assert_eq!(added["status"], 200, "{added}");
    let entry = added["body"]["data"]["entry"].clone();
    assert_eq!(entry["estimateState"], "pending", "{added}");
    assert!(entry["nutrients"].is_null(), "{added}");
    // The queued job names the entry and its revision and holds no meal text.
    let payloads: Vec<String> = w.f.rt
        .block_on(w.f.root.query("SELECT payload::text FROM moss_queue.jobs WHERE queue LIKE '%meals-log-estimate' AND payload::text LIKE '%' || $1 || '%'", &[&entry["entryId"].as_str().unwrap()]))
        .unwrap().iter().map(|r| r.get(0)).collect();
    assert_eq!(payloads.len(), 1, "adding a meal queues one estimate job");
    assert!(!payloads[0].contains(MARK), "{}", payloads[0]);
    assert!(payloads[0].contains(entry["entryId"].as_str().unwrap()));
    w.answer(Some(estimated(vec![item("marker food", json!("1"), json!(300), json!(50))])));
    w.run_jobs();
    let listed = run(&w, a, "meals.log.list", json!({"localDate":"2026-11-10"}), true);
    assert_eq!(listed["body"]["data"]["entries"][0]["estimateState"], "estimated", "{listed}");
    assert_eq!(listed["body"]["data"]["entries"][0]["nutrients"]["caloriesKcal"], 300.0, "{listed}");
    // The second person and the admin see nothing and can change nothing.
    let id = entry["entryId"].clone();
    for actor in [b, w.f.admin] {
        let seen = run(&w, actor, "meals.log.list", json!({"localDate":"2026-11-10"}), true);
        assert!(!seen.to_string().contains(MARK), "{seen}");
        assert_eq!(seen["body"]["data"]["totalCount"], 0, "{seen}");
        let summary = run(&w, actor, "meals.log.summarize", json!({"fromLocalDate":"2026-11-01","toLocalDate":"2026-11-30"}), true);
        assert!(summary["body"]["data"]["nutrients"]["caloriesKcal"].is_null(), "{summary}");
        for (tool, params) in [
            ("meals.log.delete", json!({"entryId":id})),
            ("meals.log.reestimate", json!({"entryId":id})),
            ("meals.log.correct", json!({"entryId":id,"expectedRevision":2,"description":"Stolen"})),
        ] {
            let refused = run(&w, actor, tool, params, true);
            assert_eq!(refused["body"]["data"]["code"], "invalid_input", "{tool}: {refused}");
        }
    }
    let kept = run(&w, a, "meals.log.list", json!({"localDate":"2026-11-10"}), true);
    assert_eq!(kept["body"]["data"]["entries"][0]["description"], MARK, "the other person changed nothing");
    // Negative control: without the owner rule the second person sees the rows.
    for table in LOG_TABLES {
        assert!(!rows_as(&w.f, a, &format!("SELECT 1 FROM {table}")).is_empty(), "{table} needs rows to protect");
        assert!(rows_as(&w.f, b, &format!("SELECT 1 FROM {table}")).is_empty());
        let weaken = format!("DROP POLICY moss_legacy_select ON {table}; CREATE POLICY moss_legacy_select ON {table} FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (true)");
        let restore = format!("DROP POLICY moss_legacy_select ON {table}; CREATE POLICY moss_legacy_select ON {table} FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id())");
        w.f.rt.block_on(w.f.root.batch_execute(&weaken)).unwrap();
        let seen = rows_as(&w.f, b, &format!("SELECT 1 FROM {table}")).len();
        w.f.rt.block_on(w.f.root.batch_execute(&restore)).unwrap();
        assert!(seen > 0, "second person must see {table} without the rule");
        assert!(rows_as(&w.f, b, &format!("SELECT 1 FROM {table}")).is_empty());
        println!("PASS rls negative control: {table} check failed when weakened and passed after restore");
    }
    // Deleting a meal takes its estimate and foods with it and nothing else.
    run(&w, b, "meals.log.add", json!({"description":"other person's meal","idempotencyKey":"mark-1"}), true);
    let theirs = LOG_TABLES.map(|t| digest(&w, t, b));
    let gone = run(&w, a, "meals.log.delete", json!({"entryId":id}), true);
    assert_eq!(gone["body"]["data"]["deleted"], true, "{gone}");
    for table in LOG_TABLES {
        let left: i64 = w.f.rt.block_on(w.f.root.query_one(&format!("SELECT count(*) FROM {table} WHERE owner_user_id = '{a}'"), &[])).unwrap().get(0);
        assert_eq!(left, 0, "{table}");
    }
    assert_eq!(theirs, LOG_TABLES.map(|t| digest(&w, t, b)), "deleting changed the other person's log");
    let everywhere: i64 = w.f.rt
        .block_on(w.f.root.query_one("SELECT count(*) FROM moss_queue.jobs WHERE payload::text LIKE $1", &[&format!("%{MARK}%")]))
        .unwrap().get(0);
    assert_eq!(everywhere, 0);
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(&w.app.services.activity("meals", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!activity.contains(MARK));
    }
    println!("PASS log: owner-only with negative control on 3 tables, one job per meal with ids only, delete touched only the owner's rows, marker absent from jobs and activity");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_estimate_in_the_real_table_is_the_sum_of_its_foods_and_unknown_stays_null() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    let w = World::new();
    let a = w.f.a;
    run(&w, a, "meals.log.add", json!({"description":"wings and coke","idempotencyKey":"sum-1","consumedAt":"2026-11-10T12:00:00-08:00"}), true);
    w.answer(Some(estimated(vec![
        item("hot wings", json!("6"), json!(480.126), json!(1200)),
        item("Coke Zero", json!("32 oz"), json!(0), Value::Null),
    ])));
    w.run_jobs();
    let rows = rows_as(&w.f, a, "SELECT calories_kcal::text, sodium_mg::text, carbohydrates_g::text FROM app.meals_log_estimates");
    assert_eq!(rows.len(), 1);
    let kcal: String = rows[0].get(0);
    assert_eq!(kcal.parse::<f64>().unwrap(), 480.13, "stored to two places");
    assert_eq!(rows[0].get::<_, Option<String>>(1).as_deref().map(|s| s.parse::<f64>().unwrap()), Some(1200.0));
    let foods = rows_as(&w.f, a, "SELECT label, sodium_mg::text FROM app.meals_log_estimate_items ORDER BY item_index");
    assert_eq!(foods.len(), 2);
    assert!(foods[1].get::<_, Option<String>>(1).is_none(), "an unknown figure is stored as null, never zero");
    println!("PASS estimate storage: totals equal the foods, unknown stays null");
}
