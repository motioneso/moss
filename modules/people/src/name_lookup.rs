//! The existing cross-module exact-name lookup, through owner-scoped SDK queries.
use crate::repository::{and, orders, Repository, IDENTITIES, PEOPLE};
use moss_module_sdk::{
    query::{Compare, Filter},
    Error, Host, Result,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn trim(value: &str) -> &str {
    value.trim_matches(crate::js_space)
}
fn matching(column: &str, requested: &BTreeMap<String, String>) -> Filter {
    Filter::Or {
        filters: requested
            .keys()
            .map(|name| Filter::Compare {
                column: column.into(),
                op: Compare::LowerEq,
                value: json!(name),
            })
            .collect(),
    }
}
fn one_line(text: &Value) -> Result<Value> {
    let Some(line) = text
        .as_str()
        .and_then(|s| s.split('\n').map(trim).find(|s| !s.is_empty()))
    else {
        return Ok(Value::Null);
    };
    let units: Vec<_> = line.encode_utf16().collect();
    if units.len() <= 200 {
        return Ok(json!(line));
    }
    // JavaScript can slice a surrogate pair in half. The host's JSON value model
    // cannot transport lone surrogates. Refuse that rare case instead of silently
    // claiming exact compatibility or returning a different person's summary.
    let mut clipped = String::from_utf16(&units[..199])
        .map_err(|_| Error::new("People summary truncation splits a Unicode character"))?;
    clipped.push('…');
    Ok(json!(clipped))
}

impl<H: Host + ?Sized> Repository<'_, H> {
    pub fn find_people_by_names(&self, names: &[String]) -> Result<Vec<Value>> {
        let mut requested = BTreeMap::new();
        for name in names.iter().take(30).map(|s| trim(s)) {
            if !name.is_empty() {
                requested
                    .entry(name.to_lowercase())
                    .or_insert_with(|| name.to_owned());
            }
        }
        if requested.is_empty() {
            return Ok(vec![]);
        }
        let direct = self.select(
            PEOPLE,
            and(vec![
                Filter::eq("status", "active"),
                matching("display_name", &requested),
            ]),
            vec![],
            None,
        )?;
        let aliases = self.select(
            IDENTITIES,
            and(vec![
                Filter::eq("status", "active"),
                Filter::In {
                    column: "identity_kind".into(),
                    values: vec![json!("alias"), json!("display_name")],
                },
                matching("display_value", &requested),
            ]),
            // The legacy lookup has no alias ORDER BY. Adding an ID tie-break
            // changes which matched spelling wins for aliases created together.
            vec![],
            None,
        )?;
        let ids: Vec<_> = aliases
            .iter()
            .filter_map(|a| a["person_id"].as_str())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut people = BTreeMap::new();
        for ids in ids.chunks(500) {
            for row in self.select(
                PEOPLE,
                and(vec![
                    Filter::eq("status", "active"),
                    Filter::In {
                        column: "id".into(),
                        values: ids.iter().map(|id| json!(id)).collect(),
                    },
                ]),
                orders(&[("id", false)]),
                None,
            )? {
                if let Some(id) = row["id"].as_str() {
                    people.insert(id.to_owned(), row);
                }
            }
        }
        let mut candidates: Vec<_> = direct.iter().map(|p| (p, &p["display_name"])).collect();
        for alias in &aliases {
            if let Some(person) = alias["person_id"].as_str().and_then(|id| people.get(id)) {
                candidates.push((person, &alias["display_value"]));
            }
        }
        // Match JS Date's millisecond precision and stable sort: a direct-name
        // match wins over an alias for the same person at the same timestamp.
        candidates.sort_by_key(|(person, _)| {
            person["created_at"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.timestamp_millis())
                .unwrap_or_default()
        });
        let mut seen = BTreeSet::new();
        let mut out = vec![];
        for (person, matched) in candidates {
            if !seen.insert(
                person["id"]
                    .as_str()
                    .ok_or_else(|| Error::new("Invalid People row"))?,
            ) {
                continue;
            }
            let matched = matched
                .as_str()
                .ok_or_else(|| Error::new("Invalid People name"))?;
            out.push(json!({
                "name":person["display_name"],
                "role":one_line(&person["relationship_summary"])?,
                "note":one_line(&person["context_summary"])?,
                "matchedName":requested.get(&trim(matched).to_lowercase()).map(String::as_str).unwrap_or(matched),
            }));
        }
        Ok(out)
    }
}
