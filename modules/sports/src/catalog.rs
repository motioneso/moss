//! The competition catalog in catalog order. The table in `catalog_table.rs` is generated from the
//! old catalog, and parity tests check both it and the key list against that catalog.

use serde_json::{json, Value};

/// One competition the app knows, with the provider path it is read from.
pub struct Entry {
    pub key: &'static str,
    pub label: &'static str,
    pub sport_label: &'static str,
    pub region_label: Option<&'static str>,
    pub kind: &'static str,
    pub marquee: bool,
    pub standings_shape: &'static str,
    pub espn_sport: &'static str,
    pub espn_league: &'static str,
    pub logo_url: Option<&'static str>,
    pub confederation: &'static str,
    pub news_feed_url: Option<&'static str>,
    pub news_feed_publisher: Option<&'static str>,
}

pub use crate::catalog_table::ENTRIES;

pub fn entry(key: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|e| e.key == key)
}

/// `GET /catalog` body. Field order matches the old response.
pub fn response() -> Value {
    let competitions: Vec<Value> = ENTRIES
        .iter()
        .map(|e| {
            json!({
                "competitionKey": e.key, "label": e.label, "sportLabel": e.sport_label,
                "regionLabel": e.region_label, "kind": e.kind, "marquee": e.marquee,
                "standingsShape": e.standings_shape, "confederation": e.confederation,
            })
        })
        .collect();
    json!({"competitions": competitions, "degraded": false})
}

/// Every competition a person can follow or pick standings for, in catalog order.
pub const COMPETITION_KEYS: [&str; 64] = [
    "nfl",
    "nba",
    "nhl",
    "mlb",
    "wnba",
    "ncaaf",
    "ncaam",
    "ncaaw",
    "ncaa-baseball",
    "ncaa-hockey",
    "eng.1",
    "eng.2",
    "eng.3",
    "eng.4",
    "eng.5",
    "usa.1",
    "usa.nwsl",
    "esp.1",
    "ger.1",
    "ita.1",
    "fra.1",
    "ned.1",
    "por.1",
    "sco.1",
    "tur.1",
    "bel.1",
    "gre.1",
    "sui.1",
    "aut.1",
    "den.1",
    "mex.1",
    "crc.1",
    "bra.1",
    "arg.1",
    "col.1",
    "chi.1",
    "uru.1",
    "uefa.champions",
    "fifa.world",
    "fifa.wwc",
    "eng.w.1",
    "esp.w.1",
    "fra.w.1",
    "ned.w.1",
    "aus.w.1",
    "uefa.wchampions",
    "uefa.weuro",
    "concacaf.w.gold",
    "fifa.w.olympics",
    "wpbl",
    "jpn.1",
    "ksa.1",
    "chn.1",
    "aus.1",
    "tha.1",
    "rsa.1",
    "ecu.1",
    "par.1",
    "per.1",
    "bol.1",
    "ven.1",
    "hon.1",
    "gua.1",
    "slv.1",
];

pub fn is_known(key: &str) -> bool {
    COMPETITION_KEYS.contains(&key)
}

/// The requested keys that are known, in catalog order and without repeats.
pub fn in_catalog_order<'a, I: IntoIterator<Item = &'a str>>(requested: I) -> Vec<&'static str> {
    let wanted: std::collections::BTreeSet<&str> = requested.into_iter().collect();
    COMPETITION_KEYS.iter().copied().filter(|key| wanted.contains(key)).collect()
}
