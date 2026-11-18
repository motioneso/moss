#![allow(dead_code)]
//! A host that serves recorded ESPN fixtures through the fetch port and keeps the install-wide
//! cache in memory. It counts every fetch and records every call so tests can scan them.
use moss_module_sdk::{Error, Host, Result};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

pub const ACTOR: &str = "00000000-0000-4000-8000-0000000000ee";

pub fn fixture(name: &str) -> String {
    let path = format!("{}/../tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

pub fn golden(name: &str) -> Value {
    serde_json::from_str(&fixture(name)).unwrap()
}

pub struct EspnHost {
    pub kv: RefCell<HashMap<String, Value>>,
    pub fetched: RefCell<Vec<String>>,
    pub calls: RefCell<Vec<(String, String, String, Value)>>,
    pub now_ms: Cell<i64>,
    /// Milliseconds the clock advances on every fetch.
    pub fetch_ms: Cell<i64>,
    /// Serves endless full pages of generated teams instead of the fixtures.
    pub endless_pages: Cell<bool>,
    pub down: Cell<bool>,
    /// What ESPN's content host sends for any article. None leaves the content host unmapped.
    pub article_story: RefCell<Option<String>>,
    /// Makes the content host answer with an error while the rest of ESPN works.
    pub article_fails: Cell<bool>,
    /// Shows every hockey game as not yet started ("pre") or in progress ("in").
    pub hockey_state: RefCell<Option<&'static str>>,
    /// Replaces every news list ESPN sends.
    pub news_override: RefCell<Option<String>>,
}

impl EspnHost {
    pub fn new() -> Self {
        Self {
            kv: RefCell::new(HashMap::new()),
            fetched: RefCell::new(vec![]),
            calls: RefCell::new(vec![]),
            now_ms: Cell::new(1_794_000_000_000),
            fetch_ms: Cell::new(0),
            endless_pages: Cell::new(false),
            down: Cell::new(false),
            article_story: RefCell::new(None),
            article_fails: Cell::new(false),
            hockey_state: RefCell::new(None),
            news_override: RefCell::new(None),
        }
    }
    fn file_for(url: &str) -> Option<&'static str> {
        let has = |s: &str| url.contains(s);
        if has("/teams?") {
            return Some(if has("/soccer/eng.1/") {
                "eng1-teams.json"
            } else if has("/baseball/college-baseball/") {
                "ncaa-baseball-teams-subset.json"
            } else {
                "nfl-teams.json"
            });
        }
        if has("/schedule") || has("/scoreboard?") {
            return Some(if has("/soccer/") {
                "eng1-scoreboard-20260104-everton-brentford.json"
            } else if has("/hockey/nhl/") {
                "nhl-scoreboard-20261112.json"
            } else {
                "nfl-scoreboard.json"
            });
        }
        if has("/standings?") {
            return Some(if has("/soccer/eng.1/") {
                "eng1-standings.json"
            } else if has("/soccer/fifa.world/") {
                "fifa-standings.json"
            } else if has("/football/college-football/") {
                "ncaaf-standings.json"
            } else {
                "nfl-standings.json"
            });
        }
        if has("/news") {
            return Some(if has("/soccer/eng.1/") { "eng1-news.json" } else { "nfl-news.json" });
        }
        None
    }
    pub fn kv_text(&self) -> String {
        self.kv.borrow().values().map(Value::to_string).collect::<Vec<_>>().join("\n")
    }
}

impl Host for EspnHost {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push((port.into(), operation.into(), resource.into(), parameters.clone()));
        match (port, operation) {
            ("context", "read") => {
                let at = chrono::DateTime::from_timestamp_millis(self.now_ms.get()).unwrap();
                Ok(json!({"actorUserId": ACTOR, "now": at.to_rfc3339()}))
            }
            ("kv", "get") => Ok(self.kv.borrow().get(resource).cloned().unwrap_or(Value::Null)),
            ("kv", "set") => {
                self.kv.borrow_mut().insert(resource.into(), parameters);
                Ok(Value::Null)
            }
            ("fetch", "get") => {
                let url = parameters["url"].as_str().unwrap().to_owned();
                self.fetched.borrow_mut().push(url.clone());
                self.now_ms.set(self.now_ms.get() + self.fetch_ms.get());
                if self.endless_pages.get() && url.contains("/teams?") {
                    let page: usize = url
                        .split("page=")
                        .nth(1)
                        .and_then(|p| p.split('&').next())
                        .and_then(|p| p.parse().ok())
                        .unwrap_or(1);
                    let teams: Vec<Value> = (0..100)
                        .map(|i| {
                            let id = (page * 1000 + i).to_string();
                            json!({"team": {"id": id, "abbreviation": format!("T{id}"),
                                "displayName": format!("Team {id}"), "shortDisplayName": format!("T{id}")}})
                        })
                        .collect();
                    let body = json!({"sports": [{"leagues": [{"teams": teams}]}]});
                    return Ok(json!({"status": 200, "body": body.to_string()}));
                }
                if self.down.get() {
                    return Ok(json!({"status": 503, "body": "down"}));
                }
                if url.contains("content.core.api.espn.com") {
                    if self.article_fails.get() {
                        return Ok(json!({"status": 500, "body": "{}"}));
                    }
                    if let Some(story) = self.article_story.borrow().clone() {
                        return Ok(json!({"status": 200, "body": json!({"headlines": [{"story": story}]}).to_string()}));
                    }
                } else if url.contains("/news") {
                    if let Some(body) = self.news_override.borrow().clone() {
                        return Ok(json!({"status": 200, "body": body}));
                    }
                }
                match Self::file_for(&url) {
                    Some(f) if f.starts_with("nhl-scoreboard") && self.hockey_state.borrow().is_some() => {
                        let state = self.hockey_state.borrow().unwrap();
                        let mut data: Value = serde_json::from_str(&fixture(f)).unwrap();
                        for event in data["events"].as_array_mut().unwrap() {
                            let status = &mut event["competitions"][0]["status"]["type"];
                            status["state"] = json!(state);
                            status["completed"] = json!(false);
                            status["name"] = json!(if state == "in" { "STATUS_IN_PROGRESS" } else { "STATUS_SCHEDULED" });
                        }
                        Ok(json!({"status": 200, "body": data.to_string()}))
                    }
                    Some(f) => Ok(json!({"status": 200, "body": fixture(f)})),
                    None => Ok(json!({"status": 404, "body": "{}"})),
                }
            }
            _ => Err(Error::new("Unexpected host call")),
        }
    }
}
