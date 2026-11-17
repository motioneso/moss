//! Fixtures that run the same on the native and WebAssembly builds. Each failed check is named.

use crate::{feedback::*, proactive::*, rule};
use serde_json::{json, Value};

fn check(out: &mut Vec<String>, name: &str, ok: bool) {
    if !ok {
        out.push(name.to_owned());
    }
}

fn message(result: Result<Create, crate::Reject>) -> (u16, String) {
    let e = result.unwrap_err();
    (e.status, e.message)
}

/// The names of every fixture that fails. Empty means all pass.
pub fn failures() -> Vec<String> {
    let mut f = Vec::new();
    let story = json!({"targetKind":"news_story","targetRef":"news:abc","surface":"news","kind":"less_like_this","reason":"  too much football  "});
    let made = parse_create(&story).unwrap();
    check(
        &mut f,
        "reason is trimmed",
        made.reason.as_deref() == Some("too much football"),
    );
    let mut missing = story.clone();
    missing.as_object_mut().unwrap().remove("reason");
    check(
        &mut f,
        "less needs a reason",
        message(parse_create(&missing)) == (400, "Less like this needs a reason".into()),
    );
    let extra = json!({"targetKind":"proactive_card","targetRef":"x","surface":"today","kind":"dismiss","reason":"no"});
    check(
        &mut f,
        "reason refused elsewhere",
        message(parse_create(&extra)).1 == "This feedback action does not take a reason",
    );
    let stray = json!({"targetKind":"proactive_card","targetRef":"x","surface":"today","kind":"dismiss","other":1});
    check(
        &mut f,
        "unknown key refused",
        message(parse_create(&stray)).1 == "Usefulness feedback request is invalid",
    );
    check(&mut f, "long reason refused", message(parse_create(&json!({"targetKind":"news_story","targetRef":"n","surface":"news","kind":"less_like_this","reason":"a".repeat(501)}))).1 == "A reason cannot be longer than 500 characters");
    check(&mut f, "blank reason refused", message(parse_create(&json!({"targetKind":"news_story","targetRef":"n","surface":"news","kind":"less_like_this","reason":"   "}))).1 == "A reason cannot be empty");

    check(
        &mut f,
        "story takes only two kinds",
        !pair_allowed("news_story", "news", "dismiss")
            && pair_allowed("news_story", "today", "more_like_this"),
    );
    check(
        &mut f,
        "card surface pairs",
        pair_allowed("proactive_card", "today", "remember_this")
            && !pair_allowed("proactive_card", "news", "dismiss"),
    );
    check(
        &mut f,
        "record-only excludes effects",
        record_only("proactive_card", "today", "not_useful")
            && !record_only("proactive_card", "today", "dismiss")
            && !record_only("news_story", "news", "more_like_this"),
    );
    let signal =
        json!({"targetKind":"proactive_card","targetRef":"x","surface":"today","kind":"dismiss"});
    check(
        &mut f,
        "signal refuses dismiss",
        message(parse_signal(&signal)).1 == "Feedback target/action pair is not record-only",
    );
    check(
        &mut f,
        "reason body only",
        parse_reason_body(&json!({"reason":" ok "})).as_deref() == Ok("ok")
            && parse_reason_body(&json!({"reason":"ok","x":1})).is_err(),
    );

    let list = parse_list_query(&[
        ("module".into(), "sports".into()),
        ("status".into(), "active".into()),
    ])
    .unwrap();
    check(
        &mut f,
        "list filter",
        list.target_kind.as_deref() == Some("sports_story")
            && list.status.as_deref() == Some("active"),
    );
    check(
        &mut f,
        "list refuses unknown",
        parse_list_query(&[("x".into(), "1".into())]).is_err()
            && parse_list_query(&[("status".into(), "gone".into())]).is_err(),
    );

    let meta = sanitize_metadata(
        &json!({"label":"fine","secretKey":"x","Summary":"y","nested":{"rawText":"z","ok":1},"list":(0..30).collect::<Vec<_>>(),"long":"a".repeat(300)}),
    );
    check(
        &mut f,
        "metadata drops unsafe keys",
        meta.get("secretKey").is_none()
            && meta.get("Summary").is_none()
            && meta["nested"].get("rawText").is_none()
            && meta["nested"]["ok"] == 1,
    );
    check(
        &mut f,
        "metadata bounds",
        meta["list"].as_array().map(Vec::len) == Some(20)
            && meta["long"].as_str().map(str::len) == Some(200),
    );
    check(
        &mut f,
        "story metadata allow-list",
        sanitize_story_metadata(
            &json!({"headline":" A  B ","externalId":"1","isOpinion":true,"teamRef":""}),
        ) == json!({"headline":"A B","isOpinion":true}),
    );

    let rule = rule::compile(
        "sports",
        "less",
        "sports:1",
        &json!({"teamRef":"Arsenal","competitionRef":"epl"}),
        Some("Stop showing the transfer rumours please"),
    );
    check(
        &mut f,
        "rule terms",
        rule["terms"] == json!(["arsenal", "epl", "transfer", "rumours"]) && rule["version"] == 1,
    );
    check(
        &mut f,
        "rule recompile",
        rule::needs_recompile(&json!({}), Some(1))
            && rule::needs_recompile(&rule, None)
            && !rule::needs_recompile(&rule, Some(1)),
    );

    // The preference, refresh planning and limits.
    let none = Saved::Missing;
    check(
        &mut f,
        "email on when nothing saved",
        source_enabled(&none, "email") && !source_enabled(&none, "tasks"),
    );
    check(
        &mut f,
        "malformed email off",
        !source_enabled(&Saved::Malformed, "email"),
    );
    let on = saved_from(Some(
        &json!({"version":1,"enabled":true,"sources":{"tasks":{"enabled":true}}}),
    ));
    check(
        &mut f,
        "tasks follow master and source",
        source_enabled(&on, "tasks") && !source_enabled(&on, "notes"),
    );
    check(
        &mut f,
        "bad cap is malformed",
        saved_from(Some(&json!({"version":1,"dailyCardCap":99}))) == Saved::Malformed,
    );
    check(
        &mut f,
        "legacy email choice kept",
        !source_enabled(
            &saved_from(Some(&json!({"version":1,"enabled":true}))),
            "email",
        ),
    );
    let registered: Vec<String> = ["tasks", "notes", "email"].map(String::from).to_vec();
    let plan = plan_refresh(
        &on,
        &registered,
        &|s| (s == "email").then_some(0),
        1_000_000_000_000,
        "u1",
    );
    check(
        &mut f,
        "refresh skips off, unregistered and recent",
        plan.len() == 1
            && plan[0].source == "tasks"
            && plan[0].idempotency_key == "manual-refresh:u1:tasks:1111111",
    );
    check(
        &mut f,
        "limit parse",
        [
            Some("7"),
            Some("99"),
            Some("0"),
            Some("-3"),
            Some("x"),
            None,
        ]
        .map(parse_limit)
            == [7, 20, 5, 5, 5, 5],
    );

    let counts = Counts {
        total_today: 1,
        source_today: 1,
        source_last_hour: 0,
    };
    let pref: Value = effective(&none);
    check(
        &mut f,
        "placement allowed",
        placement_refusal(false, &counts, &pref, "tasks").is_none(),
    );
    check(
        &mut f,
        "dismissed key held",
        placement_refusal(true, &counts, &pref, "tasks") == Some("dismissed_stable_key_suppressed"),
    );
    check(
        &mut f,
        "caps held",
        placement_refusal(
            false,
            &Counts {
                total_today: 8,
                ..counts
            },
            &pref,
            "tasks",
        ) == Some("global_daily_cap")
            && placement_refusal(
                false,
                &Counts {
                    source_today: 3,
                    total_today: 1,
                    source_last_hour: 0,
                },
                &pref,
                "tasks",
            ) == Some("source_daily_cap")
            && placement_refusal(
                false,
                &Counts {
                    source_last_hour: 1,
                    total_today: 1,
                    source_today: 1,
                },
                &pref,
                "tasks",
            ) == Some("source_hourly_cap"),
    );
    f
}
