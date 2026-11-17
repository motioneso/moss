//! One public-web read through the host. Every answer is a typed success or a typed failure, so
//! no caller ever sees part of a response body inside an error.
use moss_module_sdk::Host;
use serde_json::{json, Value};

const PAGE_ACCEPT: &str =
    "text/html, application/xhtml+xml, application/xml;q=0.9, application/rss+xml, application/atom+xml, text/xml;q=0.8, */*;q=0.5";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub status: u16,
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: String,
    pub hop_count: u32,
}

/// Why a read failed. `reason` is the host's word for it (blocked, robots, rate_limited,
/// http_error, challenge, timeout, network, not_https).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failed {
    pub reason: String,
    pub detail: Option<String>,
    pub status: Option<u16>,
}

impl Failed {
    fn network() -> Self {
        Self { reason: "network".into(), detail: None, status: None }
    }
}

fn read(value: &Value) -> Result<Fetched, Failed> {
    if value["ok"] == json!(true) {
        let text = |key: &str| value[key].as_str().map(str::to_owned);
        let (Some(final_url), Some(body)) = (text("finalUrl"), text("body")) else {
            return Err(Failed::network());
        };
        return Ok(Fetched {
            status: value["status"].as_u64().unwrap_or(200) as u16,
            final_url,
            content_type: text("contentType"),
            body,
            hop_count: value["hopCount"].as_u64().unwrap_or(0) as u32,
        });
    }
    Err(Failed {
        reason: value["reason"].as_str().unwrap_or("network").to_owned(),
        detail: value["detail"].as_str().map(str::to_owned),
        status: value["status"].as_u64().map(|s| s as u16),
    })
}

/// Reads `url`. `extra` adds or replaces fetch options (host list, size cap and so on). A host
/// error counts as a network failure, because host errors carry nothing safe to show.
pub fn get<H: Host + ?Sized>(host: &H, url: &str, extra: Option<Value>) -> Result<Fetched, Failed> {
    let mut parameters = json!({"url": url, "accept": PAGE_ACCEPT});
    if let Some(Value::Object(more)) = extra {
        for (key, value) in more {
            parameters[key] = value;
        }
    }
    match host.call("fetch", "get", "public-web", parameters) {
        Ok(value) => read(&value),
        Err(_) => Err(Failed::network()),
    }
}

/// What a person is told when the page could not be read.
pub fn rejection_for(failed: &Failed) -> &'static str {
    match failed.reason.as_str() {
        "not_https" => "not_https",
        "robots" => "blocked",
        _ => "unreachable",
    }
}
