//! The curated source and topic catalog. The feed addresses stay with the reader part. Only
//! what the saved choices and the catalog route need is here.
use serde_json::{json, Value};

pub struct Source {
    pub key: &'static str,
    pub label: &'static str,
    pub homepage_url: &'static str,
    pub default_enabled: bool,
    /// Topics this source has a dedicated feed for, in the old catalog order.
    pub topics: &'static [&'static str],
}

pub const TOPICS: [(&str, &str); 8] = [
    ("world", "World"),
    ("us", "U.S."),
    ("politics", "Politics"),
    ("business", "Business"),
    ("technology", "Technology"),
    ("science", "Science"),
    ("health", "Health"),
    ("culture", "Culture"),
];

const ALL: &[&str] = &["world", "us", "politics", "business", "technology", "science", "health", "culture"];

pub const SOURCES: [Source; 9] = [
    Source {
        key: "bbc",
        label: "BBC News",
        homepage_url: "https://www.bbc.com/news",
        default_enabled: true,
        topics: &["world", "us", "business", "technology", "science", "health", "culture"],
    },
    Source {
        key: "guardian",
        label: "The Guardian",
        homepage_url: "https://www.theguardian.com",
        default_enabled: true,
        topics: &["world", "us", "politics", "business", "technology", "science", "culture"],
    },
    Source { key: "ap", label: "AP News", homepage_url: "https://apnews.com", default_enabled: true, topics: ALL },
    Source {
        key: "nytimes",
        label: "The New York Times",
        homepage_url: "https://www.nytimes.com",
        default_enabled: false,
        topics: ALL,
    },
    Source { key: "npr", label: "NPR", homepage_url: "https://www.npr.org", default_enabled: true, topics: ALL },
    Source {
        key: "aljazeera",
        label: "Al Jazeera",
        homepage_url: "https://www.aljazeera.com",
        default_enabled: false,
        topics: &[],
    },
    Source {
        key: "verge",
        label: "The Verge",
        homepage_url: "https://www.theverge.com",
        default_enabled: false,
        topics: &["technology"],
    },
    Source {
        key: "arstechnica",
        label: "Ars Technica",
        homepage_url: "https://arstechnica.com",
        default_enabled: false,
        topics: &["technology", "science"],
    },
    Source {
        key: "wired",
        label: "Wired",
        homepage_url: "https://www.wired.com",
        default_enabled: false,
        topics: &["technology"],
    },
];

pub fn source(key: &str) -> Option<&'static Source> {
    SOURCES.iter().find(|s| s.key == key)
}

pub fn is_topic(key: &str) -> bool {
    TOPICS.iter().any(|(k, _)| *k == key)
}

/// `GET /catalog`.
pub fn response() -> Value {
    let sources: Vec<Value> = SOURCES
        .iter()
        .map(|s| {
            json!({
                "sourceKey": s.key, "label": s.label, "homepageUrl": s.homepage_url,
                "defaultEnabled": s.default_enabled, "topics": s.topics,
            })
        })
        .collect();
    let topics: Vec<Value> = TOPICS.iter().map(|(k, l)| json!({"topicKey":k,"label":l})).collect();
    json!({"sources":sources,"topics":topics})
}
