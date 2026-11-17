//! What the connection list and detail routes return. Ports `derive-groups.ts`, `curation.ts`,
//! `discovery.ts` (`toDetail`) and the sort view of `classifier-standing.ts`.
//!
//! Tool preparation is not ported, so no tool is ever "ready". Every tool that would wait on a
//! preparation reads as `preparing`.
use crate::store::Row;
use moss_integrations::sortmap::{tool_sort_state, SortFailure, ToolSort};
use moss_integrations::{attempt_live, names::readable_tool_names, tool::Tool};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const LIVE_TOOL_THRESHOLD: usize = 30;
pub const OTHER_GROUP: &str = "Other";
const MAX_GROUP_SIZE: usize = 12;
const MIN_GROUP_SIZE: usize = 3;

fn split_segments(name: &str) -> Vec<String> {
    let mut spaced = String::new();
    let mut prev_lower_or_digit = false;
    let mut in_separator = false;
    for ch in name.chars() {
        if matches!(ch, '_' | '-' | '.') {
            if !in_separator {
                spaced.push(' ');
            }
            in_separator = true;
            prev_lower_or_digit = false;
            continue;
        }
        in_separator = false;
        if prev_lower_or_digit && ch.is_ascii_uppercase() {
            spaced.push(' ');
        }
        prev_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        spaced.push(ch);
    }
    spaced.split(' ').filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

fn drop_shared_leading(mut segmented: Vec<Vec<String>>) -> Vec<Vec<String>> {
    loop {
        let non_empty: Vec<&Vec<String>> = segmented.iter().filter(|s| !s.is_empty()).collect();
        if non_empty.is_empty() {
            break;
        }
        let mut counts: Vec<(String, usize)> = Vec::new();
        for segs in &non_empty {
            match counts.iter_mut().find(|(lead, _)| lead == &segs[0]) {
                Some((_, n)) => *n += 1,
                None => counts.push((segs[0].clone(), 1)),
            }
        }
        let half = non_empty.len() as f64 / 2.0;
        let Some((lead, _)) = counts.into_iter().find(|(_, n)| *n as f64 > half) else {
            break;
        };
        segmented = segmented
            .into_iter()
            .map(|segs| if !segs.is_empty() && segs[0] == lead { segs[1..].to_vec() } else { segs })
            .collect();
    }
    segmented
}

fn group_by_segment(segmented: Vec<Vec<String>>) -> Vec<String> {
    drop_shared_leading(segmented)
        .into_iter()
        .map(|segs| segs.first().cloned().unwrap_or_else(|| OTHER_GROUP.to_owned()))
        .collect()
}

fn indices_by_group(groups: &[String]) -> Vec<(String, Vec<usize>)> {
    let mut out: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, g) in groups.iter().enumerate() {
        match out.iter_mut().find(|(name, _)| name == g) {
            Some((_, idx)) => idx.push(i),
            None => out.push((g.clone(), vec![i])),
        }
    }
    out
}

fn split_oversized(indices: &[usize], segmented: &[Vec<String>], depth: usize) -> BTreeMap<usize, String> {
    let sub: Vec<Vec<String>> =
        indices.iter().map(|&i| segmented[i].iter().skip(depth).cloned().collect()).collect();
    let sub_groups = group_by_segment(sub);
    let mut result = BTreeMap::new();
    let mut by_group: Vec<(String, Vec<usize>)> = Vec::new();
    for (j, g) in sub_groups.iter().enumerate() {
        let idx = indices[j];
        match by_group.iter_mut().find(|(name, _)| name == g) {
            Some((_, list)) => list.push(idx),
            None => by_group.push((g.clone(), vec![idx])),
        }
    }
    for (g, idxs) in by_group {
        if g != OTHER_GROUP && idxs.len() > MAX_GROUP_SIZE {
            result.extend(split_oversized(&idxs, segmented, depth + 1));
        } else {
            for i in idxs {
                result.insert(i, g.clone());
            }
        }
    }
    result
}

/// `deriveGroups`: one group name per tool name.
pub fn derive_groups(names: &[String]) -> Vec<String> {
    let segmented: Vec<Vec<String>> = names.iter().map(|n| split_segments(n)).collect();
    let mut groups = group_by_segment(segmented.clone());
    for (g, idxs) in indices_by_group(&groups) {
        if g == OTHER_GROUP || idxs.len() <= MAX_GROUP_SIZE {
            continue;
        }
        for (i, name) in split_oversized(&idxs, &segmented, 1) {
            groups[i] = name;
        }
    }
    let counts = indices_by_group(&groups);
    let size = |g: &str| counts.iter().find(|(n, _)| n == g).map_or(0, |(_, v)| v.len());
    groups
        .iter()
        .map(|g| if g != OTHER_GROUP && size(g) < MIN_GROUP_SIZE { OTHER_GROUP.to_owned() } else { g.clone() })
        .collect()
}

/// True when derived groups apply: over the threshold and no service-supplied group.
pub fn will_derive_groups(tools: &[Tool]) -> bool {
    tools.len() > LIVE_TOOL_THRESHOLD && tools.iter().all(|t| t.group.is_empty())
}

pub fn with_derived_groups(tools: &[Tool]) -> Vec<Tool> {
    if !will_derive_groups(tools) {
        return tools.to_vec();
    }
    let names: Vec<String> = tools.iter().map(|t| t.name.clone()).collect();
    let derived = derive_groups(&names);
    tools.iter().zip(derived).map(|(t, g)| Tool { group: g, ..t.clone() }).collect()
}

pub fn is_group_opt_in(count: usize) -> bool {
    count > LIVE_TOOL_THRESHOLD
}

/// `effectiveEnabledTools`.
pub fn effective_enabled_tools(tools: &[Tool], groups: &[String], enabled: &[String], muted: &[String]) -> Vec<Tool> {
    let muted: BTreeSet<&String> = muted.iter().collect();
    let derived_other = will_derive_groups(tools);
    let with_groups = with_derived_groups(tools);
    if !is_group_opt_in(with_groups.len()) {
        return with_groups.into_iter().filter(|t| !muted.contains(&t.name)).collect();
    }
    let groups: BTreeSet<&String> = groups.iter().collect();
    let explicit: BTreeSet<&String> = enabled.iter().collect();
    with_groups
        .into_iter()
        .filter(|t| {
            if muted.contains(&t.name) {
                return false;
            }
            if explicit.contains(&t.name) {
                return true;
            }
            if derived_other && t.group == OTHER_GROUP {
                return false;
            }
            groups.contains(&t.group)
        })
        .collect()
}

fn iso(row_time: &Option<String>) -> Value {
    row_time.as_ref().map_or(Value::Null, |t| json!(t))
}

pub fn summary(row: &Row) -> Value {
    let enabled = effective_enabled_tools(&row.discovered_tools, &row.enabled_groups, &row.enabled_tools, &row.muted_tools);
    json!({
        "id": row.id, "name": row.name, "kind": row.kind, "url": row.url, "enabled": row.enabled,
        "hasCredential": row.has_credential, "toolCount": row.discovered_tools.len(),
        "enabledToolCount": enabled.len(), "lastDiscoveryAt": iso(&row.last_discovery_at),
        "lastError": row.last_error,
    })
}

fn tool_json(tool: &Tool) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), json!(tool.name));
    out.insert("description".into(), json!(tool.description));
    out.insert("group".into(), json!(tool.group));
    out.insert("inputSchema".into(), tool.input_schema.clone().unwrap_or(Value::Null));
    for (key, value) in [("readOnly", tool.read_only), ("idempotent", tool.idempotent), ("destructive", tool.destructive)] {
        if let Some(v) = value {
            out.insert(key.into(), json!(v));
        }
    }
    Value::Object(out)
}

/// Options for the sort view.
#[derive(Clone, Copy, Default)]
pub struct ViewOptions {
    pub model_ready: bool,
    pub now_ms: i64,
}

/// `classifierSortView` without preparation, one entry per discovered tool.
pub fn sort_view(row: &Row, options: ViewOptions) -> Vec<Value> {
    let tools = &row.discovered_tools;
    let free = readable_tool_names(tools);
    let kept_out: BTreeSet<&String> = row.classifier_kept_out_tools.iter().collect();
    let ordinary: BTreeSet<String> =
        effective_enabled_tools(tools, &row.enabled_groups, &row.enabled_tools, &row.muted_tools)
            .into_iter()
            .map(|t| t.name)
            .collect();
    tools
        .iter()
        .map(|tool| {
            let sort = shown_sort(tool_sort_state(&row.classifier_sort, tool), options.now_ms);
            let state = standing_state(row, tool, &sort, &kept_out, &ordinary, options);
            let failed_at = match (&state, &sort) {
                (Standing::Failed, ToolSort::Failed { failed_at, .. }) => Some(failed_at.clone()),
                (_, ToolSort::Failed { failed_at, .. }) => Some(failed_at.clone()),
                _ => None,
            };
            let (status, risk, failure, sent, name, at, by, method) = match &sort {
                ToolSort::Current { risk, readable_name, sorted_at, sorted_by, sort_method, send_without_asking } => (
                    "current",
                    json!(risk.name()),
                    Value::Null,
                    *send_without_asking,
                    readable_name.clone(),
                    json!(sorted_at),
                    sorted_by.as_ref().map_or(Value::Null, |b| json!({"model": b.model, "provider": b.provider})),
                    sort_method.map_or(Value::Null, |m| json!(m.name())),
                ),
                ToolSort::Failed { failure, .. } => (
                    "failed",
                    Value::Null,
                    json!(shown_failure(*failure)),
                    false,
                    free.get(&tool.name).cloned().unwrap_or_else(|| tool.name.clone()),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                ),
                other => (
                    if matches!(other, ToolSort::Stale) { "stale" } else { "never_tried" },
                    Value::Null,
                    Value::Null,
                    false,
                    free.get(&tool.name).cloned().unwrap_or_else(|| tool.name.clone()),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                ),
            };
            json!({
                "toolName": tool.name, "status": status, "risk": risk, "failure": failure,
                "sendWithoutAsking": sent,
                "asksFirst": !moss_integrations::sortmap::runs_without_asking(&sort),
                "readableName": name, "sortedAt": at, "sortedBy": by, "sortMethod": method,
                "failedAt": failed_at.map_or(Value::Null, Value::String),
                "keptOut": kept_out.contains(&tool.name),
                "classifierState": state.name(),
                "preparationFailure": if matches!(state, Standing::Failed) { json!("no_model") } else { Value::Null },
                "preparedAt": Value::Null,
            })
        })
        .collect()
}

fn shown_failure(failure: SortFailure) -> &'static str {
    match failure {
        SortFailure::Interrupted => "error",
        other => other.name(),
    }
}

/// A sorting call that may still be running reads as not yet sorted.
fn shown_sort(sort: ToolSort, now_ms: i64) -> ToolSort {
    match sort {
        ToolSort::Failed { failure: SortFailure::Interrupted, failed_at } => {
            if attempt_live(&failed_at, now_ms) {
                ToolSort::NeverTried
            } else {
                ToolSort::Failed { failure: SortFailure::Error, failed_at }
            }
        }
        other => other,
    }
}

enum Standing {
    Off,
    KeptOut,
    NotUsed,
    Preparing,
    Failed,
}

impl Standing {
    fn name(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::KeptOut => "kept_out",
            Self::NotUsed => "not_used",
            Self::Preparing => "preparing",
            Self::Failed => "failed",
        }
    }
}

fn standing_state(
    row: &Row,
    tool: &Tool,
    sort: &ToolSort,
    kept_out: &BTreeSet<&String>,
    ordinary: &BTreeSet<String>,
    options: ViewOptions,
) -> Standing {
    if !row.classifier_enabled {
        return Standing::Off;
    }
    if kept_out.contains(&tool.name) {
        return Standing::KeptOut;
    }
    if !ordinary.contains(&tool.name) {
        return Standing::NotUsed;
    }
    match sort {
        ToolSort::Failed { failure: SortFailure::NoModel, .. } => {
            if options.model_ready {
                Standing::Preparing
            } else {
                Standing::Failed
            }
        }
        ToolSort::Failed { .. } => Standing::NotUsed,
        _ => Standing::Preparing,
    }
}

/// `toDetail`.
pub fn detail(row: &Row, options: ViewOptions) -> Value {
    let tools = &row.discovered_tools;
    let enabled = effective_enabled_tools(tools, &row.enabled_groups, &row.enabled_tools, &row.muted_tools);
    let with_groups = with_derived_groups(tools);
    let derived_other = will_derive_groups(tools);
    let mut names: Vec<String> = Vec::new();
    for t in &with_groups {
        if !names.contains(&t.group) {
            names.push(t.group.clone());
        }
    }
    // Stable sort that sends the "Other" group last, like the old comparator.
    names.sort_by_key(|n| n == OTHER_GROUP);
    let groups: Vec<Value> = names
        .iter()
        .map(|name| {
            json!({
                "name": name,
                "toolCount": with_groups.iter().filter(|t| &t.group == name).count(),
                "enabled": if derived_other && name == OTHER_GROUP { false } else { row.enabled_groups.contains(name) },
            })
        })
        .collect();
    json!({
        "id": row.id, "name": row.name, "kind": row.kind, "url": row.url, "enabled": row.enabled,
        "hasCredential": row.has_credential, "toolCount": tools.len(), "enabledToolCount": enabled.len(),
        "lastDiscoveryAt": iso(&row.last_discovery_at), "lastError": row.last_error,
        "credentialPlacement": row.credential_placement,
        "tools": with_groups.iter().map(tool_json).collect::<Vec<_>>(),
        "groups": groups,
        "enabledGroups": row.enabled_groups, "enabledTools": row.enabled_tools, "mutedTools": row.muted_tools,
        "unsuppressedTools": row.unsuppressed_tools,
        "groupOptIn": is_group_opt_in(tools.len()),
        "specPasted": row.spec_pasted, "classifierEnabled": row.classifier_enabled,
        "classifierTools": sort_view(row, options),
    })
}
