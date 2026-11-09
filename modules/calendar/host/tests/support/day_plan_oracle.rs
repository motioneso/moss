use crate::support::Fixture;
use moss_module_host::application::Application;
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn javascript_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            *number = serde_json::Number::from_f64(number.as_f64().unwrap()).unwrap();
        }
        Value::Array(values) => values.iter_mut().for_each(javascript_numbers),
        Value::Object(values) => values.values_mut().for_each(javascript_numbers),
        _ => {}
    }
}

fn normalize(value: &mut Value, day: &str) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if key == "id" && item.is_string() {
                    *item = json!("PLAN-OR-BLOCK-ID");
                } else if key == "localDay" {
                    *item = json!("DAY");
                } else {
                    normalize(item, day);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(|item| normalize(item, day)),
        Value::String(text) if text == day => *value = json!("DAY"),
        _ => {}
    }
}

fn production(actor: &str, requests: Value) -> Vec<Value> {
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", "modules/calendar/tools/day-plan-oracle.ts"])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"actor": actor, "requests": requests})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "Production day-plan oracle failed (database diagnostics omitted)"
    );
    serde_json::from_slice(&result.stdout).unwrap()
}

fn installed(
    app: &Application,
    f: &Fixture,
    actor: &str,
    method: &str,
    path: &str,
    body: Value,
) -> Value {
    let raw = app
        .dispatch_extended(
            f.access(actor.parse().unwrap()),
            method,
            &format!("/api/m/calendar{path}"),
            &body.to_string(),
        )
        .unwrap();
    let actual: Value = serde_json::from_str(&raw).unwrap();
    json!({"status": actual["status"], "body": actual["body"]})
}

fn draft(day: &str, zone: &str, revision: u64) -> Value {
    json!({
        "date": day,
        "timeZone": zone,
        "expectedRevision": revision,
        "eveningIntent": {"notes": "Evening check"},
        "blocks": [{"kind": "focus", "title": "Deep work", "taskId": null}]
    })
}

/// The original create and draft-save contracts, run against the production
/// TypeScript routes and the installed Wasm package on the same database.
/// Each side uses its own day so generated plan ids never collide; ids and
/// the day itself are normalized before bodies are compared in full.
pub fn verify(app: &Application, f: &Fixture) {
    let mut comparisons = 0;
    let mut owner_plans: Option<(String, String)> = None;
    f.rt.block_on(async {
        for (actor, zone) in [(f.a, "Pacific/Auckland"), (f.b, "Europe/London")] {
            f.root.execute("INSERT INTO app.preferences(owner_user_id,key,value_json) VALUES($1,'locale',$2)", &[&actor, &json!({"timezone":zone})]).await.unwrap();
        }
    });
    for (actor, ts_day, rust_day, zone) in [
        (
            f.a.to_string(),
            "2026-12-14",
            "2026-12-15",
            "Pacific/Auckland",
        ),
        (f.b.to_string(), "2026-12-16", "2026-12-17", "Europe/London"),
        (
            f.admin.to_string(),
            "2026-12-18",
            "2026-12-19",
            "America/Los_Angeles",
        ),
    ] {
        for extra in [
            json!({"timeZone":null}),
            json!({"sourceRunId":""}),
            json!({"sourceRunId":"  "}),
        ] {
            let mut ts_body = json!({"date":ts_day});
            let mut rust_body = json!({"date":rust_day});
            for (key, value) in extra.as_object().unwrap() {
                ts_body[key] = value.clone();
                rust_body[key] = value.clone();
            }
            let expected = production(
                &actor,
                json!([{"method":"POST", "url":"/api/calendar/day-plans", "body":ts_body}]),
            );
            let actual = installed(app, f, &actor, "POST", "/day-plans", rust_body);
            assert_eq!(expected[0]["status"], 400);
            assert_eq!(actual["status"], expected[0]["status"]);
            comparisons += 1;
        }
        // Production sequence needs the created plan id before it can save.
        let created = production(
            &actor,
            json!([{"method": "POST", "url": "/api/calendar/day-plans", "body": {"date": ts_day}}]),
        );
        assert_eq!(created[0]["status"], 200, "production create failed");
        let ts_plan = created[0]["body"]["plan"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let expected = production(
            &actor,
            json!([
                {"method": "PATCH", "url": format!("/api/calendar/day-plans/{ts_plan}/draft"), "body": draft(ts_day, zone, 1)},
                {"method": "PATCH", "url": format!("/api/calendar/day-plans/{ts_plan}/draft"), "body": draft(ts_day, zone, 1)},
                {"method": "POST", "url": "/api/calendar/day-plans", "body": {"date": ts_day}}
            ]),
        );
        let mut actual_create = installed(
            app,
            f,
            &actor,
            "POST",
            "/day-plans",
            json!({"date": rust_day}),
        );
        assert_eq!(
            actual_create["status"], 200,
            "installed create rejected the original envelope"
        );
        assert_eq!(actual_create["body"]["plan"]["timeZone"], zone);
        let rust_plan = actual_create["body"]["plan"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        if actor == f.a.to_string() {
            owner_plans = Some((ts_plan.clone(), rust_plan.clone()));
        }
        let mut actual = vec![
            installed(
                app,
                f,
                &actor,
                "PATCH",
                &format!("/day-plans/{rust_plan}/draft"),
                draft(rust_day, zone, 1),
            ),
            installed(
                app,
                f,
                &actor,
                "PATCH",
                &format!("/day-plans/{rust_plan}/draft"),
                draft(rust_day, zone, 1),
            ),
            installed(
                app,
                f,
                &actor,
                "POST",
                "/day-plans",
                json!({"date": rust_day}),
            ),
        ];
        // Stale-revision rejections compare status only: the host sanitizes
        // guest error text, so error wording parity is not claimed.
        assert_eq!(expected[1]["status"], 409);
        assert_eq!(actual[1]["status"], 409);
        comparisons += 1;
        for (mut want, got) in expected
            .into_iter()
            .zip(actual.iter_mut())
            .enumerate()
            .filter(|(index, _)| *index != 1)
            .map(|(_, pair)| pair)
        {
            normalize(&mut want, ts_day);
            normalize(got, rust_day);
            javascript_numbers(&mut want);
            javascript_numbers(got);
            assert_eq!(
                got, &want,
                "Installed Wasm differs from production day-plan route"
            );
            comparisons += 1;
        }
        normalize(&mut actual_create, rust_day);
        let mut want_create = created[0].clone();
        normalize(&mut want_create, ts_day);
        javascript_numbers(&mut want_create);
        javascript_numbers(&mut actual_create);
        assert_eq!(
            actual_create, want_create,
            "Installed create differs from production"
        );
        comparisons += 1;
    }
    let (ts_plan, rust_plan) = owner_plans.unwrap();
    for actor in [f.b, f.admin] {
        let expected = production(
            &actor.to_string(),
            json!([{
                "method":"PATCH", "url":format!("/api/calendar/day-plans/{ts_plan}/draft"),
                "body":draft("2026-12-14", "Pacific/Auckland", 2)
            }]),
        );
        let foreign = installed(
            app,
            f,
            &actor.to_string(),
            "PATCH",
            &format!("/day-plans/{rust_plan}/draft"),
            draft("2026-12-15", "Pacific/Auckland", 2),
        );
        assert_eq!(expected[0]["status"], 404);
        assert_eq!(
            foreign["status"], expected[0]["status"],
            "foreign draft save was not refused"
        );
        let read = installed(
            app,
            f,
            &actor.to_string(),
            "GET",
            "/day-plan?date=2026-12-15&timeZone=Pacific%2FAuckland",
            Value::Null,
        );
        assert_eq!(read["status"], 200);
        assert!(read["body"]["plan"].is_null());
        comparisons += 1;
    }
    let unchanged = installed(
        app,
        f,
        &f.a.to_string(),
        "GET",
        "/day-plan?date=2026-12-15&timeZone=Pacific%2FAuckland",
        Value::Null,
    );
    assert_eq!(unchanged["body"]["plan"]["revision"], 2);
    assert_eq!(
        unchanged["body"]["plan"]["eveningIntent"]["notes"],
        "Evening check"
    );
    f.rt.block_on(async {
        f.root
            .execute(
                "DELETE FROM app.preferences WHERE key='locale' AND owner_user_id = ANY($1)",
                &[&vec![f.a, f.b]],
            )
            .await
            .unwrap();
    });
    println!("PASS {comparisons} installed-Wasm / production day-plan create, draft and foreign-write comparisons");
}
