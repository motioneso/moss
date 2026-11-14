mod common;
use common::both::Both;
use common::espn::{golden, ACTOR};
use moss_sports_module::{eastern, standings_views};
use serde_json::{json, Value};

/// 22:00 Eastern on 2026-11-12. The Bruins and Canadiens game started at 00:00 UTC on the 13th.
const EVENING: &str = "2026-11-13T03:00:00Z";

fn cards(body: &Value) -> Vec<Value> {
    body["followed"].as_array().cloned().unwrap_or_default()
}

#[test]
fn a_club_followed_in_two_competitions_shows_one_card() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("eng.1", "EVE", "368");
    host.follow("uefa.champions", "EVE", "368");
    let (status, body) = host.get("/overview", &[]);
    assert_eq!(status, 200);
    let list = cards(&body);
    assert_eq!(list.len(), 1, "{list:?}");
    // The league follow is the primary, so its competition names the card.
    assert_eq!(list[0]["competitionKey"], "eng.1");
    eprintln!("{}", list[0]);
    // A different club in the same competition is its own card.
    host.follow("eng.1", "BRE", "337");
    assert_eq!(cards(&host.get("/overview", &[]).1).len(), 2);
}

#[test]
fn a_follow_without_a_permanent_id_is_listed_and_never_matched() {
    let host = Both::new();
    host.at(EVENING);
    host.follows.seed_old_team(ACTOR, "eng.1", "EVE");
    let (_, body) = host.get("/overview", &[]);
    assert!(cards(&body).is_empty());
    assert_eq!(body["ambiguousFollows"].as_array().unwrap().len(), 1);
}

#[test]
fn evening_games_land_on_the_right_local_day_in_two_zones() {
    // Winter, Eastern Standard Time: 00:30 UTC is 19:30 the evening before.
    let winter = chrono::DateTime::parse_from_rfc3339("2026-11-13T00:30:00Z").unwrap().timestamp_millis();
    assert_eq!(eastern::day_of(winter), "2026-11-12");
    // Summer, Eastern Daylight Time: 02:30 UTC is 22:30 the evening before.
    let summer = chrono::DateTime::parse_from_rfc3339("2026-07-05T02:30:00Z").unwrap().timestamp_millis();
    assert_eq!(eastern::day_of(summer), "2026-07-04");
    // Daylight time begins 2026-03-08 at 07:00 UTC and ends 2026-11-01 at 06:00 UTC.
    let ms = |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis();
    assert_eq!(eastern::offset_hours(ms("2026-03-08T06:59:59Z")), 5);
    assert_eq!(eastern::offset_hours(ms("2026-03-08T07:00:00Z")), 4);
    assert_eq!(eastern::offset_hours(ms("2026-11-01T05:59:59Z")), 4);
    assert_eq!(eastern::offset_hours(ms("2026-11-01T06:00:00Z")), 5);
    // Midnight UTC is still the day before in Eastern, and 05:00 UTC in winter is the new day.
    assert_eq!(eastern::day_of(ms("2026-12-01T04:59:00Z")), "2026-11-30");
    assert_eq!(eastern::day_of(ms("2026-12-01T05:00:00Z")), "2026-12-01");
    // The overview asks ESPN for the Eastern day, not the UTC one.
    let host = Both::new();
    host.at(EVENING);
    host.get("/overview", &[]);
    let fetched = host.espn.fetched.borrow().join("\n");
    assert!(fetched.contains("dates=20261112"), "{fetched}");
    assert!(!fetched.contains("dates=20261113"), "{fetched}");
}

#[test]
fn day_arithmetic_crosses_month_and_year_edges() {
    assert_eq!(eastern::add_days("2026-12-31", 1), "2027-01-01");
    assert_eq!(eastern::add_days("2026-03-01", -1), "2026-02-28");
    assert_eq!(eastern::days_inclusive("2026-11-10", "2026-11-12"), vec!["2026-11-10", "2026-11-11", "2026-11-12"]);
}

#[test]
fn standings_views_split_conferences_and_keep_one_table_whole() {
    let nfl = golden("nfl-standings.json");
    let sections = moss_sports_module::espn_standings::parse_standings(&nfl)["sections"].as_array().cloned().unwrap();
    let views = standings_views::build_views(&sections);
    assert!(!views.is_empty(), "{views:?}");
    let eng = moss_sports_module::espn_standings::parse_standings(&golden("eng1-standings.json"))["sections"].as_array().cloned().unwrap();
    assert_eq!(standings_views::build_views(&eng).len(), 1);
}

#[test]
fn standings_route_refuses_an_unknown_competition_and_answers_a_known_one() {
    let host = Both::new();
    host.at(EVENING);
    assert_eq!(host.get("/standings", &[("competitionKey", "nope")]).0, 400);
    let (status, body) = host.get("/standings", &[("competitionKey", "nfl")]);
    assert_eq!(status, 200);
    assert!(body["group"]["sections"].is_array() || body["group"].is_object(), "{body}");
}

#[test]
fn no_follows_shows_the_default_slate() {
    let host = Both::new();
    host.at(EVENING);
    let (status, body) = host.get("/overview", &[]);
    assert_eq!(status, 200);
    assert!(cards(&body).is_empty());
    assert!(body["scoreboard"].as_array().is_some_and(|s| !s.is_empty()));
}

#[test]
fn a_second_person_never_sees_the_first_persons_clubs() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("nhl", "BOS", "1");
    assert_eq!(cards(&host.get("/overview", &[]).1).len(), 1);
    host.follows.as_actor(common::B);
    assert!(cards(&host.get("/overview", &[]).1).is_empty());
}

#[test]
fn follows_never_reach_the_public_cache_or_an_outgoing_address() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("nhl", "MARK-4f1c9b", "1");
    host.get("/overview", &[]);
    assert!(!host.espn.kv_text().contains("MARK-4f1c9b"));
    assert!(!host.espn.fetched.borrow().iter().any(|u| u.contains("MARK-4f1c9b")));
    for (port, op, _, params) in host.follows.calls.borrow().iter() {
        let sink = (port == "db" && op == "query") || op.starts_with("preference.");
        assert!(sink || !params.to_string().contains("MARK-4f1c9b"));
    }
}

#[test]
fn a_warm_overview_stays_inside_the_speed_budget() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("eng.1", "EVE", "368");
    host.follow("nhl", "BOS", "1");
    host.get("/overview", &[]);
    let fetches = host.espn.fetched.borrow().len();
    let mut times = vec![];
    for _ in 0..30 {
        let start = std::time::Instant::now();
        let (status, _) = host.get("/overview", &[]);
        times.push(start.elapsed().as_micros());
        assert_eq!(status, 200);
    }
    assert_eq!(host.espn.fetched.borrow().len(), fetches, "a warm read fetches nothing");
    times.sort();
    let p95 = times[(times.len() * 95 / 100).min(times.len() - 1)];
    assert!(p95 < 50_000, "p95 {p95} microseconds");
    eprintln!("overview native p95 {p95} microseconds");
}

#[test]
fn the_schedule_dataset_is_public_and_keyed_by_club() {
    let host = Both::new();
    host.at(EVENING);
    host.follow("eng.1", "EVE", "368");
    host.get("/overview", &[]);
    let kv = host.espn.kv.borrow();
    assert!(kv["espn-schedule"].to_string().contains("368"), "{}", kv["espn-schedule"]);
    let _ = json!(null);
}

fn strip_story_parts(body: &mut Value) {
    // Headlines, the gameday hero and story bodies are a later part, so parity leaves them out.
    if let Some(map) = body.as_object_mut() {
        for key in ["hero", "topStories", "leagueNews"] {
            map.remove(key);
        }
        for list in ["followed", "followedLeagueCards"] {
            for card in map.get_mut(list).and_then(Value::as_array_mut).into_iter().flatten() {
                card["stories"] = json!([]);
            }
        }
    }
}

/// The first place two answers differ, as a path, so a failure points at one field.
fn first_difference(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => x
            .keys()
            .chain(y.keys())
            .find_map(|k| first_difference(x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null), &format!("{path}.{k}"))),
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            x.iter().zip(y).enumerate().find_map(|(i, (p, q))| first_difference(p, q, &format!("{path}[{i}]")))
        }
        _ if a == b => None,
        _ => Some(format!("{path}: {a} vs {b}")),
    }
}

fn parity_follows(scenario: &str) -> Vec<(&'static str, Option<&'static str>, Option<&'static str>)> {
    match scenario {
        "two competitions and a hockey club" => vec![
            ("eng.1", Some("EVE"), Some("368")),
            ("uefa.champions", Some("EVE"), Some("368")),
            ("nhl", Some("BOS"), Some("1")),
            ("eng.1", Some("BRE"), Some("337")),
        ],
        "a football club with a standing line" => vec![("nfl", Some("DAL"), Some("6")), ("nfl", None, None)],
        "whole league and a follow without an id" => vec![("nhl", None, None), ("eng.1", Some("EVE"), None)],
        _ => vec![],
    }
}

#[test]
fn routes_match_the_old_handlers_on_recorded_answers() {
    let golden = golden("overview-routes.golden.json");
    let mut seen = 0;
    for step in golden.as_array().unwrap() {
        let host = Both::new();
        host.at(EVENING);
        for (n, (competition, key, id)) in parity_follows(step["scenario"].as_str().unwrap()).into_iter().enumerate() {
            host.follows.follows.borrow_mut().push(json!({
                "id": format!("00000000-0000-4000-8000-{n:012x}"), "owner_user_id": ACTOR,
                "competition_key": competition, "team_key": key, "source_team_id": id,
                "created_at": format!("2026-11-11T10:00:{n:02}.000+00:00"),
            }));
        }
        let url = step["url"].as_str().unwrap().strip_prefix("/api/sports").unwrap();
        let (path, query) = url.split_once('?').unwrap_or((url, ""));
        let pairs: Vec<(&str, &str)> = query.split('&').filter(|p| !p.is_empty()).map(|p| p.split_once('=').unwrap()).collect();
        let (status, mut body) = host.get(path, &pairs);
        let mut want = step["body"].clone();
        if path == "/overview" {
            strip_story_parts(&mut body);
            strip_story_parts(&mut want);
        }
        // The old server stamps the read with its own wall clock. The new one uses the host clock.
        if path == "/results/latest" && want["retrievedAt"].is_string() {
            assert_eq!(body["retrievedAt"], "2026-11-13T03:00:00.000Z");
            want["retrievedAt"] = body["retrievedAt"].clone();
        }
        assert_eq!(status as u64, step["status"].as_u64().unwrap(), "status of {url}");
        if let Some(difference) = first_difference(&body, &want, "") {
            panic!("{url} in {}: {difference}", step["scenario"]);
        }
        assert_eq!(body, want, "body of {} in {}", url, step["scenario"]);
        seen += 1;
    }
    assert_eq!(seen, 12);
}

#[test]
fn a_finished_match_with_a_minute_only_start_time_is_a_result() {
    let data = json!({"events": [{
        "id": "401", "date": "2026-11-12T00:30Z",
        "competitions": [{
            "status": {"type": {"completed": true, "state": "post", "name": "STATUS_FINAL", "detail": "Final"}},
            "competitors": [
                {"homeAway": "home", "score": "3", "team": {"id": "1", "displayName": "Home"}},
                {"homeAway": "away", "score": "2", "team": {"id": "2", "displayName": "Away"}}
            ]
        }]
    }]});
    let from = 1_794_000_000_000_i64;
    let to = from + 86_400_000 * 30;
    let found = moss_sports_module::espn_schedule::parse_completed_results(&data, "nhl", "1", from, to).unwrap();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0]["startsAt"], "2026-11-12T00:30:00.000Z");
}
