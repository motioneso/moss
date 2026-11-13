mod common;
use common::*;
use serde_json::json;

const PATH: &str = "/standings-preferences";

#[test]
fn nothing_saved_reads_as_no_choice() {
    let f = Fake::new();
    assert_eq!(f.route("GET", PATH, &[], json!(null)), (200, json!({"selectedCompetitionKeys":null,"lastViewed":null})));
}

#[test]
fn chosen_leagues_are_saved_in_catalog_order() {
    let f = Fake::new();
    let (status, body) = f.route("PUT", PATH, &[], json!({"selectedCompetitionKeys":["nhl","nba"]}));
    assert_eq!(status, 200);
    assert_eq!(body["selectedCompetitionKeys"], json!(["nba","nhl"]));
    assert_eq!(f.setting(A, "standings-competitions"), Some(json!(["nba","nhl"])));
    // An empty list is a real choice, not "no choice".
    let (_, body) = f.route("PUT", PATH, &[], json!({"selectedCompetitionKeys":[]}));
    assert_eq!(body["selectedCompetitionKeys"], json!([]));
}

#[test]
fn the_last_view_is_kept_apart_from_the_chosen_leagues() {
    let f = Fake::new();
    f.route("PUT", PATH, &[], json!({"selectedCompetitionKeys":["nba"]}));
    let (_, body) = f.route("PUT", PATH, &[], json!({"lastViewed":{"competitionKey":"nhl"}}));
    assert_eq!(body, json!({"selectedCompetitionKeys":["nba"],"lastViewed":{"competitionKey":"nhl","viewKey":null,"viewLabel":null}}));
    let (_, body) = f.route("PUT", PATH, &[], json!({"lastViewed":{"competitionKey":"nhl","viewKey":"k","viewLabel":"L"}}));
    assert_eq!(body["lastViewed"]["viewKey"], "k");
    // Clearing stores null and leaves the leagues alone.
    let (_, body) = f.route("PUT", PATH, &[], json!({"lastViewed":null}));
    assert_eq!(body, json!({"selectedCompetitionKeys":["nba"],"lastViewed":null}));
    assert_eq!(f.setting(A, "standings-last-viewed"), Some(json!(null)));
}

#[test]
fn bad_requests_get_the_old_words_and_change_nothing() {
    let f = Fake::new();
    let ask = |body| {
        let (status, out) = f.route("PUT", PATH, &[], body);
        (status, out["error"].as_str().unwrap().to_owned())
    };
    let long = "x".repeat(101);
    let cases = [
        (json!(null), "Invalid standings preferences"),
        (json!({}), "Invalid standings preferences"),
        (json!([]), "Invalid standings preferences"),
        (json!({"other":1}), "Invalid standings preferences"),
        (json!({"selectedCompetitionKeys":"nba"}), "Invalid standings competition keys"),
        (json!({"selectedCompetitionKeys":["nba","nba"]}), "Invalid standings competition keys"),
        (json!({"selectedCompetitionKeys":["nba",3]}), "Invalid standings competition keys"),
        (json!({"selectedCompetitionKeys":null}), "Invalid standings competition keys"),
        (json!({"selectedCompetitionKeys":["zzz"]}), "Standings preferences contain an unknown competition"),
        (json!({"lastViewed":"nba"}), "Invalid last-viewed standings"),
        (json!({"lastViewed":[]}), "Invalid last-viewed standings"),
        (json!({"lastViewed":{"competitionKey":"nba","z":1}}), "Invalid last-viewed standings"),
        (json!({"lastViewed":{"competitionKey":""}}), "Invalid last-viewed standings competition"),
        (json!({"lastViewed":{}}), "Invalid last-viewed standings competition"),
        (json!({"lastViewed":{"competitionKey":"nba","viewKey":long}}), "Invalid last-viewed standings view"),
        (json!({"lastViewed":{"competitionKey":"nba","viewLabel":5}}), "Invalid last-viewed standings view"),
        (json!({"lastViewed":{"competitionKey":"zzz"}}), "Last-viewed standings contain an unknown competition"),
    ];
    for (body, message) in cases {
        assert_eq!(ask(body.clone()), (400, message.to_owned()), "{body}");
    }
    assert!(f.settings.borrow().is_empty(), "a refused request writes nothing");
}

#[test]
fn a_refused_view_does_not_save_the_leagues_sent_with_it() {
    let f = Fake::new();
    let (status, _) = f.route("PUT", PATH, &[], json!({"selectedCompetitionKeys":["nba"],"lastViewed":{"competitionKey":"zzz"}}));
    assert_eq!(status, 400);
    assert!(f.settings.borrow().is_empty());
}

#[test]
fn choices_are_per_person() {
    let f = Fake::new();
    f.route("PUT", PATH, &[], json!({"selectedCompetitionKeys":["nba"]}));
    f.as_actor(B);
    assert_eq!(f.route("GET", PATH, &[], json!(null)).1["selectedCompetitionKeys"], json!(null));
}

#[test]
fn odd_saved_values_read_as_no_choice() {
    let f = Fake::new();
    f.put_setting(A, "standings-competitions", json!("nba"));
    f.put_setting(A, "standings-last-viewed", json!({"competitionKey":"retired","viewKey":"k","viewLabel":"L"}));
    assert_eq!(f.route("GET", PATH, &[], json!(null)).1, json!({"selectedCompetitionKeys":null,"lastViewed":null}));
    // Unknown names inside a saved list drop out and the rest stays in catalog order.
    f.put_setting(A, "standings-competitions", json!(["nhl", 3, "retired", "nba"]));
    f.put_setting(A, "standings-last-viewed", json!({"competitionKey":"nba","viewKey":4}));
    assert_eq!(
        f.route("GET", PATH, &[], json!(null)).1,
        json!({"selectedCompetitionKeys":["nba","nhl"],"lastViewed":{"competitionKey":"nba","viewKey":null,"viewLabel":null}})
    );
}

#[test]
fn the_catalog_list_matches_the_old_catalog() {
    let old = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/catalog-keys.txt")).unwrap();
    let old: Vec<&str> = old.split_whitespace().collect();
    assert_eq!(old, moss_sports_module::catalog::COMPETITION_KEYS);
}
