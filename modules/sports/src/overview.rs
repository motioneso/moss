//! `GET /overview` and `GET /standings`: the followed cards, scoreboards and standings for the
//! signed-in person. Every ESPN read goes through the install-wide cache, and nothing here writes
//! a person's data anywhere but the response.
//!
//! Stories come from ESPN's league and club feeds, limited to what the person's coverage allows.
//! The gameday slides, top stories, league news and the one featured story body are composed here.
//! Stories from custom sources and catalog feeds, and the less-of-this filter, are not part of it.
use crate::espn::TeamRef;
use crate::followed::{self, Bundle, Follow};
use crate::identity::{self, Saved, Team};
use crate::{article, catalog, datasets, eastern, espn_coverage, follows, gameday, news_scope, public_cache as cache, roster, story};
use moss_module_sdk::{query::{Filter, Order, Query}, Client, Host, Response, Result, RouteRequest};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Shown when the person follows nothing, so the page is never empty.
const DEFAULT_SLATE: [&str; 5] = ["nfl", "nba", "nhl", "mlb", "eng.1"];
const FIXTURE_DAYS_BEFORE: i64 = -3;
const FIXTURE_DAYS_AFTER: i64 = 4;

fn follow_of(row: &Value) -> Result<Follow> {
    let dto = follows::dto(row)?;
    let text = |k: &str| dto[k].as_str().map(str::to_owned);
    Ok(Follow {
        id: text("id").unwrap_or_default(),
        competition_key: text("competitionKey").unwrap_or_default(),
        team_key: text("teamKey"),
        source_team_id: text("sourceTeamId"),
        created_at: text("createdAt").unwrap_or_default(),
    })
}

/// The person's follows, newest first, as row level security hands them over.
fn load_follows<H: Host + ?Sized>(host: &H) -> Result<Vec<Follow>> {
    let mut query = Query::select(Filter::All);
    query.order = vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ];
    Client(host).query(follows::TABLE, &query)?.iter().map(follow_of).collect()
}

fn label_of(key: &str) -> String {
    catalog::entry(key).map(|e| e.label.to_owned()).unwrap_or_else(|| key.to_owned())
}

/// Games for every Eastern day in `from..=to`, one cached read per day, deduped by event id.
fn scoreboard_for_days<H: Host + ?Sized>(host: &H, key: &str, from: &str, to: &str, degraded: &mut bool) -> Result<Vec<Value>> {
    let mut seen: Vec<String> = vec![];
    let mut games = vec![];
    for day in eastern::days_inclusive(from, to) {
        let answer = datasets::scoreboard(host, key, &day)?;
        *degraded |= answer.degraded;
        for game in answer.data.as_array().cloned().unwrap_or_default() {
            let id = game["id"].as_str().unwrap_or_default().to_owned();
            if !id.is_empty() {
                if seen.contains(&id) {
                    continue;
                }
                seen.push(id);
            }
            games.push(game);
        }
    }
    Ok(games)
}

struct PerCompetition {
    scoreboard: Vec<Value>,
    standings: Value,
    teams: Vec<TeamRef>,
    headlines: Vec<Value>,
}

const HERO_FEED_GAMES: usize = 3;

fn url_of(headline: &Value) -> String {
    let raw = headline["url"].as_str().unwrap_or_default();
    story::canonical_url(raw).unwrap_or_else(|| raw.to_owned())
}

fn unique(keys: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for k in keys {
        if !out.contains(&k) {
            out.push(k);
        }
    }
    out
}

fn season_is_active(season: &Value, now_ms: i64) -> bool {
    let bound = |k: &str| season[k].as_str().and_then(followed::instant_ms);
    matches!((bound("start"), bound("end")), (Some(s), Some(e)) if now_ms >= s && now_ms <= e)
}

fn ambiguous(follow: &Follow, teams: &[TeamRef]) -> Value {
    let list: Vec<Team> = teams
        .iter()
        .map(|t| Team {
            team_key: t.team_key.clone(),
            abbreviation: t.abbreviation.clone(),
            name: t.name.clone(),
            source_team_id: t.source_team_id.clone(),
        })
        .collect();
    let resolved = identity::resolve(&Saved { team_key: follow.team_key.as_deref(), source_team_id: None }, &list);
    let candidates: Vec<Value> = resolved
        .candidates
        .iter()
        .filter_map(|c| {
            let id = c.source_team_id.as_deref()?;
            let crest = teams.iter().find(|t| t.source_team_id.as_deref() == Some(id)).and_then(|t| t.crest_url.clone());
            Some(json!({"sourceTeamId": id, "name": c.name, "crestUrl": crest}))
        })
        .collect();
    json!({
        "followId": follow.id, "competitionKey": follow.competition_key, "savedTeamKey": follow.team_key,
        "candidates": candidates, "teamListLoaded": resolved.team_list_loaded,
    })
}

pub fn overview<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let now_ms = cache::now_ms(host)?;
    let now_iso = chrono::DateTime::from_timestamp_millis(now_ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let mut degraded = false;
    let mut feeds = datasets::Feeds::open(host)?;
    let follows: Vec<Follow> = load_follows(host)?.into_iter().filter(|f| catalog::entry(&f.competition_key).is_some()).collect();
    let today = eastern::day_of(now_ms);
    let day_before = eastern::add_days(&today, -1);
    let keys = if follows.is_empty() {
        DEFAULT_SLATE.iter().map(|k| (*k).to_owned()).collect()
    } else {
        unique(follows.iter().map(|f| f.competition_key.clone()))
    };
    let followed_leagues: Vec<&Follow> = follows.iter().filter(|f| f.team_key.is_none()).collect();
    let coverage = espn_coverage::get(host).unwrap_or_else(|_| {
        degraded = true;
        json!({"enabled": false, "usesDefaultCoverage": false, "assignments": []})
    });
    // A tournament followed only by its clubs reads those clubs' feeds and not the whole tournament feed.
    let team_only: Vec<&String> = keys
        .iter()
        .filter(|k| {
            catalog::entry(k).is_some_and(|e| e.kind == "tournament")
                && !followed_leagues.iter().any(|f| &f.competition_key == *k)
                && follows.iter().any(|f| &f.competition_key == *k && f.team_key.is_some())
        })
        .collect();

    let mut per: HashMap<String, PerCompetition> = HashMap::new();
    for key in &keys {
        if catalog::entry(key).is_some_and(|e| e.news_feed_url.is_some()) {
            per.insert(key.clone(), PerCompetition { scoreboard: vec![], standings: json!({"sections": [], "season": null}), teams: vec![], headlines: vec![] });
            continue;
        }
        let scoreboard = scoreboard_for_days(host, key, &day_before, &today, &mut degraded)?;
        let standings = datasets::standings(host, key)?;
        degraded |= standings.degraded;
        let teams = roster::league_teams(host, key)?;
        degraded |= teams.degraded;
        let wanted = news_scope::competition(key);
        let headlines = if !team_only.contains(&key) && wanted.is_some_and(|w| news_scope::allows(&coverage, &follows, &w)) {
            let answer = feeds.headlines(host, key, None)?;
            degraded |= answer.degraded;
            story::resolve_team_keys(answer.data.as_array().cloned().unwrap_or_default(), &teams.teams)
        } else {
            vec![]
        };
        per.insert(key.clone(), PerCompetition { scoreboard, standings: standings.data, teams: teams.teams, headlines });
    }
    let sections_of = |key: &str| per.get(key).and_then(|p| p.standings["sections"].as_array().cloned()).unwrap_or_default();

    // A follow with no permanent id is kept out of every match and reported instead.
    let mut active: Vec<&Follow> = vec![];
    let mut ambiguous_follows = vec![];
    for follow in follows.iter().filter(|f| f.team_key.is_some()) {
        if follow.source_team_id.is_some() {
            active.push(follow);
        } else {
            ambiguous_follows.push(ambiguous(follow, per.get(&follow.competition_key).map(|p| p.teams.as_slice()).unwrap_or(&[])));
        }
    }

    let mut bundles: HashMap<String, Bundle> = HashMap::new();
    for follow in &active {
        let id = follow.source_team_id.clone().unwrap_or_default();
        let comp = per.get(&follow.competition_key);
        let schedule = datasets::schedule(host, &follow.competition_key, &id)?;
        degraded |= schedule.degraded;
        let team = comp.and_then(|c| c.teams.iter().find(|t| t.source_team_id.as_deref() == Some(id.as_str())).cloned());
        let mut headlines = comp.map(|c| c.headlines.clone()).unwrap_or_default();
        // The league feed rarely files a story under a club, so the club's own feed is merged in for its card.
        let club_feed = follow.team_key.as_deref().and_then(|t| news_scope::team(&follow.competition_key, t));
        if club_feed.is_some_and(|w| news_scope::allows(&coverage, &follows, &w)) {
            let answer = feeds.headlines(host, &follow.competition_key, Some(&id))?;
            degraded |= answer.degraded;
            let teams = comp.map(|c| c.teams.as_slice()).unwrap_or(&[]);
            for headline in story::resolve_team_keys(answer.data.as_array().cloned().unwrap_or_default(), teams) {
                headlines = story::merge_scope(headlines, headline);
            }
        }
        bundles.insert(
            follow.id.clone(),
            Bundle {
                follow: (*follow).clone(),
                team,
                match_id: id,
                scoreboard: comp.map(|c| c.scoreboard.clone()).unwrap_or_default(),
                standings: sections_of(&follow.competition_key),
                schedule: schedule.data.as_array().cloned().unwrap_or_default(),
                headlines,
            },
        );
    }
    // The gameday slides depend only on scoreboards and follows, so their clubs' feeds join the pools first.
    let bundle_list: Vec<&Bundle> = active.iter().filter_map(|f| bundles.get(&f.id)).collect();
    let slides = gameday::games(&bundle_list, now_ms);
    let mut by_comp: HashMap<String, Vec<Value>> = per.iter().map(|(k, p)| (k.clone(), p.headlines.clone())).collect();
    for slide in slides.iter().take(HERO_FEED_GAMES) {
        let game = &slide["game"];
        let comp = game["competitionKey"].as_str().unwrap_or_default().to_owned();
        let teams = per.get(&comp).map(|p| p.teams.as_slice()).unwrap_or(&[]);
        let mut merged = by_comp.get(&comp).cloned().unwrap_or_default();
        for side in [&game["home"], &game["away"]] {
            let Some(team_key) = side["teamKey"].as_str() else { continue };
            if !news_scope::team(&comp, team_key).is_some_and(|w| news_scope::allows(&coverage, &follows, &w)) {
                continue;
            }
            let id = side["sourceTeamId"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| teams.iter().find(|t| t.team_key == team_key).and_then(|t| t.source_team_id.clone()));
            let answer = feeds.headlines(host, &comp, Some(id.as_deref().unwrap_or(team_key)))?;
            degraded |= answer.degraded;
            for headline in story::resolve_team_keys(answer.data.as_array().cloned().unwrap_or_default(), teams) {
                merged = story::merge_scope(merged, headline);
            }
        }
        by_comp.insert(comp, merged);
    }
    for key in &team_only {
        let mine: Vec<&&Bundle> = bundle_list.iter().filter(|b| &b.follow.competition_key == *key).collect();
        let followed_keys: HashSet<&str> = mine.iter().filter_map(|b| b.team.as_ref().map(|t| t.team_key.as_str())).collect();
        let mut kept: Vec<Value> = by_comp
            .get(*key)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|h| h["origin"] == "custom" || h["teamKeys"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|k| followed_keys.contains(k)))
            .collect();
        for bundle in &mine {
            let Some(team) = &bundle.team else { continue };
            for headline in story::about_team(&bundle.headlines, &team.team_key) {
                kept = story::merge_scope(kept, headline.clone());
            }
        }
        by_comp.insert((*key).clone(), kept);
    }

    let active_owned: Vec<Follow> = active.iter().map(|f| (*f).clone()).collect();
    let cards: Vec<Value> = followed::group_follows(&active_owned).iter().map(|g| followed::build_card(g, &bundles, now_ms, &now_iso)).collect();

    let followed_pairs: HashSet<String> = bundle_list
        .iter()
        .filter_map(|b| b.team.as_ref().map(|t| format!("{}:{}", b.follow.competition_key, t.team_key)))
        .collect();
    let groups = story::compose_groups(&keys, &|k| by_comp.get(k).cloned().unwrap_or_default());
    let ranked = story::rank_top_stories(&groups, &followed_pairs);
    // A story already on a followed card is shown there and not again in the hero.
    let on_cards: HashSet<String> = cards
        .iter()
        .flat_map(|c| c["stories"].as_array().into_iter().flatten().map(|s| story::canonical_url(s["url"].as_str().unwrap_or_default()).unwrap_or_else(|| s["url"].as_str().unwrap_or_default().to_owned())))
        .collect();
    let top: Vec<&Value> = ranked.iter().filter(|h| !on_cards.contains(&url_of(h))).collect();
    let ranked_urls: HashSet<String> = ranked.iter().map(url_of).collect();
    let hero = if slides.is_empty() {
        json!({"mode": "story", "headline": top.first().map(|h| story::public(h))})
    } else {
        json!({"mode": "gameday", "games": slides})
    };
    let news: Vec<story::Group> = groups
        .into_iter()
        .filter_map(|mut g| {
            g.headlines.retain(|h| !ranked_urls.contains(&url_of(h)));
            (!g.headlines.is_empty()).then_some(g)
        })
        .collect();

    // The featured story is picked by the same rule the screen uses, and only its body is read.
    let feature = story::select_feature(&news, &followed_pairs).map(|h| (h["id"].as_str().unwrap_or_default().to_owned(), url_of(h), h["origin"] == "espn"));
    feeds.save(host);
    let body = match &feature {
        Some((id, _, true)) => {
            article::body(host, id).text
        }
        _ => String::new(),
    };
    let league_news: Vec<Value> = news
        .iter()
        .map(|g| {
            let headlines: Vec<Value> = g
                .headlines
                .iter()
                .map(|h| {
                    let mut out = story::public(h);
                    if !body.is_empty() && feature.as_ref().is_some_and(|(id, url, _)| h["id"].as_str() == Some(id.as_str()) && url_of(h) == *url) {
                        out["body"] = json!(body);
                    }
                    out
                })
                .collect();
            json!({"kind": "competition", "sportKey": g.sport_key, "competitionKey": g.competition_key, "competitionLabel": g.label, "headlines": headlines})
        })
        .collect();

    let scoreboard: Vec<Value> = keys
        .iter()
        .filter_map(|k| {
            let games = &per[k].scoreboard;
            (!games.is_empty()).then(|| json!({"competitionKey": k, "competitionLabel": label_of(k), "games": games}))
        })
        .collect();
    let standings: Vec<Value> = keys
        .iter()
        .filter_map(|k| {
            let sections = sections_of(k);
            let has_rows = sections.iter().any(|s| s["rows"].as_array().is_some_and(|r| !r.is_empty()));
            has_rows.then(|| json!({
                "competitionKey": k, "competitionLabel": label_of(k),
                "standingsShape": catalog::entry(k).map(|e| e.standings_shape).unwrap_or("table"), "sections": sections,
            }))
        })
        .collect();
    let active_keys: Vec<&String> = keys.iter().filter(|k| season_is_active(&per[*k].standings["season"], now_ms)).collect();

    let followed_teams: Vec<Value> = active
        .iter()
        .filter_map(|f| {
            let b = bundles.get(&f.id)?;
            let team = b.team.as_ref()?;
            Some(json!({"competitionKey": f.competition_key, "teamKey": team.team_key, "sourceTeamId": b.match_id}))
        })
        .collect();
    let league_refs: Vec<Value> = followed_leagues.iter().map(|f| json!({"competitionKey": f.competition_key, "competitionLabel": label_of(&f.competition_key)})).collect();
    let league_cards: Vec<Value> = followed_leagues
        .iter()
        .filter_map(|f| {
            let entry = catalog::entry(&f.competition_key);
            let games = &per.get(&f.competition_key)?.scoreboard;
            let results = followed::league_results(games);
            let pool: Vec<&Value> = by_comp.get(&f.competition_key).map(|h| h.iter().collect()).unwrap_or_default();
            let stories = story::team_stories(&pool);
            (!results.is_empty() || !stories.is_empty()).then(|| json!({
                "competitionKey": f.competition_key, "competitionLabel": label_of(&f.competition_key),
                "kind": entry.map(|e| e.kind).unwrap_or("league"),
                "status": if games.iter().any(|g| g["state"] == "live") { "live" } else { "news" },
                "logoUrl": entry.and_then(|e| e.logo_url), "stories": stories, "results": results,
            }))
        })
        .collect();

    Ok(Response::new(
        200,
        json!({
            "hero": hero,
            "followed": cards, "scoreboard": scoreboard, "topStories": top.iter().map(|h| story::public(h)).collect::<Vec<_>>(), "leagueNews": league_news,
            "standings": standings, "followedTeams": followed_teams, "followedLeagues": league_refs,
            "followedLeagueCards": league_cards, "ambiguousFollows": ambiguous_follows,
            "activeCompetitionKeys": active_keys, "degraded": degraded,
        }),
    ))
}

/// A tournament whose group stage is finished: every group has rows and every club has played all its group games.
fn group_stage_complete(sections: &[Value]) -> bool {
    !sections.is_empty()
        && sections.iter().all(|s| {
            let rows = s["rows"].as_array().cloned().unwrap_or_default();
            !rows.is_empty()
                && rows.iter().all(|r| {
                    let n = |k: &str| r[k].as_f64().unwrap_or(0.0);
                    n("wins") + n("losses") + n("draws") >= rows.len() as f64 - 1.0
                })
        })
}

/// `GET /standings?competitionKey=`.
pub fn standings<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    use crate::util::bad_request;
    let key = match request.query.get("competitionKey") {
        None => return Ok(bad_request("querystring must have required property 'competitionKey'")),
        Some(Value::String(k)) => k,
        Some(_) => return Ok(bad_request("querystring/competitionKey must be string")),
    };
    match key.chars().count() {
        0 => return Ok(bad_request("querystring/competitionKey must NOT have fewer than 1 characters")),
        101.. => return Ok(bad_request("querystring/competitionKey must NOT have more than 100 characters")),
        _ => {}
    }
    let Some(entry) = catalog::entry(key) else { return Ok(bad_request(format!("Unknown competition: {key}"))) };
    let group = |sections: Value| json!({
        "competitionKey": key, "competitionLabel": entry.label, "standingsShape": entry.standings_shape, "sections": sections,
    });
    if entry.news_feed_url.is_some() {
        return Ok(Response::new(200, json!({"group": group(json!([])), "fixtures": [], "degraded": false})));
    }
    let table = datasets::standings(host, key)?;
    let mut degraded = table.degraded;
    let sections = table.data["sections"].as_array().cloned().unwrap_or_default();
    let mut fixtures: Vec<Value> = vec![];
    if entry.kind == "tournament" && group_stage_complete(&sections) {
        let today = eastern::day_of(cache::now_ms(host)?);
        fixtures = scoreboard_for_days(host, key, &eastern::add_days(&today, FIXTURE_DAYS_BEFORE), &eastern::add_days(&today, FIXTURE_DAYS_AFTER), &mut degraded)?;
        fixtures.sort_by(|a, b| a["startsAt"].as_str().unwrap_or("").cmp(b["startsAt"].as_str().unwrap_or("")));
    }
    Ok(Response::new(200, json!({"group": group(Value::Array(sections)), "fixtures": fixtures, "degraded": degraded})))
}
