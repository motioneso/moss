mod common;
use common::both::Both;
use common::{team, Teams, A, B};
use moss_sports_module::tools;
use serde_json::{json, Value};

/// 22:00 Eastern on 2026-11-12. The Bruins and Canadiens game started at 00:00 UTC on the 13th.
const EVENING: &str = "2026-11-13T03:00:00Z";

fn teams() -> Teams {
    Teams(vec![("nhl".into(), vec![team("bos", Some("BOS"), "Boston Bruins", Some("1")), team("mtl", Some("MTL"), "Montreal Canadiens", Some("10"))])])
}

fn call(host: &Both, tool: &str, parameters: Value, version: Option<&str>) -> Value {
    let payload = json!({"tool":tool,"parameters":parameters,"approvalVersion":version});
    tools::run(host, &teams(), &payload.to_string()).unwrap()
}

fn pre(host: &Both) {
    *host.espn.hockey_state.borrow_mut() = Some("pre");
}

fn facts(host: &Both, zone: &str) -> Value {
    call(host, "sports.followedFactsToday", json!({"timeZone":zone}), None)["data"].clone()
}

#[test]
fn a_finished_game_reads_the_same_in_the_facts_and_the_overview() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("nhl", "BOS", "1");
    let data = facts(&host, "America/New_York");
    assert_eq!(data["facts"][0]["text"], "Boston Bruins lost 2\u{2013}5 vs Canadiens.");
    assert_eq!(data["evidence"]["state"], "finals");
    let card = &host.get("/overview", &[]).1["followed"][0];
    assert_eq!(card["primary"], "L 2\u{2013}5 vs Canadiens");
    assert_eq!(card["todayGameState"], "final");
    assert_eq!(data["evidence"]["games"][0]["id"], "401892696");
    assert_eq!(data["evidence"]["games"][0]["homeScore"], 2.0);
}

#[test]
fn a_game_is_tonight_or_upcoming_by_the_persons_own_day() {
    let host = Both::new();
    host.follow("nhl", "BOS", "1");
    pre(&host);
    // 10:00 UTC on the 12th. The game starts at 00:00 UTC on the 13th.
    host.at("2026-11-12T10:00:00Z");
    assert_eq!(facts(&host, "UTC")["evidence"]["state"], "quiet");
    // Where it is already the 13th, the same game is later today.
    let far = facts(&host, "Pacific/Kiritimati");
    assert_eq!(far["evidence"]["state"], "tonight");
    assert_eq!(far["evidence"]["games"][0]["phase"], "tonight");
    // A name that is not a zone reads as UTC.
    assert_eq!(facts(&host, "nonsense")["evidence"]["state"], "quiet");
}

#[test]
fn a_live_game_wins_and_shows_the_score() {
    let host = Both::new();
    host.follow("nhl", "BOS", "1");
    *host.espn.hockey_state.borrow_mut() = Some("in");
    host.at("2026-11-13T00:30:00Z");
    let data = facts(&host, "America/New_York");
    assert_eq!(data["facts"][0]["text"], "Boston Bruins play now: Canadiens 5 \u{2013} 2 Bruins.");
    assert_eq!(data["evidence"]["state"], "live");
}

#[test]
fn a_followed_league_and_a_person_with_no_follows_both_get_facts() {
    let host = Both::new();
    host.at(EVENING);
    host.follows.follows.borrow_mut().push(json!({
        "id": "00000000-0000-4000-8000-000000000001", "owner_user_id": common::espn::ACTOR, "competition_key": "nhl",
        "team_key": null, "source_team_id": null, "created_at": "2026-11-11T10:00:00.000+00:00",
    }));
    let league = facts(&host, "America/New_York");
    assert_eq!(league["facts"][0]["text"], "3 NHL games play today.");
    host.follows.follows.borrow_mut().clear();
    let slate = facts(&host, "America/New_York");
    assert_eq!(slate["evidence"]["ambiguousFollowCount"], 0);
    assert_eq!(slate["evidence"]["version"], 1);
}

#[test]
fn a_provider_outage_gives_a_degraded_empty_answer_and_never_an_error() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("nhl", "BOS", "1");
    host.espn.down.set(true);
    let data = facts(&host, "UTC");
    assert_eq!(data["facts"], json!([]));
    assert_eq!(data["evidence"]["degraded"], true);
    assert_eq!(data["evidence"]["state"], "unknown");
}

#[test]
fn the_heartbeat_reads_only_the_cache_and_never_the_provider() {
    let host = Both::new();
    host.follow("nhl", "BOS", "1");
    pre(&host);
    host.at("2026-11-12T20:00:00Z");
    let cold = call(&host, "sports.heartbeatNextFixtures", json!({}), None)["data"].clone();
    assert_eq!((cold["freshness"].as_str(), cold["items"].as_array().map(Vec::len)), (Some("unknown"), Some(0)));
    assert!(host.espn.fetched.borrow().is_empty(), "the heartbeat fetched {:?}", host.espn.fetched.borrow());
    // Someone loads the overview, which fills the shared cache.
    host.get("/overview", &[]);
    let warm = call(&host, "sports.heartbeatNextFixtures", json!({}), None)["data"].clone();
    assert_eq!(warm["freshness"], "fresh");
    let item = &warm["items"][0];
    assert_eq!(item["entityKey"], "fixture:nhl:401892696");
    assert_eq!(item["episodeKey"], "fixture:nhl:401892696:2026-11-13T00:00Z");
    assert_eq!(warm["nextBoundaryAt"], "2026-11-13T00:00:00.000Z");
    // The same list gives the same revision, and a shorter horizon drops the fixture.
    let again = call(&host, "sports.heartbeatNextFixtures", json!({}), None)["data"].clone();
    assert_eq!(again["revision"], warm["revision"]);
    let short = call(&host, "sports.heartbeatNextFixtures", json!({"horizonHours":1}), None)["data"].clone();
    assert_eq!(short["items"], json!([]));
    assert_ne!(short["revision"], warm["revision"]);
    // The cache expires after three minutes. An expired board still reads, marked stale.
    host.at("2026-11-12T20:10:00Z");
    let old = call(&host, "sports.heartbeatNextFixtures", json!({}), None)["data"].clone();
    assert_eq!(old["freshness"], "stale");
    assert_eq!(old["items"].as_array().unwrap().len(), 1);
}

#[test]
fn the_heartbeat_refuses_anything_beyond_its_two_numbers() {
    let host = Both::new();
    host.at(EVENING);
    for bad in [json!({"limit":0}), json!({"limit":21}), json!({"horizonHours":49}), json!({"limit":1.5}), json!({"userId":"x"}), json!({"limit":"3"})] {
        let reply = call(&host, "sports.heartbeatNextFixtures", bad.clone(), None);
        assert_eq!(reply["data"]["error"], "Invalid Sports tool input", "{bad}");
    }
    assert_eq!(call(&host, "sports.heartbeatNextFixtures", json!({"limit":20,"horizonHours":48.0}), None)["data"]["source"], "sports");
}

#[test]
fn the_latest_result_tool_matches_the_route() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("nhl", "BOS", "1");
    let (status, via_route) = host.get("/results/latest", &[("teamName", "Boston Bruins")]);
    assert_eq!(status, 200);
    let tool = call(&host, "sports.latestResult", json!({"teamName":"Boston Bruins"}), None);
    assert_eq!(tool["data"], via_route);
    let bad = call(&host, "sports.latestResult", json!({"teamName":"x","nope":1}), None);
    assert_eq!(bad["data"]["error"], "Invalid Sports tool input");
}

fn rows(host: &Both) -> Vec<Value> {
    host.follows.follows.borrow().clone()
}

#[test]
fn following_saves_what_the_route_saves_and_needs_no_approval() {
    let host = Both::new();
    let done = call(&host, "sports.followTeam", json!({"competitionKey":"nhl","teamKey":"bos"}), None);
    assert_eq!(done["data"]["follow"]["teamKey"], "BOS", "{done}");
    let other = Both::new();
    let (_, via_route) = other.follows.route_with(&teams(), "POST", "/follows", &[], json!({"competitionKey":"nhl","teamKey":"bos"}));
    let (mine, theirs) = (&rows(&host)[0], &rows(&other)[0]);
    for column in ["competition_key", "team_key", "source_team_id"] {
        assert_eq!(mine[column], theirs[column], "{column}");
    }
    assert_eq!(done["data"]["follow"]["teamKey"], via_route["follow"]["teamKey"]);
    // The same follow twice is one row, as the route keeps it.
    call(&host, "sports.followTeam", json!({"competitionKey":"nhl","teamKey":"bos"}), None);
    assert_eq!(rows(&host).len(), 1);
}

#[test]
fn follow_refusals_match_the_route_and_save_nothing() {
    let host = Both::new();
    for (input, message) in [
        (json!({"competitionKey":"nope"}), "Unknown competition: nope"),
        (json!({"competitionKey":"nhl","teamKey":"zzz"}), "Unknown team: zzz"),
        (json!({"competitionKey":"NHL"}), "competitionKey must match pattern \"^[a-z0-9.]{1,100}$\""),
        (json!({}), "Provide a competitionKey to follow."),
    ] {
        assert_eq!(call(&host, "sports.followTeam", input.clone(), None)["data"]["error"], message, "{input}");
    }
    assert!(rows(&host).is_empty());
}

#[test]
fn a_whole_league_can_be_followed_and_unfollowed() {
    let host = Both::new();
    assert!(call(&host, "sports.followTeam", json!({"competitionKey":"nhl"}), None)["data"]["follow"]["teamKey"].is_null());
    assert_eq!(rows(&host).len(), 1);
    assert_eq!(call(&host, "sports.unfollowTeam", json!({"competitionKey":"nhl"}), None)["data"]["removed"], true);
    assert!(rows(&host).is_empty());
}

#[test]
fn follow_unfollow_follow_always_agree_and_unfollowing_nothing_is_a_no_op() {
    let host = Both::new();
    let input = json!({"competitionKey":"nhl","teamKey":"bos"});
    assert_eq!(call(&host, "sports.unfollowTeam", input.clone(), None)["data"]["removed"], false);
    assert_eq!(call(&host, "sports.followTeam", input.clone(), None)["data"]["follow"]["teamKey"], "BOS");
    assert_eq!(rows(&host).len(), 1);
    assert_eq!(call(&host, "sports.unfollowTeam", input.clone(), None)["data"]["removed"], true);
    assert!(rows(&host).is_empty());
    assert_eq!(call(&host, "sports.followTeam", input.clone(), None)["data"]["follow"]["teamKey"], "BOS");
    assert_eq!(rows(&host).len(), 1);
    assert_eq!(call(&host, "sports.unfollowTeam", json!({"competitionKey":"nope"}), None)["data"]["error"], "Unknown competition: nope");
}

#[test]
fn another_person_cannot_unfollow_your_team_and_the_test_fails_without_the_owner_rule() {
    let host = Both::new();
    host.follow("nhl", "BOS", "1");
    let input = json!({"competitionKey":"nhl","teamKey":"bos"});
    host.at(EVENING);
    let mine = facts(&host, "UTC");
    host.follows.as_actor(B);
    assert_eq!(call(&host, "sports.unfollowTeam", input.clone(), None)["data"]["removed"], false);
    assert_eq!(rows(&host).len(), 1, "the other person's follow is still there");
    // Their facts hold nothing of yours.
    host.at(EVENING);
    let theirs = facts(&host, "UTC");
    assert_ne!(theirs["facts"], mine["facts"], "B's facts differ from A's");
    let lines: Vec<&str> = theirs["facts"].as_array().unwrap().iter().filter_map(|f| f["text"].as_str()).collect();
    assert!(!lines.is_empty() && lines.iter().all(|l| l.ends_with("on the slate.")), "B sees only the default slate: {lines:?}");

    // With the owner rule off, the same call removes your follow. That is what the rule prevents.
    host.follows.rls_off.set(true);
    assert_eq!(call(&host, "sports.unfollowTeam", input, None)["data"]["removed"], true);
    assert!(rows(&host).is_empty());
}

#[test]
fn private_text_never_reaches_anything_but_the_database_and_the_public_cache() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("nhl", "BOS", "1");
    facts(&host, "America/New_York");
    call(&host, "sports.heartbeatNextFixtures", json!({}), None);
    call(&host, "sports.followTeam", json!({"competitionKey":"nhl","teamKey":"mtl"}), None);
    for (port, _, resource, _) in host.follows.calls.borrow().iter().chain(host.espn.calls.borrow().iter()) {
        assert!(!matches!(port.as_str(), "queue" | "jobs" | "activity" | "log" | "notify"), "{port} {resource}");
    }
    let everything = format!("{:?}{:?}", host.espn.kv.borrow(), host.espn.fetched.borrow());
    assert!(!everything.contains(common::espn::ACTOR), "the person's id reached the public cache or a fetch");
    assert!(!everything.contains("00000000-0000-4000-8000-0000"), "a follow id reached the public cache or a fetch");
}
