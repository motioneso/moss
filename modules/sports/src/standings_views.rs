//! The standings picker's views: the whole league, each conference, and each division or group.
use serde_json::{json, Value};

fn label_of(section: &Value, index: usize) -> String {
    section["label"].as_str().map(str::to_owned).unwrap_or_else(|| format!("Group {}", index + 1))
}

/// "All" first, then for each conference a whole-conference view followed by its divisions. A
/// flat table collapses to "All" plus one view per group.
pub fn build_views(sections: &[Value]) -> Vec<Value> {
    if sections.is_empty() {
        return vec![];
    }
    let all = json!({"key": "all", "label": "All", "conference": null, "sections": sections});
    let conference = |s: &Value| s["conference"].as_str().filter(|c| !c.is_empty()).map(str::to_owned);
    if !sections.iter().any(|s| conference(s).is_some()) {
        if sections.len() == 1 {
            return vec![all];
        }
        let mut views = vec![all];
        for (i, s) in sections.iter().enumerate() {
            views.push(json!({"key": format!("sec:{i}"), "label": label_of(s, i), "conference": null, "sections": [s]}));
        }
        return views;
    }
    let mut order: Vec<String> = vec![];
    let mut members: Vec<Vec<(usize, &Value)>> = vec![];
    for (i, s) in sections.iter().enumerate() {
        let c = conference(s).unwrap_or_default();
        match order.iter().position(|o| *o == c) {
            Some(at) => members[at].push((i, s)),
            None => {
                order.push(c);
                members.push(vec![(i, s)]);
            }
        }
    }
    let mut views = vec![all];
    for (c, group) in order.iter().zip(&members) {
        if !c.is_empty() {
            let inside: Vec<&Value> = group.iter().map(|(_, s)| *s).collect();
            views.push(json!({"key": format!("conf:{c}"), "label": c, "conference": c, "sections": inside}));
        }
        for (i, s) in group {
            views.push(json!({
                "key": format!("sec:{i}"), "label": label_of(s, *i),
                "conference": if c.is_empty() { Value::Null } else { json!(c) }, "sections": [s],
            }));
        }
    }
    views
}
