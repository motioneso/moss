//! The week walk, run against an invented page that holds no real account or event.
use chrono::{TimeZone, Utc};
use moss_connectors::outlook_scan::{Browser, Display, RawItem, Session, Step};
use moss_connectors::outlook_source::{add_days, Result, SourceError};

const TAIL: &str = ", Jump to a specific date or date range.";

struct Page {
    /// First day (a Sunday) of the week now showing.
    week: String,
    address: String,
    zone: String,
    language: String,
    primary: bool,
    items: Vec<(String, String, String)>,
    interrupt: bool,
    moves: Vec<bool>,
}

impl Page {
    fn new(week: &str) -> Self {
        Self {
            week: week.into(),
            address: "person@example.invalid".into(),
            zone: "(UTC-08:00) Pacific Time (US & Canada)".into(),
            language: "en-US".into(),
            primary: true,
            items: vec![],
            interrupt: false,
            moves: vec![],
        }
    }
}

fn header(start: &str) -> String {
    let end = add_days(start, 6).unwrap();
    let name = |d: &str| {
        let n: usize = d[5..7].parse().unwrap();
        let m = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][n - 1];
        format!("{m} {}", d[8..].trim_start_matches('0'))
    };
    format!("{} \u{2013} {}, {}{TAIL}", name(start), name(&end), &end[..4])
}

impl Browser for Page {
    fn account_address(&mut self) -> Result<String> { Ok(self.address.clone()) }
    fn display(&mut self) -> Result<Display> {
        Ok(Display { time_zone: self.zone.clone(), language: self.language.clone() })
    }
    fn primary_calendar_selected(&mut self) -> Result<bool> { Ok(self.primary) }
    fn week_header(&mut self) -> Result<String> { Ok(header(&self.week)) }
    fn read_week(&mut self) -> Result<Vec<RawItem>> {
        let end = add_days(&self.week, 7).unwrap();
        Ok(self.items.iter().filter(|(_, _, day)| *day >= self.week && *day < end)
            .map(|(id, label, _)| RawItem { id: id.clone(), label: label.clone() }).collect())
    }
    fn step_week(&mut self, forward: bool) -> Result<()> {
        self.moves.push(forward);
        self.week = add_days(&self.week, if forward { 7 } else { -7 }).unwrap();
        Ok(())
    }
    fn interrupted(&mut self) -> bool { self.interrupt }
}

fn now() -> chrono::DateTime<Utc> { Utc.with_ymd_and_hms(2026, 10, 21, 18, 0, 0).unwrap() }

fn run(page: &mut Page) -> Result<moss_connectors::outlook_scan::Scan> {
    let mut session = Session::new("Person@Example.invalid", now());
    for _ in 0..40 {
        if let Step::Done(scan) = session.step(page)? { return Ok(scan); }
    }
    Err(SourceError::new("partial"))
}

fn item(id: &str, day: &str, label: &str) -> (String, String, String) { (id.into(), label.into(), day.into()) }

#[test]
fn a_full_walk_collects_every_week_in_the_window() {
    let mut page = Page::new("2026-10-18");
    page.items = vec![
        item("a", "2026-10-21", "Invented meeting, 10 AM to 11 AM, Wednesday, October 21, 2026, Busy"),
        item("b", "2026-11-10", "Later meeting, 1 PM to 2 PM, Tuesday, November 10, 2026, Busy"),
    ];
    let scan = run(&mut page).unwrap();
    assert!(scan.complete);
    assert_eq!((scan.window_start.as_str(), scan.window_end.as_str()), ("2026-10-20", "2026-11-21"));
    assert_eq!(scan.views, 5);
    assert_eq!(scan.events.len(), 2);
    assert_eq!(scan.time_zone, "America/Los_Angeles");
}

#[test]
fn a_tab_left_on_a_later_week_is_walked_back_first() {
    let mut page = Page::new("2026-11-08");
    let scan = run(&mut page).unwrap();
    assert!(scan.complete);
    assert_eq!(page.moves.iter().filter(|m| !**m).count(), 3);
}

#[test]
fn the_wrong_account_stops_the_scan_before_any_week_is_read() {
    let mut page = Page::new("2026-10-18");
    page.address = "someone-else@example.invalid".into();
    assert_eq!(run(&mut page).unwrap_err().code, "source-changed");
    assert!(page.moves.is_empty());
}

#[test]
fn a_changed_page_fails_closed() {
    let cases: [(&str, fn(&mut Page)); 4] = [
        ("source-changed", |p| p.language = "fr-FR".into()),
        ("source-changed", |p| p.primary = false),
        ("source-changed", |p| p.zone = "Somewhere".into()),
        ("settings-not-found", |p| p.address = String::new()),
    ];
    for (code, change) in cases {
        let mut page = Page::new("2026-10-18");
        change(&mut page);
        assert_eq!(run(&mut page).unwrap_err().code, code);
    }
}

#[test]
fn a_person_using_the_page_makes_the_scan_partial() {
    let mut page = Page::new("2026-10-18");
    page.interrupt = true;
    assert_eq!(run(&mut page).unwrap_err().code, "partial");
}

#[test]
fn an_item_from_another_week_makes_the_scan_partial() {
    let mut page = Page::new("2026-10-18");
    page.items = vec![item("a", "2026-10-21", "Invented meeting, 10 AM to 11 AM, Wednesday, October 28, 2026, Busy")];
    assert_eq!(run(&mut page).unwrap_err().code, "partial");
}

#[test]
fn items_outside_the_window_are_dropped_and_a_changed_repeat_is_partial() {
    let mut page = Page::new("2026-10-18");
    page.items = vec![item("old", "2026-10-18", "Early meeting, 9 AM to 10 AM, Sunday, October 18, 2026, Busy")];
    assert!(run(&mut page).unwrap().events.is_empty());
    let mut page = Page::new("2026-10-18");
    page.items = vec![
        item("a", "2026-10-21", "Invented meeting, 10 AM to 11 AM, Wednesday, October 21, 2026, Busy"),
        item("a", "2026-10-22", "Invented meeting, 10 AM to 11 AM, Thursday, October 22, 2026, Busy"),
    ];
    assert_eq!(run(&mut page).unwrap_err().code, "partial");
}
