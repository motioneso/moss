//! Proactive cards and usefulness feedback against the real database with row-level security.
//! Run only through the proactive feedback gate.
use access_context::AccessContext;
use moss_module_host::{
    proactive_cards::{self, Candidate, Placement},
    usefulness_feedback as feedback,
};
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use uuid::Uuid;

const MARKER: &str = "PLANTED-PRIVATE-TEXT-91af";
const OWNED_TABLES: [&str; 5] = [
    "app.proactive_cards",
    "app.proactive_monitor_state",
    "app.usefulness_feedback_signals",
    "app.usefulness_feedback_targets",
    "app.story_relevance_answer_cache",
];

/// Runs a handler as one person and commits only when it succeeded, like a real request.
macro_rules! call {
    ($rt:expr, $db:expr, $actor:expr, |$cx:ident| $body:expr) => {{
        $rt.block_on(async {
            let opened = DataContext::open(&$db, &AccessContext::new($actor, "proof")).await.unwrap();
            let result = {
                let $cx = &opened;
                $body.await
            };
            match result {
                Ok(reply) => {
                    opened.commit().await.unwrap();
                    reply
                }
                Err(error) => error.status_and_body(),
            }
        })
    }};
}

fn candidate(source: &str, key: &str, summary: &str) -> Candidate {
    Candidate {
        source: source.into(),
        stable_key: key.into(),
        source_ref_hash: format!("hash-{key}"),
        title: format!("Title {key}"),
        summary: summary.into(),
        signal_type: "task_due".into(),
        priority_band: "high".into(),
        priority_reasons: json!(["due soon"]),
        target_at: None,
        expires_at: None,
    }
}

#[test]
#[ignore = "Only through the proactive feedback gate"]
fn cards_and_feedback_follow_the_rules_privately() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (owner, other, admin) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let ts_user: Uuid = std::env::var("PF_TS_USER").unwrap().parse().unwrap();
    let ts_card: Uuid = std::env::var("PF_TS_CARD").unwrap().parse().unwrap();
    let bootstrap = rt.block_on(async {
        let (db, conn) = tokio_postgres::connect(&std::env::var("JS43_BOOTSTRAP_URL").unwrap(), tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        for (id, is_admin) in [(owner, false), (other, false), (admin, true)] {
            db.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Feedback proof',$3)",
                &[&id, &format!("{id}@example.test"), &is_admin],
            )
            .await
            .unwrap();
        }
        db
    });
    let database = rt
        .block_on(Database::connect(&std::env::var("JS43_APP_URL").unwrap(), 4, RuntimeRole::App))
        .unwrap();
    let sql = |q: &str| rt.block_on(bootstrap.batch_execute(q)).unwrap();
    let set_pref = |actor: Uuid, key: &str, value: Option<Value>| {
        rt.block_on(bootstrap.execute("DELETE FROM app.preferences WHERE owner_user_id=$1 AND key=$2", &[&actor, &key]))
            .unwrap();
        if let Some(v) = value {
            rt.block_on(bootstrap.execute(
                "INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,$2,$3)",
                &[&actor, &key, &v],
            ))
            .unwrap();
        }
    };
    let sources_on = json!({"enabled":true,"dailyCardCap":3});
    let proactive = |quiet: Value| {
        json!({"version":1,"enabled":true,
               "sources":{"tasks":sources_on,"calendar":sources_on,"email":sources_on,"notes":sources_on},
               "dailyCardCap":8,"quietHours":quiet,"updatedAt":"2026-01-01T00:00:00.000Z"})
    };
    let quiet_off = json!({"enabled":false,"startLocalTime":"22:00","endLocalTime":"08:00"});
    let quiet_on = json!({"enabled":true,"startLocalTime":"22:00","endLocalTime":"08:00"});
    set_pref(owner, "proactive.monitoring.v1", Some(proactive(quiet_off.clone())));
    let clear_cards = || sql("DELETE FROM app.proactive_cards WHERE owner_user_id IN (SELECT id FROM app.users WHERE name='Feedback proof')");
    let deferred_of = |id: Uuid| -> Option<String> {
        rt.block_on(bootstrap.query_one(
            "SELECT to_char(deferred_until AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM app.proactive_cards WHERE id=$1",
            &[&id],
        ))
        .unwrap()
        .get(0)
    };
    let place = |actor: Uuid, source: &str, key: &str, now: &str, summary: &str| -> Placement {
        rt.block_on(async {
            let cx = DataContext::open(&database, &AccessContext::new(actor, "proof")).await.unwrap();
            let placed = proactive_cards::place(&cx, &candidate(source, key, summary), now).await.unwrap();
            cx.commit().await.unwrap();
            placed
        })
    };

    // Cards follow quiet hours, in the person's zone, on fixed instants.
    let ny = |enabled: bool| json!({"enabled":enabled,"start":"22:00","end":"08:00","timezone":"America/New_York","authority":"canonical"});
    let fixtures: Vec<(&str, Option<Value>, Option<Value>, &str, Option<&str>)> = vec![
        ("inside the window", Some(ny(true)), None, "2026-03-10T03:30:00Z", Some("2026-03-10T12:00:00.000Z")),
        ("start is inclusive", Some(ny(true)), None, "2026-03-10T02:00:00Z", Some("2026-03-10T12:00:00.000Z")),
        ("end is exclusive", Some(ny(true)), None, "2026-03-10T12:00:00Z", None),
        ("daytime", Some(ny(true)), None, "2026-03-10T13:00:00Z", None),
        ("release crosses the clock change", Some(ny(true)), None, "2026-03-08T06:30:00Z", Some("2026-03-08T12:00:00.000Z")),
        ("schedule is off", Some(ny(false)), None, "2026-03-10T03:30:00Z", None),
        ("nothing saved", None, None, "2026-03-10T03:30:00Z", None),
        (
            "conflict falls back to the older alert schedule",
            Some(json!({"enabled":true,"start":"22:00","end":"08:00","authority":"unresolved"})),
            Some(json!({"timezone":"America/New_York"})),
            "2026-03-10T03:30:00Z",
            Some("2026-03-10T12:00:00.000Z"),
        ),
    ];
    for (n, (name, profile, locale, now, expected)) in fixtures.into_iter().enumerate() {
        clear_cards();
        set_pref(owner, "quiet-hours", profile);
        set_pref(owner, "locale", locale);
        set_pref(owner, "proactive.monitoring.v1", Some(proactive(if name.starts_with("conflict") { quiet_on.clone() } else { quiet_off.clone() })));
        let Placement::Placed { id, deferred } = place(owner, "tasks", &format!("fx{n}"), now, "plain") else {
            panic!("{name}: refused")
        };
        assert_eq!(deferred, expected.is_some(), "{name}");
        assert_eq!(deferred_of(id).as_deref(), expected, "{name}");
        println!("quiet-hours fixture ok: {name}");
    }

    // A card deferred past now stays off the list, and one outside the window is listed.
    clear_cards();
    set_pref(owner, "locale", None);
    let hours = |from: i32, to: i32| -> Value {
        let row = rt
            .block_on(bootstrap.query_one(
                "SELECT to_char(date_trunc('hour', now() AT TIME ZONE 'UTC') + ($1::int||' hours')::interval,'HH24:MI'),
                        to_char(date_trunc('hour', now() AT TIME ZONE 'UTC') + ($2::int||' hours')::interval,'HH24:MI')",
                &[&from, &to],
            ))
            .unwrap();
        json!({"enabled":true,"start":row.get::<_,String>(0),"end":row.get::<_,String>(1),"timezone":"UTC","authority":"canonical"})
    };
    let real_now: String = rt
        .block_on(bootstrap.query_one("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')", &[]))
        .unwrap()
        .get(0);
    set_pref(owner, "quiet-hours", Some(hours(-1, 2)));
    let Placement::Placed { deferred: held, .. } = place(owner, "tasks", "held", &real_now, "plain") else { panic!("refused") };
    assert!(held);
    set_pref(owner, "quiet-hours", Some(hours(2, 3)));
    let Placement::Placed { deferred: shown, .. } = place(owner, "calendar", "shown", &real_now, "plain") else { panic!("refused") };
    assert!(!shown);
    let (status, body) = call!(rt, database, owner, |cx| proactive_cards::list(cx, Some("5")));
    assert_eq!(status, 200);
    let keys: Vec<&str> = body["cards"].as_array().unwrap().iter().map(|c| c["stableKey"].as_str().unwrap()).collect();
    assert_eq!(keys, vec!["shown"], "only the card outside quiet hours is listed");
    println!("quiet-hours list check ok");

    // The placement limits: one card per source per hour, and a dismissed key stays quiet.
    let again = place(owner, "calendar", "shown-two", &real_now, "plain");
    assert_eq!(again, Placement::Refused("source_hourly_cap"));
    set_pref(owner, "quiet-hours", Some(ny(false)));
    clear_cards();

    // Feedback on a card: dismiss hides it and undo brings it back.
    let Placement::Placed { id: card, .. } = place(owner, "email", "k1", &real_now, "Short summary") else { panic!("refused") };
    let signal = json!({"targetKind":"proactive_card","targetRef":card.to_string(),"surface":"proactive","kind":"dismiss"});
    let (status, body) = call!(rt, database, owner, |cx| feedback::create(cx, &signal));
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["feedback"]["effectKind"], "proactive_card_dismissed");
    assert_eq!(body["feedback"]["sourceLabel"], "Email");
    let dismissal = body["feedback"]["id"].as_str().unwrap().to_owned();
    let (_, listed) = call!(rt, database, owner, |cx| proactive_cards::list(cx, None));
    assert_eq!(listed["cards"].as_array().unwrap().len(), 0);
    assert_eq!(place(owner, "email", "k1", &real_now, "again"), Placement::Refused("dismissed_stable_key_suppressed"));
    let (status, same) = call!(rt, database, owner, |cx| feedback::create(cx, &signal));
    assert_eq!((status, &same["feedback"]["id"]), (200, &body["feedback"]["id"]));
    let (status, undone) = call!(rt, database, owner, |cx| feedback::undo(cx, &dismissal));
    assert_eq!((status, undone["feedback"]["status"].as_str()), (200, Some("undone")));
    let (_, listed) = call!(rt, database, owner, |cx| proactive_cards::list(cx, None));
    assert_eq!(listed["cards"].as_array().unwrap().len(), 1, "undo brings the card back");
    let (status, again) = call!(rt, database, owner, |cx| feedback::undo(cx, &dismissal));
    assert_eq!((status, again["feedback"]["status"].as_str()), (200, Some("undone")));

    // Refusals match the old server.
    let bad = |v: Value| call!(rt, database, owner, |cx| feedback::create(cx, &v));
    assert_eq!(bad(json!({"targetKind":"proactive_card","targetRef":card.to_string(),"surface":"chat","kind":"dismiss"})).0, 400);
    assert_eq!(
        bad(json!({"targetKind":"proactive_card","targetRef":Uuid::new_v4().to_string(),"surface":"proactive","kind":"dismiss"})),
        (404, json!({"error":"Feedback target not found"}))
    );
    assert_eq!(
        bad(json!({"targetKind":"proactive_card","targetRef":card.to_string(),"surface":"proactive","kind":"remember_this"})),
        (400, json!({"error":"Feedback target cannot be remembered"}))
    );
    assert_eq!(call!(rt, database, owner, |cx| feedback::undo(cx, &Uuid::new_v4().to_string())), (404, json!({"error":"Feedback not found"})));

    // Story preferences: a rule is compiled, a flip supersedes, only a Less like this reason edits.
    sql(&format!(
        "INSERT INTO app.usefulness_feedback_targets(owner_user_id,target_kind,target_ref,surface,source_kind,source_label,metadata_json)
         VALUES('{owner}','news_story','story-1','news','news','News','{{\"topicRef\":\"topic-a\",\"headline\":\"dropped\"}}')"
    ));
    let story = |kind: &str, reason: Option<&str>| {
        let mut v = json!({"targetKind":"news_story","targetRef":"story-1","surface":"news","kind":kind});
        if let Some(r) = reason {
            v["reason"] = json!(r);
        }
        call!(rt, database, owner, |cx| feedback::create(cx, &v))
    };
    let (status, less) = story("less_like_this", Some(&format!("too much {MARKER} coverage")));
    assert_eq!(status, 201, "{less}");
    assert_eq!(less["feedback"]["metadata"], json!({"topicRef":"topic-a","headline":"dropped"}));
    assert_eq!(less["feedback"]["ruleVersion"], 1);
    let less_id = less["feedback"]["id"].as_str().unwrap().to_owned();
    let (status, edited) = call!(rt, database, owner, |cx| feedback::update_reason(cx, &less_id, &json!({"reason":"fewer repeats"})));
    assert_eq!((status, edited["feedback"]["revision"].clone()), (200, json!(2)));
    let (status, more) = story("more_like_this", None);
    assert_eq!(status, 201);
    let (_, all) = call!(rt, database, owner, |cx| feedback::list(cx, &[("module".into(), "news".into())]));
    let statuses: Vec<&str> = all["feedback"].as_array().unwrap().iter().map(|f| f["status"].as_str().unwrap()).collect();
    assert!(statuses.contains(&"superseded") && statuses.contains(&"active"), "{statuses:?}");
    let more_id = more["feedback"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        call!(rt, database, owner, |cx| feedback::update_reason(cx, &more_id, &json!({"reason":"x"}))),
        (400, json!({"error":"Only a Less like this reason can be edited"}))
    );
    assert_eq!(call!(rt, database, owner, |cx| feedback::update_reason(cx, &less_id, &json!({"reason":"x"}))).0, 404);
    assert_eq!(call!(rt, database, owner, |cx| feedback::undo(cx, "not-a-uuid")).0, 400);

    // A feedback signal changes nothing else: every other table is byte-identical afterward.
    let everything = |skip: &str| -> String {
        let tables = rt
            .block_on(bootstrap.query(
                "SELECT table_schema||'.'||table_name FROM information_schema.tables
                  WHERE table_type='BASE TABLE' AND table_schema IN ('app','moss_queue','moss_modules','spike_jobs')
                    AND table_schema||'.'||table_name <> $1 ORDER BY 1",
                &[&skip],
            ))
            .unwrap();
        let mut digest = String::new();
        for t in tables {
            let name: String = t.get(0);
            let h: String = rt
                .block_on(bootstrap.query_one(&format!("SELECT coalesce(md5(string_agg(x::text,'|' ORDER BY x::text)),'') FROM {name} x"), &[]))
                .unwrap()
                .get(0);
            digest.push_str(&format!("{name}={h};"));
        }
        digest
    };
    let before = everything("app.usefulness_feedback_signals");
    let record = json!({"targetKind":"proactive_card","targetRef":card.to_string(),"surface":"proactive","kind":"too_much"});
    let (status, _) = call!(rt, database, owner, |cx| feedback::signal(cx, &record));
    assert_eq!(status, 201);
    assert_eq!(before, everything("app.usefulness_feedback_signals"), "a signal must change no other table");
    println!("signal changed only the signals table");

    // A refresh queues a job that carries ids and a hashed key, never private text.
    set_pref(owner, "proactive.monitoring.v1", Some(proactive(quiet_off.clone())));
    let (status, queued) = call!(rt, database, owner, |cx| proactive_cards::refresh(cx, &["tasks".to_string()]));
    assert_eq!((status, queued["enqueued"].clone()), (202, json!(1)));
    let (_, queued) = call!(rt, database, owner, |cx| proactive_cards::refresh(cx, &[]));
    assert_eq!(queued["enqueued"], json!(0));
    let payload: Value = rt
        .block_on(bootstrap.query_one("SELECT data FROM spike_jobs.jobs WHERE queue='proactive-scan-source' ORDER BY created_at DESC LIMIT 1", &[]))
        .map(|r| r.get(0))
        .unwrap();
    assert!(!payload.to_string().contains("manual-refresh:"), "the idempotency key must be stored hashed: {payload}");

    // Private text sits only in the two owning tables.
    let secret_card = place(owner, "notes", "private", &real_now, &format!("note about {MARKER}"));
    assert!(matches!(secret_card, Placement::Placed { .. }));
    let scan = || {
        let tables = rt.block_on(bootstrap.query(
            "SELECT table_schema||'.'||table_name FROM information_schema.tables
              WHERE table_type='BASE TABLE' AND table_schema IN ('app','moss_queue','moss_modules','spike_jobs')
                AND table_schema||'.'||table_name NOT IN ('app.proactive_cards','app.usefulness_feedback_signals')", &[])).unwrap();
        for table in tables {
            let name: String = table.get(0);
            let count: i64 = rt.block_on(bootstrap.query_one(&format!("SELECT count(*) FROM {name} t WHERE t::text LIKE '%'||$1||'%'"), &[&MARKER])).unwrap().get(0);
            assert_eq!(count, 0, "the planted private text reached {name}");
        }
    };
    sql(&format!("UPDATE app.users SET name='{MARKER}' WHERE id='{other}'"));
    let leak = catch_unwind(AssertUnwindSafe(scan));
    sql(&format!("UPDATE app.users SET name='Feedback proof' WHERE id='{other}'"));
    assert!(leak.is_err(), "the scan must catch a planted leak");
    println!("privacy scan FAILED with a leak planted");
    scan();
    println!("privacy scan PASSED with no leak");
    let refusal = call!(rt, database, owner, |cx| feedback::create(cx, &json!({"targetKind":"news_story","targetRef":MARKER,"surface":"news","kind":"less_like_this","reason":MARKER})));
    assert_eq!(refusal.0, 404);
    assert!(!refusal.1.to_string().contains(MARKER), "{refusal:?}");

    // Isolation: another person and an admin see and change nothing of the owner's.
    let probe = |who: Uuid| -> usize {
        let mut seen = 0usize;
        for table in OWNED_TABLES {
            let count: i64 = call_raw(&rt, &database, who, table);
            seen += count as usize;
        }
        let (_, c) = call!(rt, database, who, |cx| proactive_cards::list(cx, Some("20")));
        let (_, f) = call!(rt, database, who, |cx| feedback::list(cx, &[]));
        seen + c["cards"].as_array().unwrap().len() + f["feedback"].as_array().unwrap().len()
    };
    let isolation = || {
        for stranger in [other, admin] {
            assert_eq!(probe(stranger), 0, "another account must see none of the owner's rows");
        }
        let target = json!({"targetKind":"proactive_card","targetRef":card.to_string(),"surface":"proactive","kind":"more_like_this"});
        assert_eq!(call!(rt, database, other, |cx| feedback::create(cx, &target)).0, 404);
        assert_eq!(call!(rt, database, other, |cx| feedback::undo(cx, &less_id)).0, 404);
        assert_eq!(call!(rt, database, other, |cx| feedback::update_reason(cx, &less_id, &json!({"reason":"x"}))).0, 404);
    };
    for table in ["app.proactive_cards", "app.usefulness_feedback_signals", "app.usefulness_feedback_targets", "app.proactive_monitor_state", "app.story_relevance_answer_cache"] {
        sql(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"));
    }
    let red = catch_unwind(AssertUnwindSafe(isolation));
    for table in ["app.proactive_cards", "app.usefulness_feedback_signals", "app.usefulness_feedback_targets", "app.proactive_monitor_state", "app.story_relevance_answer_cache"] {
        sql(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"));
    }
    assert!(red.is_err(), "the isolation check must fail with row security removed");
    println!("isolation assertion FAILED with row security removed");
    isolation();
    println!("isolation assertion PASSED with row security restored");

    // The old server's rows read back unchanged, and Rust writes are written out for it to read.
    let (_, cards) = call!(rt, database, ts_user, |cx| proactive_cards::list(cx, Some("20")));
    let (_, feedbacks) = call!(rt, database, ts_user, |cx| feedback::list(cx, &[]));
    let ts_story = json!({"targetKind":"news_story","targetRef":"ts-story","surface":"news","kind":"less_like_this","reason":"Fewer repeats of this please"});
    let (status, made) = call!(rt, database, ts_user, |cx| feedback::create(cx, &ts_story));
    assert_eq!(status, 201, "{made}");
    let ts_dismiss = json!({"targetKind":"proactive_card","targetRef":ts_card.to_string(),"surface":"today","kind":"dismiss"});
    let (status, dismissed) = call!(rt, database, ts_user, |cx| feedback::create(cx, &ts_dismiss));
    assert_eq!(status, 201, "{dismissed}");
    std::fs::write(
        std::env::var("PF_OUT").unwrap(),
        json!({"cards":cards["cards"],"feedback":feedbacks["feedback"],"createdStory":made["feedback"],"createdDismiss":dismissed["feedback"]}).to_string(),
    )
    .unwrap();

    // Deleting an account removes every owned row, including the ones the export does not list.
    for who in [owner] {
        sql(&format!("DELETE FROM app.users WHERE id='{who}'"));
    }
    for table in OWNED_TABLES {
        let left: i64 = rt
            .block_on(bootstrap.query_one(&format!("SELECT count(*) FROM {table} WHERE owner_user_id = '{owner}'"), &[]))
            .unwrap()
            .get(0);
        assert_eq!(left, 0, "{table} must be emptied when the account is deleted");
    }
    println!("account delete removed every owned row");
}

fn call_raw(rt: &tokio::runtime::Runtime, db: &Database, who: Uuid, table: &str) -> i64 {
    rt.block_on(async {
        let cx = DataContext::open(db, &AccessContext::new(who, "proof")).await.unwrap();
        let n: i64 = cx.db().query_one(&format!("SELECT count(*) FROM {table}"), &[]).await.unwrap().get(0);
        cx.commit().await.unwrap();
        n
    })
}
