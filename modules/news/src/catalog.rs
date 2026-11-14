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
    pub top_feed_url: &'static str,
    /// Topic key to feed address, for the topics this source covers.
    pub topic_feeds: &'static [(&'static str, &'static str)],
    /// Hosts this source's story pictures may come from.
    pub image_hosts: &'static [&'static str],
}

impl Source {
    pub fn topic_feed(&self, key: &str) -> Option<&'static str> {
        self.topic_feeds.iter().find(|(k, _)| *k == key).map(|(_, url)| *url)
    }
    pub fn topic_label(key: &str) -> Option<&'static str> {
        TOPICS.iter().find(|(k, _)| *k == key).map(|(_, label)| *label)
    }
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
        top_feed_url: "https://feeds.bbci.co.uk/news/rss.xml", topic_feeds: &[("world", "https://feeds.bbci.co.uk/news/world/rss.xml"), ("us", "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml"), ("business", "https://feeds.bbci.co.uk/news/business/rss.xml"), ("technology", "https://feeds.bbci.co.uk/news/technology/rss.xml"), ("science", "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml"), ("health", "https://feeds.bbci.co.uk/news/health/rss.xml"), ("culture", "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml")], image_hosts: &["ichef.bbci.co.uk"],
    },
    Source {
        key: "guardian",
        label: "The Guardian",
        homepage_url: "https://www.theguardian.com",
        default_enabled: true,
        topics: &["world", "us", "politics", "business", "technology", "science", "culture"],
        top_feed_url: "https://www.theguardian.com/international/rss", topic_feeds: &[("world", "https://www.theguardian.com/world/rss"), ("us", "https://www.theguardian.com/us-news/rss"), ("politics", "https://www.theguardian.com/us-news/us-politics/rss"), ("business", "https://www.theguardian.com/business/rss"), ("technology", "https://www.theguardian.com/technology/rss"), ("science", "https://www.theguardian.com/science/rss"), ("culture", "https://www.theguardian.com/culture/rss")], image_hosts: &["i.guim.co.uk"],
    },
    Source { key: "ap", label: "AP News", homepage_url: "https://apnews.com", default_enabled: true, topics: ALL, top_feed_url: "https://openrss.org/feed/apnews.com", topic_feeds: &[("world", "https://openrss.org/feed/apnews.com/world-news"), ("us", "https://openrss.org/feed/apnews.com/us-news"), ("politics", "https://openrss.org/feed/apnews.com/politics"), ("business", "https://openrss.org/feed/apnews.com/business"), ("technology", "https://openrss.org/feed/apnews.com/technology"), ("science", "https://openrss.org/feed/apnews.com/science"), ("health", "https://openrss.org/feed/apnews.com/health"), ("culture", "https://openrss.org/feed/apnews.com/entertainment")], image_hosts: &["dims.apnews.com", "assets.apnews.com"] },
    Source {
        key: "nytimes",
        label: "The New York Times",
        homepage_url: "https://www.nytimes.com",
        default_enabled: false,
        topics: ALL,
        top_feed_url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", topic_feeds: &[("world", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"), ("us", "https://rss.nytimes.com/services/xml/rss/nyt/US.xml"), ("politics", "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml"), ("business", "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml"), ("technology", "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml"), ("science", "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml"), ("health", "https://rss.nytimes.com/services/xml/rss/nyt/Health.xml"), ("culture", "https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml")], image_hosts: &["static01.nyt.com"],
    },
    Source { key: "npr", label: "NPR", homepage_url: "https://www.npr.org", default_enabled: true, topics: ALL, top_feed_url: "https://feeds.npr.org/1001/rss.xml", topic_feeds: &[("world", "https://feeds.npr.org/1004/rss.xml"), ("us", "https://feeds.npr.org/1003/rss.xml"), ("politics", "https://feeds.npr.org/1014/rss.xml"), ("business", "https://feeds.npr.org/1006/rss.xml"), ("technology", "https://feeds.npr.org/1019/rss.xml"), ("science", "https://feeds.npr.org/1007/rss.xml"), ("health", "https://feeds.npr.org/1128/rss.xml"), ("culture", "https://feeds.npr.org/1008/rss.xml")], image_hosts: &["media.npr.org", "npr.brightspotcdn.com"] },
    Source {
        key: "aljazeera",
        label: "Al Jazeera",
        homepage_url: "https://www.aljazeera.com",
        default_enabled: false,
        topics: &[],
        top_feed_url: "https://www.aljazeera.com/xml/rss/all.xml", topic_feeds: &[], image_hosts: &[],
    },
    Source {
        key: "verge",
        label: "The Verge",
        homepage_url: "https://www.theverge.com",
        default_enabled: false,
        topics: &["technology"],
        top_feed_url: "https://www.theverge.com/rss/index.xml", topic_feeds: &[("technology", "https://www.theverge.com/rss/index.xml")], image_hosts: &["platform.theverge.com"],
    },
    Source {
        key: "arstechnica",
        label: "Ars Technica",
        homepage_url: "https://arstechnica.com",
        default_enabled: false,
        topics: &["technology", "science"],
        top_feed_url: "https://feeds.arstechnica.com/arstechnica/index", topic_feeds: &[("technology", "https://feeds.arstechnica.com/arstechnica/index"), ("science", "https://feeds.arstechnica.com/arstechnica/science")], image_hosts: &["cdn.arstechnica.net"],
    },
    Source {
        key: "wired",
        label: "Wired",
        homepage_url: "https://www.wired.com",
        default_enabled: false,
        topics: &["technology"],
        top_feed_url: "https://www.wired.com/feed/rss", topic_feeds: &[("technology", "https://www.wired.com/feed/rss")], image_hosts: &["media.wired.com"],
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
