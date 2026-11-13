//! Competition keys in catalog order. The full catalog (labels, feeds, standings shapes) arrives
//! with the provider part. A parity test checks this list against the old catalog.

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
