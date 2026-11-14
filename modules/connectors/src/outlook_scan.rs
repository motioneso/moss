//! Walks the Outlook week views through a narrow browser port. One `step` reads one view, so a
//! host call stays inside its time budget. The port returns page text only to this module, which
//! turns it into normalized observations and never keeps or reports the raw text.
use crate::outlook_source::{
    add_days, day_start, display_time_zone, normalize_label, parse_week_header, Observation,
    Result, SourceError,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::BTreeMap;

const PARTIAL: SourceError = SourceError::new("partial");
const CHANGED: SourceError = SourceError::new("source-changed");
const MAX_VIEWS: usize = 6;
const MAX_ALIGN: usize = 6;
const MAX_EVENTS: usize = 1000;

/// One rendered calendar item as the page shows it.
pub struct RawItem {
    pub id: String,
    pub label: String,
}

/// What the page says about its own display settings.
pub struct Display {
    pub time_zone: String,
    pub language: String,
}

/// The only way the scan touches a browser. Every method fails with a bare source code.
pub trait Browser {
    fn account_address(&mut self) -> Result<String>;
    fn display(&mut self) -> Result<Display>;
    fn primary_calendar_selected(&mut self) -> Result<bool>;
    fn week_header(&mut self) -> Result<String>;
    fn read_week(&mut self) -> Result<Vec<RawItem>>;
    fn step_week(&mut self, forward: bool) -> Result<()>;
    /// True when a person used the page during the scan, so the read cannot be trusted.
    fn interrupted(&mut self) -> bool;
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub calendar_key: &'static str,
    pub time_zone: String,
    pub observed_at: String,
    pub window_start: String,
    pub window_end: String,
    pub complete: bool,
    pub views: usize,
    pub events: Vec<Observation>,
}

pub struct Session {
    address: String,
    observed_at: DateTime<Utc>,
    time_zone: String,
    window_start: String,
    window_end: String,
    events: BTreeMap<String, Observation>,
    views: usize,
    aligned: usize,
    prior_end: Option<String>,
    started: bool,
}

pub enum Step {
    More,
    Done(Scan),
}

impl Session {
    pub fn new(address: &str, now: DateTime<Utc>) -> Self {
        Self {
            address: address.to_ascii_lowercase(),
            observed_at: now,
            time_zone: String::new(),
            window_start: String::new(),
            window_end: String::new(),
            events: BTreeMap::new(),
            views: 0,
            aligned: 0,
            prior_end: None,
            started: false,
        }
    }

    fn verify(&self, b: &mut dyn Browser) -> Result<String> {
        let seen = b.account_address()?;
        if seen.trim().is_empty() {
            return Err(SourceError::at("settings-not-found", "account"));
        }
        if seen.trim().to_ascii_lowercase() != self.address {
            return Err(SourceError::at("source-changed", "account"));
        }
        let display = b.display()?;
        if !display.language.to_ascii_lowercase().starts_with("en") {
            return Err(SourceError::at("source-changed", "timezone"));
        }
        let zone = display_time_zone(&display.time_zone)?;
        if !b.primary_calendar_selected()? {
            return Err(SourceError::at("source-changed", "calendar"));
        }
        Ok(zone.to_string())
    }

    /// Reads one view, or checks the page at the start and end. Returns `Done` after the last view.
    pub fn step(&mut self, b: &mut dyn Browser) -> Result<Step> {
        if b.interrupted() {
            return Err(PARTIAL);
        }
        if !self.started {
            self.time_zone = self.verify(b)?;
            let today = crate::outlook_source::day_key_of(self.observed_at, &self.time_zone)
                .ok_or(CHANGED)?;
            self.window_start = add_days(&today, -1)?;
            self.window_end = add_days(&today, 31)?;
            self.started = true;
        }
        let label = b.week_header()?;
        let (start, end) = parse_week_header(&label)?;
        if start > self.window_start && self.views == 0 {
            self.aligned += 1;
            if self.aligned > MAX_ALIGN {
                return Err(PARTIAL);
            }
            b.step_week(false)?;
            return Ok(Step::More);
        }
        if end <= self.window_start
            || self.prior_end.as_deref().is_some_and(|p| p != start)
            || self.views >= MAX_VIEWS
        {
            return Err(PARTIAL);
        }
        for row in b.read_week()? {
            let event = normalize_label(&row.id, &row.label, &self.time_zone)?;
            self.take(&start, &end, event)?;
        }
        if self.events.len() > MAX_EVENTS || b.week_header()? != label {
            return Err(PARTIAL);
        }
        self.views += 1;
        self.prior_end = Some(end.clone());
        if end >= self.window_end {
            return self.finish(b);
        }
        b.step_week(true)?;
        Ok(Step::More)
    }

    fn bound(&self, day: &str) -> Result<DateTime<Utc>> {
        day_start(day, &self.time_zone).ok_or(CHANGED)
    }

    fn after(&self, event: &Observation, day: &str) -> Result<bool> {
        if event.all_day {
            return Ok(event.ends_at[..10] > *day);
        }
        Ok(parse(&event.ends_at)? > self.bound(day)?)
    }

    fn before(&self, event: &Observation, day: &str) -> Result<bool> {
        if event.all_day {
            return Ok(event.starts_at[..10] < *day);
        }
        Ok(parse(&event.starts_at)? < self.bound(day)?)
    }

    fn take(&mut self, start: &str, end: &str, event: Observation) -> Result<()> {
        // An item outside the week being read means the page is not showing what it claims.
        if !(self.after(&event, start)? && self.before(&event, end)?) {
            return Err(PARTIAL);
        }
        if !(self.after(&event, &self.window_start)? && self.before(&event, &self.window_end)?) {
            return Ok(());
        }
        match self.events.get(&event.occurrence_key) {
            Some(prior) if *prior != event => Err(PARTIAL),
            _ => {
                self.events.insert(event.occurrence_key.clone(), event);
                Ok(())
            }
        }
    }

    fn finish(&mut self, b: &mut dyn Browser) -> Result<Step> {
        let zone = self.verify(b)?;
        if zone != self.time_zone {
            return Err(PARTIAL);
        }
        if b.interrupted() {
            return Err(PARTIAL);
        }
        Ok(Step::Done(Scan {
            calendar_key: "primary",
            time_zone: self.time_zone.clone(),
            observed_at: self.observed_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            window_start: self.window_start.clone(),
            window_end: self.window_end.clone(),
            complete: true,
            views: self.views,
            events: self.events.values().cloned().collect(),
        }))
    }
}

fn parse(at: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at).map(|d| d.with_timezone(&Utc)).map_err(|_| CHANGED)
}

/// A short, stable name for one dedicated browser binding. The guest stores it with the health
/// and compares it on every run, so a changed owner, account or endpoint stops the reader.
pub fn fingerprint(owner: &str, account: &str, endpoint: &str) -> String {
    use sha2::{Digest, Sha256};
    let text = serde_json::json!([owner, account.to_ascii_lowercase(), endpoint]).to_string();
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}
