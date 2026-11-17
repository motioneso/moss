mod common;
use common::team;
use moss_sports_module::identity::{match_target, resolve, side_matches, Saved};

fn list() -> Vec<moss_sports_module::identity::Team> {
    vec![
        team("413", Some("PAC"), "Pacific Tigers", Some("413")),
        team("2501", Some("PAC"), "Pacific Lutheran", Some("2501")),
        team("99", Some("ZZZ"), "Zed", Some("99")),
    ]
}

#[test]
fn a_follow_with_an_id_means_exactly_that_team() {
    let r = resolve(&Saved { team_key: Some("PAC"), source_team_id: Some("2501") }, &list());
    assert_eq!(r.team.unwrap().name, "Pacific Lutheran");
    assert_eq!(r.catalog_key.as_deref(), Some("2501"));
    assert!(!r.needs_choice);
}

#[test]
fn an_id_missing_from_todays_list_borrows_no_key() {
    let r = resolve(&Saved { team_key: Some("PAC"), source_team_id: Some("7") }, &list());
    assert!(r.team.is_none() && r.catalog_key.is_none());
    assert_eq!(r.source_team_id.as_deref(), Some("7"));
    assert!(r.team_list_loaded);
}

#[test]
fn an_older_follow_matches_nothing_and_offers_every_team_with_likely_ones_first() {
    let r = resolve(&Saved { team_key: Some("PAC"), source_team_id: None }, &list());
    assert!(r.needs_choice && r.team.is_none() && match_target(&r).is_none());
    let names: Vec<&str> = r.candidates.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["Pacific Tigers", "Pacific Lutheran", "Zed"]);
    let r = resolve(&Saved { team_key: Some("ZZZ"), source_team_id: None }, &list());
    assert_eq!(r.candidates[0].name, "Zed");
    assert_eq!(r.candidates.len(), 3);
}

#[test]
fn an_empty_list_reports_not_loaded() {
    let r = resolve(&Saved { team_key: Some("PAC"), source_team_id: None }, &[]);
    assert!(!r.team_list_loaded && r.candidates.is_empty());
}

#[test]
fn a_side_belongs_to_a_follow_only_by_permanent_id() {
    assert!(side_matches(Some("413"), "413"));
    assert!(!side_matches(Some("2501"), "413"));
    assert!(!side_matches(None, "413"));
}
