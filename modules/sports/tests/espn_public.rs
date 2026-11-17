mod common;
use common::espn::*;
use moss_module_sdk::RouteRequest;
use moss_sports_module::{catalog, datasets, espn, espn_games, espn_standings, roster};
use serde_json::{json, Value};

fn request(url: &str) -> RouteRequest {
    let rest = url.strip_prefix("/api/sports").unwrap();
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut params = std::collections::BTreeMap::new();
    let template = if let Some(key) = path.strip_prefix("/leagues/").and_then(|p| p.strip_suffix("/teams")) {
        params.insert("competition_key".to_owned(), key.to_owned());
        "/leagues/:competition_key/teams".to_owned()
    } else {
        path.to_owned()
    };
    let mut q = serde_json::Map::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = v.replace("%20", " ");
        q.insert(k.to_owned(), Value::String(v));
    }
    RouteRequest { method: "GET".into(), path: template, params, query: q.into_iter().collect(), body: Value::Null }
}

fn get(host: &EspnHost, url: &str) -> (u16, Value) {
    let r = moss_sports_module::route(host, request(url));
    (r.status, r.body)
}

#[test]
fn routes_match_the_old_handlers_step_by_step() {
    let host = EspnHost::new();
    let expected = golden("public-routes.golden.json");
    let steps: Vec<String> = serde_json::from_value(
        serde_json::from_str::<Value>(&fixture("public-routes.golden.json")).unwrap().as_array().unwrap()
            .iter().map(|s| s["url"].clone()).collect::<Vec<_>>().into(),
    )
    .unwrap();
    for (i, url) in steps.iter().enumerate() {
        let want = &expected[i];
        // The old server's router refuses an over-long path segment before any handler runs.
        if want["status"] == 404 {
            continue;
        }
        let (status, body) = get(&host, url);
        assert_eq!(status as u64, want["status"].as_u64().unwrap(), "status of step {i} {url}");
        assert_eq!(body, want["body"], "body of step {i} {url}");
    }
}

#[test]
fn parsers_match_the_old_reader_on_recorded_fixtures() {
    let want = golden("golden.json");
    let teams = |file: &str, key: &str| serde_json::to_value(espn::parse_teams(&golden(file), key)).unwrap();
    assert_eq!(teams("nfl-teams.json", "nfl"), want["teams-nfl"]);
    assert_eq!(teams("eng1-teams.json", "eng.1"), want["teams-eng.1"]);
    assert_eq!(teams("ncaa-baseball-teams-subset.json", "ncaa-baseball"), want["teams-ncaa-baseball"]);
    let games = |file: &str, key: &str| Value::Array(espn_games::parse_scoreboard(&golden(file), key).unwrap());
    assert_eq!(games("nfl-scoreboard.json", "nfl"), want["scoreboard-nfl"]);
    assert_eq!(
        games("eng1-scoreboard-20260104-everton-brentford.json", "eng.1"),
        want["scoreboard-eng.1"]
    );
    assert_eq!(games("nhl-scoreboard-20261112.json", "nhl"), want["scoreboard-nhl"]);
    for (file, name) in [
        ("nfl-standings.json", "standings-nfl"),
        ("eng1-standings.json", "standings-eng.1"),
        ("fifa-standings.json", "standings-fifa.world"),
        ("ncaaf-standings.json", "standings-ncaaf"),
    ] {
        assert_eq!(espn_standings::parse_standings(&golden(file)), want[name], "{name}");
    }
    let news = |file: &str, key: &str| Value::Array(espn::parse_headlines(&golden(file), key).unwrap());
    assert_eq!(news("nfl-news.json", "nfl"), want["headlines-nfl"]);
    assert_eq!(news("eng1-news.json", "eng.1"), want["headlines-eng.1"]);
}

#[test]
fn cached_datasets_answer_like_the_parsers_and_hit_the_cache() {
    let want = golden("golden.json");
    let host = EspnHost::new();
    let a = datasets::scoreboard(&host, "nfl", "2025-09-07").unwrap();
    assert_eq!((a.data, a.degraded), (want["scoreboard-nfl"].clone(), false));
    let s = datasets::standings(&host, "eng.1").unwrap();
    assert_eq!(s.data, want["standings-eng.1"]);
    let h = datasets::headlines(&host, "nfl", None).unwrap();
    assert_eq!(h.data, want["headlines-nfl"]);
    let before = host.fetched.borrow().len();
    datasets::scoreboard(&host, "nfl", "2025-09-07").unwrap();
    datasets::standings(&host, "eng.1").unwrap();
    datasets::headlines(&host, "nfl", None).unwrap();
    assert_eq!(host.fetched.borrow().len(), before, "second reads come from the cache");
    // The scoreboard entry expires after three minutes.
    host.now_ms.set(host.now_ms.get() + 4 * 60 * 1000);
    datasets::scoreboard(&host, "nfl", "2025-09-07").unwrap();
    assert_eq!(host.fetched.borrow().len(), before + 1);
}

#[test]
fn a_provider_failure_degrades_and_caches_nothing() {
    let host = EspnHost::new();
    host.down.set(true);
    let a = datasets::standings(&host, "nfl").unwrap();
    assert!(a.degraded);
    assert_eq!(a.data, json!({"sections": [], "season": null}));
    let (status, body) = get(&host, "/api/sports/leagues/nfl/teams");
    assert_eq!((status, body), (200, json!({"teams": [], "degraded": true})));
    assert!(host.kv.borrow().is_empty(), "a failure writes no cache");
    host.down.set(false);
    let (_, body) = get(&host, "/api/sports/leagues/nfl/teams");
    assert_eq!(body["degraded"], false);
}

#[test]
fn a_slow_search_stops_warming_once_its_time_budget_is_spent() {
    let host = EspnHost::new();
    host.fetch_ms.set(roster::SEARCH_WARM_BUDGET_MS + 1);
    let found = roster::search(&host, "ar").unwrap();
    assert!(found.partial);
    let leagues: std::collections::HashSet<String> = host
        .fetched
        .borrow()
        .iter()
        .map(|u| u.split("/teams?").next().unwrap().to_owned())
        .collect();
    assert_eq!(leagues.len(), 1, "one slow league spends the whole budget");
}

#[test]
fn a_league_still_being_read_gives_up_between_pages_once_the_time_is_spent() {
    let host = EspnHost::new();
    host.endless_pages.set(true);
    host.fetch_ms.set(1_500);
    let found = roster::search(&host, "team").unwrap();
    let pages = host.fetched.borrow().iter().filter(|u| u.contains("/teams?")).count();
    assert_eq!(pages, 3, "the walk stops after the third page passes three seconds");
    assert!(found.degraded && found.partial);
    assert!(host.kv.borrow().is_empty(), "an abandoned league caches nothing");
}

#[test]
fn search_makes_at_most_five_live_fetches_and_reports_partial() {
    let host = EspnHost::new();
    let found = roster::search(&host, "ar").unwrap();
    assert!(found.partial);
    let rosters = host.fetched.borrow().iter().filter(|u| u.contains("/teams?")).count();
    assert!(rosters >= 1 && rosters <= 5 + 4, "page walks may add pages but never a sixth league");
    let leagues: std::collections::HashSet<String> = host
        .fetched
        .borrow()
        .iter()
        .map(|u| u.split("/teams?").next().unwrap().to_owned())
        .collect();
    assert_eq!(leagues.len(), 5, "the brief caps uncached fetches at five");
    // Repeating the search warms five more leagues each time until none are left.
    let mut last = true;
    for _ in 0..20 {
        last = roster::search(&host, "ar").unwrap().partial;
        if !last {
            break;
        }
    }
    assert!(!last, "the cache fills and partial clears");
}

#[test]
fn search_results_are_capped_and_news_only_leagues_are_skipped() {
    let host = EspnHost::new();
    for _ in 0..20 {
        roster::search(&host, "ar").unwrap();
    }
    let found = roster::search(&host, "a").unwrap_or_else(|_| unreachable!());
    assert!(found.teams.len() <= roster::SEARCH_RESULT_CAP);
    for e in catalog::ENTRIES.iter().filter(|e| e.news_feed_url.is_some()) {
        let body = get(&host, &format!("/api/sports/leagues/{}/teams", e.key)).1;
        assert_eq!(body, json!({"teams": [], "degraded": false}), "{}", e.key);
    }
}

#[test]
fn the_cache_holds_nothing_personal() {
    let host = EspnHost::new();
    const MARK: &str = "planted-marker-9c2e";
    get(&host, &format!("/api/sports/teams/search?q={MARK}"));
    for _ in 0..3 {
        get(&host, "/api/sports/teams/search?q=ar");
    }
    get(&host, "/api/sports/leagues/eng.1/teams");
    datasets::standings(&host, "nfl").unwrap();
    assert!(!host.kv.borrow().is_empty());
    let stored = host.kv_text();
    assert!(!stored.contains(MARK) && !stored.contains(ACTOR), "cache holds no query or person");
    for url in host.fetched.borrow().iter() {
        assert!(!url.contains(MARK) && !url.contains(ACTOR), "{url}");
    }
    for (port, op, resource, params) in host.calls.borrow().iter() {
        assert!(["context", "kv", "fetch"].contains(&port.as_str()), "{port}");
        let sink = format!("{op}{resource}{params}");
        if port == "kv" {
            assert!(!sink.contains(MARK) && !sink.contains(ACTOR));
            assert!(["espn-teams", "espn-scoreboard", "espn-standings", "espn-headlines"].contains(&resource.as_str()));
        }
    }
}

#[test]
fn every_fetch_goes_to_an_allowed_host() {
    let host = EspnHost::new();
    roster::search(&host, "ar").unwrap();
    datasets::scoreboard(&host, "nfl", "2025-09-07").unwrap();
    datasets::standings(&host, "nfl").unwrap();
    datasets::headlines(&host, "nfl", Some("dal")).unwrap();
    for (port, _, resource, params) in host.calls.borrow().iter() {
        if port == "fetch" {
            assert!(espn::FETCH_HOSTS.contains(&resource.as_str()), "{resource}");
            assert!(params["url"].as_str().unwrap().starts_with(&format!("https://{resource}/")));
        }
    }
}

#[test]
fn catalog_lists_every_league_in_table_order() {
    let host = EspnHost::new();
    let (status, body) = get(&host, "/api/sports/catalog");
    assert_eq!(status, 200);
    let keys: Vec<&str> = body["competitions"].as_array().unwrap().iter().map(|c| c["competitionKey"].as_str().unwrap()).collect();
    let table: Vec<&str> = catalog::ENTRIES.iter().map(|e| e.key).collect();
    assert_eq!(keys, table);
    assert_eq!(keys.len(), 64);
    assert!(host.fetched.borrow().is_empty());
}
