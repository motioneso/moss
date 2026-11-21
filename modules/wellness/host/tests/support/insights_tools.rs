//! Part 16 proofs through the installed component: insights, both chat tools and consent.
use super::*;

const TOOL_MARK: &str = "INSIGHT-MARKER-5ae2d7";
const RECENT: &str = "wellness.recentCheckIns";
const ADHERENCE: &str = "wellness.medicationAdherence";

fn run(w: &World, actor: uuid::Uuid, tool: &str) -> Value {
    w.app.services.approve_tool(&w.f.access(actor), "wellness", tool, &json!({})).unwrap();
    w.call(actor, "POST", "/wellness/tools/run", json!({"tool":tool,"parameters":{}}))
}

/// The same check-ins for one person, dated back from now so every run reads the same shape.
fn fill(w: &World, actor: uuid::Uuid, note: &str) {
    let days = [28, 26, 21, 19, 14, 12, 7, 5, 3, 2, 1];
    let cores = ["sad", "happy", "sad", "happy", "anger", "happy", "sad", "happy", "sad", "happy", "happy"];
    for (n, (day, core)) in days.iter().zip(cores).enumerate() {
        let (day, intensity, text): (i32, i16, Option<&str>) = (*day, 1 + (n as i16 % 5), if n % 2 == 0 { Some(note) } else { None });
        w.f.rt
            .block_on(w.f.root.execute(
                "INSERT INTO app.wellness_checkins(owner_user_id,checked_in_at,feeling_core,intensity,note,local_date) \
                 VALUES($1, now() - ($2::int * interval '1 day'), $3::text::app.wellness_emotion_core, $4, $5, to_char((now() - ($2::int * interval '1 day')) AT TIME ZONE 'UTC','YYYY-MM-DD'))",
                &[&actor, &day, &core, &intensity, &text],
            ))
            .unwrap();
    }
}

fn same(mut a: Value, mut b: Value) {
    replay::mask(&mut a);
    replay::mask(&mut b);
    assert_eq!(a, b);
}

#[test]
#[ignore = "Only through verify-gate"]
fn insights_and_both_tools_match_the_old_code() {
    let w = World::new();
    let (old, new) = (w.add_user(), w.add_user());
    fill(&w, old, "a note");
    fill(&w, new, "a note");
    let med = json!({"method":"POST","url":"/api/wellness/medications","body":{"name":"Daily","frequencyType":"once_daily","timesPerDay":1,"scheduleTimes":["08:00"]}});
    replay::old_routes(old, &[med.clone()], &json!({}));
    assert_eq!(w.call(new, "POST", "/wellness/medications", med["body"].clone())["status"], 201);
    for tool in [RECENT, ADHERENCE] {
        let theirs = run(&w, new, tool);
        assert_eq!(theirs["status"], 200, "{theirs}");
        same(theirs["body"].clone(), replay::old_tool(old, tool, json!({}), true));
    }
    let items = run(&w, new, RECENT)["body"]["data"]["items"].as_array().unwrap().len();
    assert_eq!(items, 11);
    // With the choice off, the new answer is the old refusal and holds nothing private.
    assert_eq!(w.call(new, "PUT", "/wellness/ai-consent", json!({"granted":false}))["status"], 200);
    for tool in [RECENT, ADHERENCE] {
        let refused = run(&w, new, tool);
        same(refused["body"].clone(), replay::old_tool(old, tool, json!({}), false));
        assert_eq!(refused["body"], json!({"data":{"error":"Consent not granted","code":"WELLNESS_CONSENT_REQUIRED"}}));
    }
    // The insights route is not gated by the choice in the old code, so it stays open.
    let steps = [json!({"method":"GET","url":"/api/wellness/insights"})];
    run_both(&w, old, new, &steps, &json!({}), &json!({}));
    let lines = w.call(new, "GET", "/wellness/insights", json!(null))["body"]["insights"].as_array().unwrap().len();
    assert!(lines >= 3, "the fixtures must produce insight lines");
    // Input the old tools never took is refused before the host runs anything.
    let bad = w.call(new, "POST", "/wellness/tools/run", json!({"tool":RECENT,"parameters":{"limit":3}}));
    assert_eq!(bad["status"], 400);
    println!("PASS part16 parity: {lines} insight lines, both tools and the consent-off refusal match the old code");
}

#[test]
#[ignore = "Only through verify-gate"]
fn tools_and_insights_keep_private_text_in_the_owner_and_out_of_logs() {
    let w = World::new();
    let (a, b) = (w.f.a, w.f.b);
    fill(&w, a, TOOL_MARK);
    let seen = run(&w, a, RECENT);
    assert!(seen.to_string().contains(TOOL_MARK), "the owner reads the note");
    // The second person and the admin read nothing, through the tools or the route.
    for actor in [b, w.f.admin] {
        assert_eq!(run(&w, actor, RECENT)["body"]["data"]["items"], json!([]));
        assert_eq!(w.call(actor, "GET", "/wellness/insights", json!(null))["body"], json!({"insights":[]}));
        assert!(!run(&w, actor, ADHERENCE).to_string().contains(TOOL_MARK));
    }
    // With the owner rule removed the second person reads the rows. The rule is put back.
    set_policy(&w, "wellness_checkins", "wellness_checkins_select", "true");
    let weakened = run(&w, b, RECENT);
    let weakened_insights = w.call(b, "GET", "/wellness/insights", json!(null));
    set_policy(&w, "wellness_checkins", "wellness_checkins_select", OWNER_ONLY);
    assert!(weakened.to_string().contains(TOOL_MARK), "without the policy the tool must leak");
    assert!(!weakened_insights["body"]["insights"].as_array().unwrap().is_empty());
    assert_eq!(run(&w, b, RECENT)["body"]["data"]["items"], json!([]));
    // With consent off the owner gets no private value from either tool.
    w.call(a, "PUT", "/wellness/ai-consent", json!({"granted":false}));
    for tool in [RECENT, ADHERENCE] {
        assert!(!run(&w, a, tool).to_string().contains(TOOL_MARK));
    }
    assert_eq!(mentions(&w, TOOL_MARK), 0, "note text reached a queue row or a log");
    for actor in [a, b, w.f.admin] {
        let activity = serde_json::to_string(&w.app.services.activity("wellness", &w.f.access(actor)).unwrap()).unwrap();
        assert!(!activity.contains(TOOL_MARK), "activity holds note text");
    }
    println!("PASS part16 privacy: other people read nothing, the policy removal leaks, consent off returns nothing, and note text is in no job, activity row or log");
}

#[test]
#[ignore = "Only through verify-gate"]
fn chat_reads_use_the_installed_tools_and_respect_consent() {
    let w = World::new();
    let access = w.f.access(w.f.a);
    fill(&w, w.f.a, "A saved check-in");
    assert_eq!(w.app.installer.chat_tools(&access).unwrap().len(), 2);
    let recent = w.app.installer.run_chat_tool(&access, "wellness", RECENT, json!({})).unwrap();
    assert_eq!(recent["data"]["items"].as_array().unwrap().len(), 11);
    assert_eq!(w.call(w.f.a, "PUT", "/wellness/ai-consent", json!({"granted":false}))["status"], 200);
    for name in [RECENT, ADHERENCE] {
        let answer = w.app.installer.run_chat_tool(&access, "wellness", name, json!({})).unwrap();
        assert_eq!(answer["data"]["code"], "WELLNESS_CONSENT_REQUIRED");
    }
}
