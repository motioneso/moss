//! A stand-in Outlook calendar page for the helper browser protocol. It answers the same JSON
//! operations the real helper does, from an invented week view that holds no real account.
//!
//! The helper protocol is `POST /` with `{"op","args"}`, answered by `{"value"}` or `{"error"}`.

use axum::{extract::State, routing::post, Json, Router};
use chrono::{Datelike, Duration, NaiveDate, Utc};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};

const TAIL: &str = ", Jump to a specific date or date range.";

pub struct OutlookConfig {
    pub address: String,
    pub time_zone: String,
}

impl Default for OutlookConfig {
    fn default() -> Self {
        Self { address: "person@example.invalid".into(), time_zone: "(UTC-08:00) Pacific Time (US & Canada)".into() }
    }
}

struct Page {
    cfg: OutlookConfig,
    week: NaiveDate,
    /// (id, label, day)
    items: Vec<(String, String, NaiveDate)>,
    signed_out: bool,
    ops: Vec<String>,
}

type Shared = Arc<Mutex<Page>>;

pub struct OutlookStandIn {
    pub addr: SocketAddr,
    state: Shared,
    task: tokio::task::JoinHandle<()>,
}

fn sunday_of(day: NaiveDate) -> NaiveDate {
    day - Duration::days(day.weekday().num_days_from_sunday() as i64)
}

fn name(day: NaiveDate) -> String {
    day.format("%B %-d").to_string()
}

fn header(start: NaiveDate) -> String {
    let end = start + Duration::days(6);
    if start.year() == end.year() {
        format!("{} \u{2013} {}, {}{TAIL}", name(start), name(end), end.year())
    } else {
        format!("{}, {} \u{2013} {}, {}{TAIL}", name(start), start.year(), name(end), end.year())
    }
}

/// The label a real page gives a timed event on `day`.
pub fn label(title: &str, times: &str, day: NaiveDate) -> String {
    format!("{title}, {times}, {}, Busy", day.format("%A, %B %-d, %Y"))
}

async fn answer(State(state): State<Shared>, Json(body): Json<Value>) -> Json<Value> {
    let op = body["op"].as_str().unwrap_or("").to_string();
    let mut page = state.lock().unwrap();
    page.ops.push(op.clone());
    if page.signed_out && !matches!(op.as_str(), "close" | "interrupted") {
        return Json(json!({"error":"sign-in-needed"}));
    }
    let end = page.week + Duration::days(7);
    Json(match op.as_str() {
        "account-address" => json!({"value":page.cfg.address}),
        "display" => json!({"value":{"timeZone":page.cfg.time_zone,"language":"en-US"}}),
        "primary-calendar" => json!({"value":true}),
        "week-header" => json!({"value":header(page.week)}),
        "read-week" => {
            let rows: Vec<Value> = page
                .items
                .iter()
                .filter(|(_, _, d)| *d >= page.week && *d < end)
                .map(|(id, label, _)| json!({"id":id,"label":label}))
                .collect();
            json!({"value":rows})
        }
        "step-week" => {
            let step = if body["args"]["forward"] == true { 7 } else { -7 };
            page.week += Duration::days(step);
            json!({"value":null})
        }
        "interrupted" => json!({"value":false}),
        "close" => json!({"value":null}),
        _ => json!({"error":"unknown-op"}),
    })
}

impl OutlookStandIn {
    pub async fn start(cfg: OutlookConfig) -> Self {
        let today = Utc::now().date_naive();
        let state: Shared = Arc::new(Mutex::new(Page {
            cfg,
            week: sunday_of(today),
            items: vec![],
            signed_out: false,
            ops: vec![],
        }));
        let app = Router::new().route("/", post(answer)).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { addr, state, task }
    }

    pub fn endpoint(&self) -> String {
        format!("http://{}/", self.addr)
    }

    /// Adds a timed event `days` from today.
    pub fn add_event(&self, id: &str, title: &str, times: &str, days: i64) {
        let day = Utc::now().date_naive() + Duration::days(days);
        self.state.lock().unwrap().items.push((id.into(), label(title, times, day), day));
    }

    pub fn sign_out(&self) {
        self.state.lock().unwrap().signed_out = true;
    }

    pub fn set_address(&self, address: &str) {
        self.state.lock().unwrap().cfg.address = address.into();
    }

    /// Every operation the page has been asked, in order.
    pub fn ops(&self) -> Vec<String> {
        self.state.lock().unwrap().ops.clone()
    }
}

impl Drop for OutlookStandIn {
    fn drop(&mut self) {
        self.task.abort();
    }
}
