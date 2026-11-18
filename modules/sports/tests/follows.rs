mod common;
use common::*;
use serde_json::json;

const NBA: &str = "nba";

#[test]
fn a_whole_league_follow_is_saved_once() {
    let f = Fake::new();
    let (status, first) = f.route("POST", "/follows", &[], json!({"competitionKey":NBA}));
    assert_eq!(status, 200);
    assert_eq!(first["follow"]["teamKey"], json!(null));
    // Asking again, with or without an explicit null team, returns the saved row.
    for body in [json!({"competitionKey":NBA}), json!({"competitionKey":NBA,"teamKey":null})] {
        let (status, again) = f.route("POST", "/follows", &[], body);
        assert_eq!(status, 200);
        assert_eq!(again["follow"]["id"], first["follow"]["id"]);
    }
    assert_eq!(f.follows.borrow().len(), 1);
}

#[test]
fn two_people_each_keep_their_own_whole_league_follow() {
    let f = Fake::new();
    let (_, a) = f.route("POST", "/follows", &[], json!({"competitionKey":NBA}));
    f.as_actor(B);
    let (_, b) = f.route("POST", "/follows", &[], json!({"competitionKey":NBA}));
    assert_ne!(a["follow"]["id"], b["follow"]["id"]);
    let (_, list) = f.route("GET", "/follows", &[], json!(null));
    assert_eq!(list["follows"].as_array().unwrap().len(), 1);
}

#[test]
fn the_list_comes_back_newest_first() {
    let f = Fake::new();
    for key in ["nba", "nhl", "mlb"] {
        f.route("POST", "/follows", &[], json!({"competitionKey":key}));
    }
    let (status, list) = f.route("GET", "/follows", &[], json!(null));
    assert_eq!(status, 200);
    let keys: Vec<&str> = list["follows"].as_array().unwrap().iter().map(|r| r["competitionKey"].as_str().unwrap()).collect();
    assert_eq!(keys, ["mlb", "nhl", "nba"]);
    assert!(list["follows"][0]["createdAt"].as_str().unwrap().ends_with(".000Z"));
}

#[test]
fn an_unknown_competition_is_refused_with_the_old_words() {
    let f = Fake::new();
    let (status, body) = f.route("POST", "/follows", &[], json!({"competitionKey":"nope"}));
    assert_eq!((status, body), (400, json!({"error":"Unknown competition: nope"})));
    assert!(f.follows.borrow().is_empty());
}

#[test]
fn a_team_follow_with_no_provider_is_refused_like_an_outage() {
    let f = Fake::new();
    let (status, body) = f.route("POST", "/follows", &[], json!({"competitionKey":NBA,"teamKey":"LAL"}));
    assert_eq!((status, body), (400, json!({"error":"Unknown team: LAL"})));
    assert!(f.follows.borrow().is_empty());
}

#[test]
fn a_team_follow_stores_the_permanent_id_and_the_short_name() {
    let f = Fake::new();
    let list = Teams(vec![(NBA.into(), vec![team("lakers", Some("LAL"), "Los Angeles Lakers", Some("13"))])]);
    let (status, body) = f.route_with(&list, "POST", "/follows", &[], json!({"competitionKey":NBA,"teamKey":"lakers"}));
    assert_eq!(status, 200);
    assert_eq!(body["follow"]["teamKey"], "LAL");
    assert_eq!(body["follow"]["sourceTeamId"], "13");
    // Following the same team again returns the same row.
    let (_, again) = f.route_with(&list, "POST", "/follows", &[], json!({"competitionKey":NBA,"teamKey":"lakers"}));
    assert_eq!(again["follow"]["id"], body["follow"]["id"]);
    assert_eq!(f.follows.borrow().len(), 1);
}

#[test]
fn two_teams_sharing_a_short_name_stay_two_follows() {
    let f = Fake::new();
    let list = Teams(vec![(
        "ncaaf".into(),
        vec![team("413", Some("PAC"), "Pacific Tigers", Some("413")), team("2501", Some("PAC"), "Pacific Lutheran", Some("2501"))],
    )]);
    for key in ["413", "2501"] {
        let (status, _) = f.route_with(&list, "POST", "/follows", &[], json!({"competitionKey":"ncaaf","teamKey":key}));
        assert_eq!(status, 200);
    }
    assert_eq!(f.follows.borrow().len(), 2);
}

#[test]
fn a_team_without_a_permanent_id_cannot_be_followed() {
    let f = Fake::new();
    let list = Teams(vec![(NBA.into(), vec![team("lakers", Some("LAL"), "Los Angeles Lakers", None)])]);
    let (status, body) = f.route_with(&list, "POST", "/follows", &[], json!({"competitionKey":NBA,"teamKey":"lakers"}));
    assert_eq!(status, 400);
    assert_eq!(
        body["error"],
        "Sports could not get a permanent id for Los Angeles Lakers from the provider, so this team cannot be followed yet. Try again later."
    );
}

#[test]
fn bad_bodies_get_the_old_schema_messages() {
    let f = Fake::new();
    let ask = |body| f.route("POST", "/follows", &[], body).1["error"].as_str().unwrap().to_owned();
    assert_eq!(ask(json!(null)), "body must be object");
    assert_eq!(ask(json!({})), "body must have required property 'competitionKey'");
    assert_eq!(ask(json!({"competitionKey":""})), "body/competitionKey must NOT have fewer than 1 characters");
    assert_eq!(ask(json!({"competitionKey":"x".repeat(101)})), "body/competitionKey must NOT have more than 100 characters");
    assert_eq!(ask(json!({"competitionKey":NBA,"teamKey":"x".repeat(101)})), "body/teamKey must NOT have more than 100 characters");
    // Numbers read as text, so they reach the follow rules.
    assert_eq!(ask(json!({"competitionKey":5})), "Unknown competition: 5");
    assert_eq!(ask(json!({"competitionKey":NBA,"teamKey":7})), "Unknown team: 7");
    assert!(f.follows.borrow().is_empty());
}

#[test]
fn unknown_body_fields_are_ignored() {
    let f = Fake::new();
    let (status, _) = f.route("POST", "/follows", &[], json!({"competitionKey":NBA,"extra":1}));
    assert_eq!(status, 200);
}

#[test]
fn removing_a_follow_only_removes_the_callers_row() {
    let f = Fake::new();
    let (_, mine) = f.route("POST", "/follows", &[], json!({"competitionKey":NBA}));
    let id = mine["follow"]["id"].as_str().unwrap().to_owned();
    f.as_actor(B);
    let (status, body) = f.route("DELETE", "/follows/:id", &[("id", &id)], json!(null));
    assert_eq!((status, body), (200, json!({"ok":false})));
    f.as_actor(A);
    assert_eq!(f.route("DELETE", "/follows/:id", &[("id", &id)], json!(null)).1, json!({"ok":true}));
    assert_eq!(f.route("DELETE", "/follows/:id", &[("id", &id)], json!(null)).1, json!({"ok":false}));
    let (_, bad) = f.route("DELETE", "/follows/:id", &[("id", "not-a-uuid")], json!(null));
    assert_eq!(bad, json!({"error":"params/id must match format \"uuid\""}));
}

#[test]
fn choosing_a_team_for_an_older_follow() {
    let f = Fake::new();
    let old = f.seed_old_team(A, NBA, "LAL");
    let list = Teams(vec![(NBA.into(), vec![team("lakers", Some("LAL"), "Los Angeles Lakers", Some("13"))])]);
    let ask = |teams: &dyn moss_sports_module::teams::TeamList, id: &str, source: &str| {
        f.route_with(teams, "POST", "/follows/:id/team", &[("id", id)], json!({"sourceTeamId":source}))
    };
    // With no team list the choice cannot be checked.
    let (status, body) = ask(&moss_sports_module::teams::Unavailable, &old, "13");
    assert_eq!(status, 400);
    assert_eq!(body["error"], "The team list is unavailable right now, so this choice cannot be checked. Try again later.");
    // A team outside the competition is refused.
    let (status, body) = ask(&list, &old, "99");
    assert_eq!((status, body["error"].as_str().unwrap()), (400, "That team is not in this competition."));
    // The right team brings the follow back.
    let (status, body) = ask(&list, &old, "13");
    assert_eq!(status, 200);
    assert_eq!(body["follow"]["sourceTeamId"], "13");
    assert_eq!(body["follow"]["teamKey"], "LAL");
    // Unknown ids and other people's rows look the same.
    let missing = "99999999-9999-4999-8999-999999999999";
    assert_eq!(ask(&list, missing, "13").0, 404);
    f.as_actor(B);
    assert_eq!(ask(&list, &old, "13").0, 404);
}

#[test]
fn a_whole_league_follow_is_not_a_team() {
    let f = Fake::new();
    let (_, whole) = f.route("POST", "/follows", &[], json!({"competitionKey":NBA}));
    let id = whole["follow"]["id"].as_str().unwrap().to_owned();
    let (status, body) = f.route("POST", "/follows/:id/team", &[("id", &id)], json!({"sourceTeamId":"13"}));
    assert_eq!((status, body["error"].as_str().unwrap()), (400, "That follow is a whole competition, not a team."));
}

#[test]
fn an_unknown_route_is_a_plain_404_and_a_host_failure_leaks_nothing() {
    let f = Fake::new();
    assert_eq!(f.route("GET", "/nope", &[], json!(null)).0, 404);
    *f.db_failure.borrow_mut() = Some("SECRET detail".into());
    let (status, body) = f.route("GET", "/follows", &[], json!(null));
    assert_eq!(status, 500);
    assert!(!body.to_string().contains("SECRET"));
}
