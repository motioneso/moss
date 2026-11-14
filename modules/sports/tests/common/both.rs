#![allow(dead_code)]
//! A host with a person's follows from the in-memory table and public ESPN answers from the
//! recorded fixtures, so the overview runs on its real read path with only the network replaced.
use super::{espn::EspnHost, Fake};
use moss_module_sdk::{Host, Result, RouteRequest};
use serde_json::Value;

pub struct Both {
    pub follows: Fake,
    pub espn: EspnHost,
}

impl Both {
    pub fn new() -> Self {
        let both = Self { follows: Fake::new(), espn: EspnHost::new() };
        both.follows.as_actor(super::espn::ACTOR);
        both
    }
    pub fn at(&self, iso: &str) {
        self.espn.now_ms.set(chrono::DateTime::parse_from_rfc3339(iso).unwrap().timestamp_millis());
    }
    pub fn get(&self, path: &str, query: &[(&str, &str)]) -> (u16, Value) {
        let request = RouteRequest {
            method: "GET".into(),
            path: path.into(),
            params: Default::default(),
            query: query.iter().map(|(k, v)| ((*k).into(), Value::String((*v).into()))).collect(),
            body: Value::Null,
        };
        let r = moss_sports_module::route(self, request);
        (r.status, r.body)
    }
    /// A follow with its permanent id, as the picker saves one.
    pub fn follow(&self, competition: &str, team_key: &str, team_id: &str) {
        let mut rows = self.follows.follows.borrow_mut();
        let n = rows.len();
        rows.push(serde_json::json!({
            "id": format!("00000000-0000-4000-8000-{n:012x}"), "owner_user_id": super::espn::ACTOR,
            "competition_key": competition, "team_key": team_key, "source_team_id": team_id,
            "created_at": format!("2026-11-11T10:00:{n:02}.000+00:00"),
        }));
    }
}

impl Host for Both {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        if port == "db" || operation.starts_with("preference.") {
            return self.follows.call(port, operation, resource, parameters);
        }
        self.espn.call(port, operation, resource, parameters)
    }
}
