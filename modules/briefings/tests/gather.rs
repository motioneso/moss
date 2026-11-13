mod common;
use common::*;
use moss_briefings_module::{
    external::{self, Contributors, Offer, MAX_DETAIL, MAX_HEADLINE, MAX_ITEMS, MAX_TITLE},
    gather::{gather, is_briefing_email, Gathered, CALENDAR, CHATS, COMMITMENTS, EMAIL, TASKS},
    gather_types::{COMPLETED_MARK, SECTION_CHAR_CAP, SECTION_ITEM_CAP},
    run_job::Deadline,
    compose::Subject,
    external::NoContributors,
};
use serde_json::{json, Value};

const DEFINITION: &str = "11111111-1111-4111-8111-111111111111";

fn tools(names: &[&str]) -> Vec<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

fn run(fake: &Fake, selected: &[&str]) -> Gathered {
    run_with(fake, selected, &NoContributors)
}

fn run_with<C: Contributors>(fake: &Fake, selected: &[&str], contributors: &C) -> Gathered {
    let selected = tools(selected);
    let deadline = Deadline::start(fake).unwrap();
    let subject = Subject { definition_id: DEFINITION, briefing_type: "morning", selected_tools: &selected, deadline: &deadline };
    gather(fake, &subject, contributors).expect("gathering never fails on a source")
}

fn gap(out: &Gathered, source: &str) -> Option<String> {
    out.gaps.iter().find(|g| g.source == source).map(|g| g.reason.as_str().to_owned())
}

fn reasons(out: &Gathered, source: &str) -> Vec<String> {
    out.gaps.iter().filter(|g| g.source == source).map(|g| g.reason.as_str().to_owned()).collect()
}

fn section<'a>(out: &'a Gathered, key: &str) -> &'a moss_briefings_module::gather_types::Section {
    out.sections.iter().find(|s| s.key == key).expect("section present")
}

fn mail(subject: &str, actionability: &str) -> Value {
    json!({"sender":"Sam","subject":subject,"receivedAt":"2026-11-11T08:00:00.000Z","snippet":"s","summary":"sum",
           "actionability":actionability,"importance":"normal","confidence":0.5,"awaitingJudgement":false,"answered":false})
}

#[test]
fn an_unreachable_source_is_a_gap_and_the_run_still_gathers() {
    let fake = Fake::new();
    fake.zone(A, "UTC");
    let out = run(&fake, &[TASKS, CALENDAR, EMAIL]);
    for source in ["tasks", "calendar", "email"] {
        assert_eq!(gap(&out, source).as_deref(), Some("tool_failed"), "{source}");
    }
    assert!(out.sections.iter().all(|s| s.lines.is_empty()));
}

#[test]
fn sources_not_built_yet_show_as_unwired_gaps() {
    let fake = Fake::new();
    let out = run(&fake, &[COMMITMENTS, CHATS]);
    assert_eq!(gap(&out, "commitments").as_deref(), Some("unwired"));
    assert_eq!(gap(&out, "chats").as_deref(), Some("unwired"));
    assert!(fake.api_calls.borrow().is_empty(), "nothing is read for an unbuilt source");
}

#[test]
fn only_selected_sources_are_read() {
    let fake = Fake::new();
    let out = run(&fake, &[CALENDAR]);
    assert!(out.sections.iter().all(|s| s.key == "calendar"));
    assert!(fake.api_calls.borrow().iter().all(|(_, m, n, _)| (m.as_str(), n.as_str()) == ("connectors", "listCalendarContext")));
}

#[test]
fn calendar_reads_through_the_connectors_call_and_formats_in_the_owner_zone() {
    let fake = Fake::new();
    fake.zone(A, "America/Chicago");
    fake.answer(A, "connectors", "listCalendarContext", Some(json!({
        "items":[{"title":"Standup","startsAt":"2026-11-11T15:00:00.000Z","endsAt":"2026-11-11T15:30:00.000Z","allDay":false}],
        "accounts":[{"account":{"connectorAccountId":"acc-1"},"source":"live"}],
        "gaps":[],"truncated":false
    })));
    let out = run(&fake, &[CALENDAR]);
    assert_eq!(section(&out, "calendar").lines, vec!["2026-11-11 09:00 · Standup"]);
    assert!(gap(&out, "calendar").is_none());
    let call = fake.api_calls.borrow()[0].clone();
    assert_eq!((call.1.as_str(), call.2.as_str()), ("connectors", "listCalendarContext"));
    assert_eq!(call.3["windowStart"], NOW);
}

#[test]
fn a_cut_short_calendar_answer_is_a_truncated_gap() {
    let fake = Fake::new();
    fake.answer(A, "connectors", "listCalendarContext", Some(json!({
        "items":[{"title":"One","startsAt":"2026-11-11T15:00:00.000Z"}],"accounts":[],"gaps":[],"truncated":true})));
    assert_eq!(gap(&run(&fake, &[CALENDAR]), "calendar").as_deref(), Some("truncated"));
}

#[test]
fn an_empty_calendar_is_an_empty_gap() {
    let fake = Fake::new();
    fake.answer(A, "connectors", "listCalendarContext", Some(json!({"items":[],"accounts":[],"gaps":[],"truncated":false})));
    assert_eq!(gap(&run(&fake, &[CALENDAR]), "calendar").as_deref(), Some("empty"));
}

#[test]
fn a_signed_out_account_is_a_source_auth_gap_and_cache_marks_the_run() {
    let fake = Fake::new();
    fake.answer(A, "connectors", "listEmailContext", Some(json!({
        "items":[mail("Please reply: contract","needs_reply")],
        "accounts":[{"account":{"connectorAccountId":"acc-1"},"source":"cache","degradedReason":"auth_error"}],
        "gaps":[{"account":{"connectorAccountId":"acc-2"},"reason":"connector_revoked"}],
        "truncated":false})));
    let out = run(&fake, &[EMAIL]);
    assert_eq!(gap(&out, "email").as_deref(), Some("source_auth"));
    assert!(out.degraded);
    assert_eq!(out.source_context["email"]["gaps"][0]["reason"], "connector_revoked");
}

#[test]
fn email_keeps_only_what_needs_the_person() {
    let fake = Fake::new();
    let mut answered = mail("Re: budget", "needs_reply");
    answered["answered"] = json!(true);
    let mut waiting_low = mail("Waiting on vendor", "waiting_on_someone");
    waiting_low["confidence"] = json!(0.3);
    let mut waiting_high = mail("Waiting on legal", "waiting_on_someone");
    waiting_high["importance"] = json!("high");
    let mut judged = mail("Maybe relevant", "fyi");
    judged["awaitingJudgement"] = json!(true);
    fake.answer(A, "connectors", "listEmailContext", Some(json!({
        "items":[mail("Please reply: contract","needs_reply"), answered, waiting_low, waiting_high, judged,
                 mail("Order confirmed #1","fyi"), mail("Newsletter","fyi")],
        "accounts":[],"gaps":[],"truncated":false})));
    let lines = section(&run(&fake, &[EMAIL]), "email").lines.clone();
    let text = lines.join("\n");
    for kept in ["contract", "Waiting on legal", "Maybe relevant"] {
        assert!(text.contains(kept), "{kept} kept");
    }
    for dropped in ["budget", "Waiting on vendor", "Order confirmed", "Newsletter"] {
        assert!(!text.contains(dropped), "{dropped} dropped");
    }
}

#[test]
fn a_confirmation_that_asks_for_action_is_kept() {
    assert!(!is_briefing_email(&mail("Order confirmed #9","fyi")));
    assert!(is_briefing_email(&mail("Order confirmed, payment due Friday","needs_action")));
    let mut asks = mail("Booking confirmed. Please confirm your seat","fyi");
    asks["awaitingJudgement"] = json!(true);
    assert!(is_briefing_email(&asks));
}

#[test]
fn a_section_holds_at_most_eight_lines_and_twelve_hundred_characters() {
    let fake = Fake::new();
    let events: Vec<Value> = (0..12).map(|i| json!({"title":format!("Event {i}"),"startsAt":"2026-11-11T15:00:00.000Z"})).collect();
    fake.answer(A, "connectors", "listCalendarContext", Some(json!({"items":events,"accounts":[],"gaps":[],"truncated":false})));
    let out = run(&fake, &[CALENDAR]);
    assert_eq!(section(&out, "calendar").lines.len(), SECTION_ITEM_CAP);
    assert_eq!(gap(&out, "calendar").as_deref(), Some("truncated"));

    let fake = Fake::new();
    let long = "x".repeat(700);
    let events: Vec<Value> = (0..3).map(|_| json!({"title":long,"startsAt":"2026-11-11T15:00:00.000Z"})).collect();
    fake.answer(A, "connectors", "listCalendarContext", Some(json!({"items":events,"accounts":[],"gaps":[],"truncated":false})));
    let out = run(&fake, &[CALENDAR]);
    let total: usize = section(&out, "calendar").lines.iter().map(|l| l.chars().count()).sum();
    assert!(total <= SECTION_CHAR_CAP, "{total}");
    assert_eq!(gap(&out, "calendar").as_deref(), Some("truncated"));
}

#[test]
fn source_text_is_escaped_and_cannot_carry_markup_or_sentinels() {
    let fake = Fake::new();
    fake.answer(A, "connectors", "listCalendarContext", Some(json!({
        "items":[{"title":"<script>alert(1)</script>   &  lunch","startsAt":"2026-11-11T15:00:00.000Z"}],
        "accounts":[],"gaps":[],"truncated":false})));
    let line = section(&run(&fake, &[CALENDAR]), "calendar").lines[0].clone();
    assert!(!line.contains('<') && !line.contains('>'), "{line}");
    assert!(line.contains("&lt;script&gt;") && line.contains("&amp; lunch"), "{line}");
}

fn open_task(id: &str, title: &str) -> Value {
    json!({"id":id,"title":title,"status":"todo","dueAt":null,"priority":null})
}

fn done_task(id: &str, title: &str) -> Value {
    json!({"id":id,"title":title,"status":"done","dueAt":null,"priority":null})
}

/// Teaches the two task reads. The fake answers one name, so this answers with a combined body
/// that the code under test must filter by status.
fn tasks_both(fake: &Fake, person: &str, items: Vec<Value>) {
    fake.answer(person, "tasks", "listBriefingTasks", Some(json!({"items": items})));
}

#[test]
fn tasks_keep_open_and_recently_done_and_cap_the_done_ones() {
    let fake = Fake::new();
    let mut items = vec![open_task("o1", "Write plan"), open_task("o2", "Pay rent")];
    items.extend((0..7).map(|i| done_task(&format!("d{i}"), &format!("Finished {i}"))));
    tasks_both(&fake, A, items);
    let out = run(&fake, &[TASKS]);
    let lines = &section(&out, "tasks").lines;
    assert_eq!(lines.iter().filter(|l| l.starts_with(COMPLETED_MARK)).count(), 5);
    assert!(lines.iter().any(|l| l.contains("Write plan")) && lines.iter().any(|l| l.contains("Pay rent")));
    assert_eq!(reasons(&out, "tasks"), vec!["truncated"]);
}

#[test]
fn done_tasks_are_asked_for_since_the_last_succeeded_run_or_a_day_back() {
    let fake = Fake::new();
    tasks_both(&fake, A, vec![]);
    run(&fake, &[TASKS]);
    let calls = fake.api_calls.borrow().clone();
    let done = calls.iter().find(|c| c.3["status"] == "done").expect("a done read");
    assert_eq!(done.3["completedAfter"], "2026-11-10T10:00:00.000Z");

    let fake = Fake::new();
    tasks_both(&fake, A, vec![]);
    fake.seed_run(DEFINITION, A, "r1", "2026-11-11T06:00:00.000Z", json!({}));
    run(&fake, &[TASKS]);
    let calls = fake.api_calls.borrow().clone();
    let done = calls.iter().find(|c| c.3["status"] == "done").unwrap();
    assert_eq!(done.3["completedAfter"], "2026-11-11T06:00:00.000Z");
}

struct Offers(Vec<(&'static str, &'static str, Option<Value>)>, std::cell::RefCell<Vec<String>>);
impl Contributors for Offers {
    fn offers(&self) -> Vec<Offer> {
        self.0.iter().map(|(m, t, _)| Offer { module_id: (*m).into(), tool_name: (*t).into(), sections: vec!["morning".into()] }).collect()
    }
    fn ask(&self, module_id: &str, _section: &str) -> Option<Value> {
        self.1.borrow_mut().push(module_id.to_owned());
        self.0.iter().find(|(m, _, _)| *m == module_id).and_then(|(_, _, a)| a.clone())
    }
}

#[test]
fn contributions_are_capped_cleaned_and_limited_to_in_app_links() {
    let items: Vec<Value> = (0..30)
        .map(|i| json!({"id":format!("i{i}"),"title":"t".repeat(300),"detail":"d".repeat(900),"href":if i == 0 {"/stocks/1"} else if i == 1 {"//evil.example/x"} else {"https://evil.example"}}))
        .collect();
    let answer = json!({"headline":"h".repeat(400),"items":items});
    let c = external::parse("stocks", &answer).expect("contribution");
    assert_eq!(c.items.len(), MAX_ITEMS);
    assert_eq!(c.headline.chars().count(), MAX_HEADLINE);
    assert!(c.items.iter().all(|i| i.title.chars().count() <= MAX_TITLE && i.detail.chars().count() <= MAX_DETAIL));
    assert_eq!(c.items[0].href.as_deref(), Some("/stocks/1"));
    assert_eq!(c.items[1].href, None);
    assert_eq!(c.items[2].href, None);
    assert!(external::parse("stocks", &json!({"headline":"  ","items":[]})).is_none());
}

#[test]
fn a_module_that_was_not_selected_is_never_asked() {
    let good = json!({"headline":"Markets","items":[{"id":"a","title":"A","detail":"B","href":"/x"}]});
    let offers = Offers(
        vec![("stocks", "stocks.briefing", Some(good.clone())), ("sports", "sports.briefing", Some(good))],
        Default::default(),
    );
    let fake = Fake::new();
    let out = run_with(&fake, &["stocks.briefing"], &offers);
    assert_eq!(offers.1.borrow().as_slice(), ["stocks"]);
    assert_eq!(out.contributions.len(), 1);
    assert_eq!(out.contributions[0].module_id, "stocks");
}

#[test]
fn only_the_owner_is_read_and_another_persons_answers_never_appear() {
    let fake = Fake::new();
    fake.answer(A, "connectors", "listCalendarContext", Some(json!({
        "items":[{"title":"A-private","startsAt":"2026-11-11T15:00:00.000Z"}],"accounts":[],"gaps":[],"truncated":false})));
    fake.answer(B, "connectors", "listCalendarContext", Some(json!({
        "items":[{"title":"B-private","startsAt":"2026-11-11T16:00:00.000Z"}],"accounts":[],"gaps":[],"truncated":false})));
    let text = |out: &Gathered| section(out, "calendar").lines.join("|");
    assert!(text(&run(&fake, &[CALENDAR])).contains("A-private"));
    fake.as_actor(B);
    let b = run(&fake, &[CALENDAR]);
    assert!(text(&b).contains("B-private") && !text(&b).contains("A-private"));
    assert!(fake.api_calls.borrow().iter().all(|c| c.3.get("ownerUserId").is_none() && c.3.get("userId").is_none()), "no call names a person");
}

#[test]
fn stored_metadata_carries_counts_and_reasons_never_source_text() {
    let fake = Fake::new();
    fake.answer(A, "connectors", "listCalendarContext", Some(json!({
        "items":[{"title":"SECRET-TITLE-9931","startsAt":"2026-11-11T15:00:00.000Z"}],"accounts":[],"gaps":[],"truncated":false})));
    let out = run(&fake, &[CALENDAR, TASKS]);
    let stored = out.metadata().to_string();
    assert!(!stored.contains("SECRET-TITLE-9931"), "{stored}");
    assert!(stored.contains("\"count\":1"));
}

#[test]
fn selected_sources_with_no_reader_show_unwired_gaps() {
    let fake = Fake::new();
    let g = run(&fake, &["news.topHeadlinesToday", "news.previewSource", "zzz.private-name", "goals.list", "vault"]);
    let gaps: Vec<_> = g.gaps.iter().map(|x| (x.source, x.reason.as_str())).collect();
    assert_eq!(gaps.iter().filter(|(s, _)| *s == "news").count(), 1);
    assert!(gaps.contains(&("news", "unwired")));
    assert!(gaps.contains(&("goals", "unwired")));
    assert!(gaps.contains(&("vault", "unwired")));
    // A name that is not a known source never reaches stored metadata.
    assert!(!gaps.iter().any(|(s, _)| *s == "zzz"));
}

#[test]
fn links_that_a_browser_could_read_as_another_site_are_dropped() {
    for bad in ["/\\evil.example/x", "/\tevil.example", "/a\nb"] {
        let raw = json!({"headline":"H","items":[{"id":"a","title":"A","detail":"B","href":bad}]});
        let c = moss_briefings_module::external::parse("m", &raw).unwrap();
        assert_eq!(c.items[0].href, None, "{bad}");
    }
}
