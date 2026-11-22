//! Calendar write-route proof shared by the installed Connectors live server.
use reqwest::{blocking::Client, Method};
use serde_json::{json, Value};
use std::{io::Write, process::Command};
use super::json_of;

pub fn routes(client: &Client, origin: &str, cookie: &str, runtime: &tokio::runtime::Runtime,
    bootstrap_url: &str, google_commands: &mut impl Write, log: impl Fn()->String,
    saved_events: impl Fn()->Vec<Value>) {
    let civil = |days: i64| {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        (yoe + era * 400 + i64::from(m <= 2), m, d)
    };
    let today = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        / 86_400;
    let (y, m, d) = civil(today + 1);
    let tomorrow = format!("{y:04}-{m:02}-{d:02}");
    let plan_call = |method: reqwest::Method, path: &str, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}/api/m/calendar{path}"))
            .header("origin", origin)
            .header("cookie", cookie);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap_or_else(|e| panic!("{path}: {e}\n{}", log()));
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        (status, json_of(&text))
    };
    let (status, created) = plan_call(Method::POST, "/day-plans", Some(json!({"date":tomorrow,"timeZone":"UTC"})));
    assert_eq!(status, 200, "{created}");
    let plan = created["plan"]["id"].as_str().unwrap().to_owned();
    let (status, saved) = plan_call(
        Method::PATCH,
        &format!("/day-plans/{plan}/draft"),
        Some(json!({
            "localDay": tomorrow, "timeZone": "UTC", "expectedRevision": 1,
            "blocks": [{
                "kind": "focus", "title": "Applied block proof",
                "pendingChange": {"kind":"add","startsAt":format!("{tomorrow}T14:00:00Z"),"durationMinutes":30}
            }]
        })),
    );
    assert_eq!(status, 200, "{saved}");
    let block = saved["plan"]["blocks"][0]["id"].as_str().unwrap().to_owned();
    let (status, applied) = plan_call(
        Method::POST,
        &format!("/day-plans/{plan}/apply"),
        Some(json!({"expectedRevision":2,"idempotencyKey":"live-apply-proof-1"})),
    );
    assert_eq!(status, 200, "{applied}");
    assert_eq!(applied["status"], "completed", "{applied}");
    assert_eq!(applied["items"][0]["outcome"], "applied", "{applied}");
    let event_id = applied["items"][0]["result"]["providerEventId"].as_str().unwrap().to_owned();
    assert!(event_id.starts_with("jap"), "{applied}");
    // The event is on the calendar: the cache mirror carries it with the
    // plan's own provider reference.
    let mirrored = saved_events()
        .iter()
        .find(|e| e["title"] == "Applied block proof")
        .unwrap_or_else(|| panic!("applied event missing: {:?}", saved_events()))
        .clone();
    assert_eq!(mirrored["externalId"], event_id.as_str());
    // A replayed idempotency key answers the stored result.
    let (status, replay) = plan_call(
        Method::POST,
        &format!("/day-plans/{plan}/apply"),
        Some(json!({"expectedRevision":2,"idempotencyKey":"live-apply-proof-1"})),
    );
    assert_eq!(status, 200, "{replay}");
    assert_eq!(replay["items"][0]["outcome"], "applied");
    assert_eq!(replay["items"][0]["result"]["providerEventId"], event_id.as_str());
    assert_eq!(
        saved_events().iter().filter(|e| e["title"] == "Applied block proof").count(),
        1,
        "a replay duplicated the event"
    );
    // The placed block is moved through the confirmed approval. A recorded
    // placement is never writable through a draft, so the pending move is
    // seeded straight onto the block row the plan itself placed: the move
    // may only patch an event this plan created, provenance included.
    runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(&bootstrap_url, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        let block_uuid = block.parse::<uuid::Uuid>().unwrap();
        db.execute(
            "UPDATE app.day_plan_blocks SET pending_change=$1 WHERE id=$2 AND plan_id=$3",
            &[&serde_json::json!({"kind":"move","startsAt":format!("{tomorrow}T15:30:00Z"),"durationMinutes":30}),
              &block_uuid, &plan.parse::<uuid::Uuid>().unwrap()],
        ).await.unwrap();
    });
    let (status, gated) = plan_call(
        Method::POST,
        &format!("/day-plans/{plan}/apply"),
        Some(json!({"expectedRevision":3,"idempotencyKey":"live-apply-proof-2","selectedBlockIds":[block]})),
    );
    assert_eq!(status, 202, "{gated}");
    assert_eq!(gated["status"], "confirmation-required", "{gated}");
    let approval = gated["approvalId"].as_str().unwrap().to_owned();
    let move_operation = gated["operationId"].as_str().unwrap().to_owned();
    let (status, confirmed) = plan_call(
        Method::POST,
        &format!("/day-plans/{plan}/operations/{move_operation}/confirm"),
        Some(json!({"approvalId": approval})),
    );
    assert_eq!(status, 200, "{confirmed}");
    assert_eq!(confirmed["status"], "completed", "{confirmed}");
    assert_eq!(confirmed["items"][0]["outcome"], "applied", "{confirmed}");
    let placed = saved_events()
        .iter()
        .find(|e| e["title"] == "Applied block proof")
        .unwrap()
        .clone();
    assert_eq!(placed["startsAt"], format!("{tomorrow}T15:30:00.000Z"), "{placed}");
    let (status, refused) = plan_call(
        Method::POST,
        &format!("/day-plans/{plan}/operations/{move_operation}/confirm"),
        Some(json!({"approvalId": approval})),
    );
    assert_eq!(status, 409, "{refused}");
    // A busy calendar refuses the addition; once it clears, retry applies it.
    // The placed block stays in the draft: a recorded placement is never
    // dropped implicitly.
    let (status, saved) = plan_call(
        Method::PATCH,
        &format!("/day-plans/{plan}/draft"),
        Some(json!({
            "localDay": tomorrow, "timeZone": "UTC", "expectedRevision": 4,
            "blocks": [{
                "id": block, "kind": "focus", "title": "Applied block proof"
            },
            {
                "kind": "focus", "title": "Second block proof",
                "pendingChange": {"kind":"add","startsAt":format!("{tomorrow}T10:00:00Z"),"durationMinutes":30}
            }]
        })),
    );
    assert_eq!(status, 200, "{saved}");
    let second_block = saved["plan"]["blocks"][1]["id"].as_str().unwrap().to_owned();
    let (status, refused_apply) = plan_call(
        Method::POST,
        &format!("/day-plans/{plan}/apply"),
        Some(json!({"expectedRevision":5,"idempotencyKey":"live-apply-proof-3","selectedBlockIds":[second_block]})),
    );
    assert_eq!(status, 200, "{refused_apply}");
    assert_eq!(refused_apply["status"], "denied", "{refused_apply}");
    assert!(
        refused_apply["denialReason"]
            .as_str()
            .unwrap()
            .starts_with("conflict: reserved additions overlap protected time"),
        "{refused_apply}"
    );
    // The denial wrote nothing: the item stays pending for a recover.
    assert_eq!(refused_apply["items"][0]["outcome"], "pending", "{refused_apply}");
    let busy_operation = refused_apply["operationId"].as_str().unwrap().to_owned();
    let busy_item = refused_apply["items"][0]["itemId"].as_str().unwrap().to_owned();
    {
        use std::io::Write;
        writeln!(google_commands, "remove-event Planning").unwrap();
        google_commands.flush().unwrap();
    }
    let (status, retried) = plan_call(
        Method::POST,
        &format!("/day-plans/{plan}/operations/{busy_operation}/recover"),
        Some(json!({})),
    );
    assert_eq!(status, 200, "{retried}");
    assert_eq!(retried["items"][0]["outcome"], "applied", "{retried}");
    assert!(retried["items"][0]["itemId"] == json!(busy_item), "{retried}");
    // A settled item is never re-executed: the retry route answers that the
    // selection is not eligible.
    let (status, ineligible) = plan_call(
        Method::POST,
        &format!("/day-plans/{plan}/operations/{busy_operation}/retry"),
        Some(json!({"itemIds":[busy_item]})),
    );
    assert_eq!(status, 409, "{ineligible}");
    assert_eq!(
        ineligible["error"],
        "day plan apply retry selection is not eligible"
    );
    assert!(
        saved_events().iter().any(|e| e["title"] == "Second block proof"),
        "the retried addition is on the calendar"
    );
    let (status, settled) = plan_call(Method::GET, &format!("/day-plans/{plan}/operations/{busy_operation}"), None);
    assert_eq!(status, 200, "{settled}");
    assert_eq!(settled["status"], "completed", "{settled}");
    // The owner reads the settled operation again through the status route.
    println!("PASS day-plan apply on the real server: apply, stored event, replay, confirm, denied conflict, recover and retry through the HTTPS routes; the row-security proofs live in the day_plan_apply suite");
}

pub fn review_browser(origin: &str, public: &str) {
    let Ok(script)=std::env::var("MOSS_CALENDAR_REVIEW_BROWSER_SCRIPT") else {return;};
    let out=std::env::var("MOSS_CONNECTORS_BROWSER_OUT").unwrap();
    let status=Command::new("timeout").args(["--kill-after=10","240","pnpm","exec","tsx",&script])
        .env("ORIGIN",origin).env("PUBLIC_ORIGIN",public)
        .env("EMAIL","connectors-owner@example.test")
        .env("PASSWORD","temporary-connectors-password-224-not-a-real-secret")
        .env("OUT",out).status().unwrap();
    assert!(status.success(),"Calendar review browser failed");
    if let Ok(seconds)=std::env::var("MOSS_CALENDAR_REVIEW_HOLD_SECONDS") {
        println!("REVIEW HOLD {origin} ({public}) for {seconds}s");
        std::thread::sleep(std::time::Duration::from_secs(seconds.parse().unwrap()));
    }

}
