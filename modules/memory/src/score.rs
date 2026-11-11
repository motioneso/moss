//! Recall scoring. The formula, weights and cut-offs match the old TypeScript service.
use serde_json::{json, Map, Value};

pub const DEFAULT_LIMIT: usize = 10;
pub const CORE_LIMIT: i64 = 20;

/// Milliseconds since the epoch for `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn parse_iso_ms(text: &str) -> Option<f64> {
    let b = text.as_bytes();
    if b.len() != 24 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[23] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (y, m, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s, ms) = (num(11, 13)?, num(14, 16)?, num(17, 19)?, num(20, 23)?);
    // Days from civil date (proleptic Gregorian).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((((days * 24 + h) * 60 + mi) * 60 + s) as f64 * 1000.0 + ms as f64)
}

fn num(fact: &Value, name: &str) -> f64 {
    fact[name].as_f64().unwrap_or(0.0)
}

pub fn confidence_tier(fact: &Value) -> &'static str {
    let confidence = num(fact, "confidence");
    let confirmed = fact["provenance"] == "confirmed" || !fact["lastConfirmedAt"].is_null();
    if confirmed && confidence >= 0.9 {
        "confirmed"
    } else if confidence >= 0.8 {
        "high"
    } else if confidence >= 0.6 {
        "medium"
    } else {
        "low"
    }
}

fn provenance_boost(fact: &Value) -> f64 {
    match fact["provenance"].as_str() {
        Some("confirmed") => 1.0,
        Some("volunteered") => 0.8,
        Some("imported") => 0.6,
        _ => 0.4,
    }
}

fn freshness(fact: &Value, now_ms: f64) -> f64 {
    let stamp = ["lastConfirmedAt", "updatedAt", "createdAt"]
        .iter()
        .find_map(|k| fact[*k].as_str());
    let Some(then) = stamp.and_then(parse_iso_ms) else {
        return 0.0;
    };
    let days = ((now_ms - then) / 86_400_000.0).max(0.0);
    (1.0 - days / 365.0).max(0.0)
}

/// Fraction of the lowercase query words found in `text`.
pub fn keyword_score(query: &str, text: &str) -> f64 {
    let lower = query.to_lowercase();
    let terms: Vec<&str> = lower.split_whitespace().collect();
    if terms.is_empty() {
        return 0.0;
    }
    let haystack = text.to_lowercase();
    terms.iter().filter(|t| haystack.contains(**t)).count() as f64 / terms.len() as f64
}

fn round3(score: f64) -> f64 {
    (score * 1000.0).round() / 1000.0
}

fn item_text(fact: &Value) -> String {
    fact["objectText"]
        .as_str()
        .or_else(|| fact["objectEntityId"].as_str())
        .unwrap_or("")
        .to_owned()
}

/// One recall item. `subjectName` is set only for a named, non-self subject.
pub fn item(fact: &Value, score: f64, names: &Value) -> Value {
    let mut out = Map::new();
    if let Some(name) = fact["subjectEntityId"].as_str().and_then(|id| names[id].as_str()) {
        out.insert("subjectName".into(), json!(name));
    }
    for (key, value) in [
        ("kind", json!("fact")),
        ("id", fact["id"].clone()),
        ("title", fact["predicate"].clone()),
        ("text", json!(item_text(fact))),
        ("score", json!(score)),
        ("recordKind", fact["recordKind"].clone()),
        ("status", fact["status"].clone()),
        ("confidence", fact["confidence"].clone()),
        ("confidenceTier", json!(confidence_tier(fact))),
        ("provenance", fact["provenance"].clone()),
        ("validFrom", fact["validFrom"].clone()),
        ("validTo", fact["validTo"].clone()),
        ("staleAt", fact["staleAt"].clone()),
        ("supersededByFactId", fact["supersededByFactId"].clone()),
        ("conflictGroupId", fact["conflictGroupId"].clone()),
        ("sources", fact["sources"].clone()),
    ] {
        out.insert(key.into(), value);
    }
    Value::Object(out)
}

pub struct Options {
    pub limit: Option<usize>,
    pub include_inactive: bool,
    pub include_low_confidence: bool,
}

/// Scores, filters, sorts and trims the candidates the host returned.
pub fn recall(query: &str, host: &Value, options: &Options) -> Vec<Value> {
    let now_ms = host["nowMs"].as_f64().unwrap_or(0.0);
    let mut scored: Vec<(f64, f64, String, Value)> = Vec::new();
    for candidate in host["candidates"].as_array().into_iter().flatten() {
        let fact = &candidate["fact"];
        let search_text = candidate["searchText"].as_str().map(str::to_owned).unwrap_or_else(|| {
            [fact["predicate"].as_str(), fact["objectText"].as_str()]
                .into_iter()
                .flatten()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        });
        let similarity = {
            let s = candidate["similarity"].as_f64().unwrap_or(0.0);
            if s.is_finite() { s.clamp(0.0, 1.0) } else { 0.0 }
        };
        let score = round3(
            0.4 * similarity
                + 0.25 * keyword_score(query, &search_text)
                + 0.15 * num(fact, "importance")
                + 0.1 * provenance_boost(fact)
                + 0.05 * if fact["pinned"] == true { 1.0 } else { 0.0 }
                + 0.05 * freshness(fact, now_ms),
        );
        let confidence = num(fact, "confidence");
        let text = item_text(fact);
        if !(options.include_inactive || score > 0.0) {
            continue;
        }
        if !(options.include_low_confidence
            || confidence >= 0.6
            || keyword_score(query, &text) >= 0.85)
        {
            continue;
        }
        scored.push((score, confidence, text, item(fact, score, &host["names"])));
    }
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    scored
        .into_iter()
        .take(options.limit.unwrap_or(DEFAULT_LIMIT))
        .map(|(_, _, _, item)| item)
        .collect()
}

/// The core facts, each with score 1.
pub fn core(host: &Value) -> Vec<Value> {
    host["facts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|fact| item(fact, 1.0, &host["names"]))
        .collect()
}
