//! Replays the fixtures the old code produced (see tools/sorting-oracle.ts) and lists every
//! disagreement. The native tests and the WebAssembly export both run this.
use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    names::readable_tool_names,
    sort::{self, CredentialMatcher, TargetsInput},
    sortmap::{self, SortFailure, SortMethod, SortResult, SortedBy},
    tool::{risk_inputs, sort_fingerprint, Risk, Tool},
};

const CASES: &str = include_str!("../fixtures/sorting-cases.json");

struct Run {
    failures: Vec<String>,
}

impl Run {
    fn same(&mut self, label: impl Into<String>, got: Value, want: &Value) {
        if &got != want {
            self.failures.push(format!("{}: got {got} want {want}", label.into()));
        }
    }
}

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn decode_result(value: &Value) -> Option<(String, SortResult)> {
    let name = value["toolName"].as_str()?.to_owned();
    let r = &value["result"];
    let text = |k: &str| r[k].as_str().map(str::to_owned);
    let result = if r["status"] == "failed" {
        SortResult::Failed {
            failure: SortFailure::parse(r["failure"].as_str()?)?,
            fingerprint: text("sortFingerprint")?,
            sorted_at: text("sortedAt")?,
        }
    } else {
        SortResult::Current {
            risk: Risk::parse(r["risk"].as_str()?)?,
            readable_name: text("readableName")?,
            fingerprint: text("sortFingerprint")?,
            sorted_at: text("sortedAt")?,
            sorted_by: r["sortedBy"].as_object().map(|o| SortedBy {
                model: o["model"].as_str().unwrap_or_default().into(),
                provider: o["provider"].as_str().unwrap_or_default().into(),
            }),
            method: match r["sortMethod"].as_str() {
                Some("model") => Some(SortMethod::Model),
                Some("local") => Some(SortMethod::Local),
                _ => None,
            },
        }
    };
    Some((name, result))
}

fn result_json(entry: &sort::ToolResult) -> Value {
    match &entry.result {
        SortResult::Failed { failure, fingerprint, sorted_at } => json!({
            "toolName": entry.tool_name,
            "result": {"status": "failed", "failure": failure.name(), "sortFingerprint": fingerprint, "sortedAt": sorted_at}
        }),
        SortResult::Current { risk, readable_name, fingerprint, sorted_at, method, .. } => json!({
            "toolName": entry.tool_name,
            "result": {"status": "current", "risk": risk.name(), "readableName": readable_name,
                "sortFingerprint": fingerprint, "sortedAt": sorted_at, "sortMethod": method.map(SortMethod::name)}
        }),
    }
}

/// Every disagreement between this crate and the old code. Empty means they match.
pub fn failures() -> Vec<String> {
    let cases: Value = serde_json::from_str(CASES).expect("fixtures parse");
    let tools: Vec<Tool> = serde_json::from_value(cases["tools"].clone()).expect("tools parse");
    let mut run = Run { failures: vec![] };
    let now = cases["now"].as_i64().unwrap_or_default();
    let by_name = |n: &str| tools.iter().find(|t| t.name == n);

    for tool in &tools {
        let n = &tool.name;
        run.same(format!("fingerprint {n}"), json!(sort_fingerprint(tool)), &cases["fingerprints"][n]);
        run.same(format!("risk inputs {n}"), risk_inputs(tool), &cases["riskInputs"][n]);
        run.same(format!("payload {n}"), json!(sort::tool_payload(tool, "t1").to_string()), &cases["payloads"][n]);
        let headers: BTreeSet<String> = tool
            .invoke
            .iter()
            .flat_map(|i| i.params.iter())
            .filter(|p| p.location == "header")
            .map(|p| p.name.clone())
            .collect();
        run.same(
            format!("reduced {n}"),
            json!(sort::reduce_input_schema(tool.input_schema.as_ref(), &headers).to_string()),
            &cases["reduced"][n],
        );
        let groups = [Some("looks_things_up"), Some("changes_things"), Some("sends_things_out"), Some("sensitive"), None];
        let risks: Vec<&str> = groups.iter().map(|g| sort::sorted_tool_risk(*g, tool).name()).collect();
        run.same(format!("risk {n}"), json!(risks), &cases["risks"][n]);
    }

    run.same("free names", json!(readable_tool_names(&tools)), &cases["freeNames"]);
    for (i, set) in cases["freeNameSets"].as_array().into_iter().flatten().enumerate() {
        let picked: Vec<Tool> = set["idx"].as_array().into_iter().flatten().filter_map(|v| tools.get(v.as_u64()? as usize).cloned()).collect();
        run.same(format!("free name set {i}"), json!(readable_tool_names(&picked)), &set["names"]);
    }

    let empty = sort::build_prompt("[]");
    run.same("empty prompt", json!({"sha": sha(&empty), "len": empty.len()}), &cases["emptyPrompt"]);

    let texts = strings(&cases["matcher"]["texts"]);
    for case in cases["matcher"]["cases"].as_array().into_iter().flatten() {
        let m = CredentialMatcher::new(case["credential"].as_str());
        let got: Vec<bool> = texts.iter().map(|t| m.contains(t)).collect();
        run.same(format!("matcher {}", case["credential"]), json!(got), &case["results"]);
    }

    for plan_case in cases["plans"].as_array().into_iter().flatten() {
        let m = CredentialMatcher::new(plan_case["credential"].as_str());
        let plan = sort::plan_calls(&tools, &m);
        let label = format!("plan {}", plan_case["credential"]);
        run.same(format!("{label} unsafe"), json!(plan.unsafe_tools.iter().map(|t| &t.name).collect::<Vec<_>>()), &plan_case["unsafe"]);
        run.same(format!("{label} oversized"), json!(plan.oversized.iter().map(|t| &t.name).collect::<Vec<_>>()), &plan_case["oversized"]);
        let calls: Vec<Value> = plan
            .calls
            .iter()
            .map(|c| {
                let prompt = sort::call_prompt(c);
                json!({
                    "ids": c.iter().map(|e| &e.id).collect::<Vec<_>>(),
                    "names": c.iter().map(|e| &e.tool.name).collect::<Vec<_>>(),
                    "serialized": c.iter().map(|e| &e.serialized).collect::<Vec<_>>(),
                    "promptSha": sha(&prompt),
                    "promptLen": prompt.len(),
                })
            })
            .collect();
        run.same(format!("{label} calls"), json!(calls), &plan_case["calls"]);
    }

    let none = CredentialMatcher::new(None);
    let many: Vec<Tool> = (0..70).map(|i| Tool { name: format!("bulk_tool_{i}"), description: format!("Tool {i}"), ..Tool::default() }).collect();
    let rows: Vec<String> = sort::plan_calls(&many, &none).calls.iter().map(|c| c.iter().map(|e| e.id.clone()).collect::<Vec<_>>().join(",")).collect();
    run.same("many plan", json!(rows), &cases["manyPlan"]);
    let wide: Vec<Tool> = (0..20).map(|i| Tool { name: format!("wide_{i}"), description: "d".repeat(7800), ..Tool::default() }).collect();
    let wide_plan = sort::plan_calls(&wide, &none);
    let got = json!({"calls": wide_plan.calls.iter().map(Vec::len).collect::<Vec<_>>(), "oversized": wide_plan.oversized.len()});
    run.same("wide plan", got, &cases["widePlan"]);

    for (i, case) in cases["answers"].as_array().into_iter().flatten().enumerate() {
        let ids = strings(&case["ids"]);
        let parsed = sort::parse_answer(&case["raw"], &ids);
        let got: BTreeMap<&String, Value> = parsed.iter().map(|(k, a)| (k, json!({"group": a.group, "name": a.name}))).collect();
        run.same(format!("answer {i}"), json!(got), &case["parsed"]);
    }

    for case in cases["targets"].as_array().into_iter().flatten() {
        let map = sortmap::parse_sort_map(&case["map"]);
        let input = TargetsInput {
            tools: &tools,
            sort: &map,
            retry_failed: case["retryFailed"] == true,
            retry_no_model: case["retryNoModel"] == true,
            now_ms: now,
        };
        let names: Vec<String> = sort::sorting_targets(&input).into_iter().map(|t| t.name).collect();
        run.same(format!("targets {}", case["index"]), json!(names), &case["names"]);
    }

    for case in cases["attempts"].as_array().into_iter().flatten() {
        let started = case["startedAt"].as_str().unwrap_or_default();
        run.same(format!("attempt {started}"), json!(crate::attempt_live(started, now)), &case["live"]);
    }

    let plan = sort::plan_calls(&tools, &CredentialMatcher::new(Some("SECRET-KEY-123")));
    let free = readable_tool_names(&tools);
    let at = "2026-11-17T12:00:00.000Z";
    let without: Vec<Value> = sort::results_without_call(&plan, &free, at).iter().map(result_json).collect();
    run.same("results without call", json!(without), &cases["resultsWithoutCall"]);
    let failed: Vec<Value> = sort::failed_results(&tools[..2], SortFailure::NoModel, at).iter().map(result_json).collect();
    run.same("failed results", json!(failed), &cases["failedResults"]);

    let mut map = sortmap::SortMap::default();
    for (i, step) in cases["sortMap"]["steps"].as_array().into_iter().flatten().enumerate() {
        let s = &step["step"];
        match s["op"].as_str() {
            Some("results") => {
                let results: Vec<(String, SortResult)> = s["results"].as_array().into_iter().flatten().filter_map(decode_result).collect();
                map = sortmap::with_tool_sort_results(&map, &tools, &results);
            }
            Some("send") => {
                let tool = by_name(s["tool"].as_str().unwrap_or_default());
                let next = tool.and_then(|t| sortmap::with_send_without_asking(&map, t, s["allow"] == true));
                run.same(format!("step {i} send result"), json!(if next.is_some() { "ok" } else { "refused" }), &step["result"]);
                if let Some(next) = next {
                    map = next;
                }
            }
            _ => {
                let kept: Vec<Tool> = serde_json::from_value(s["tools"].clone()).unwrap_or_default();
                map = sortmap::without_stale_send_choices(&map, &kept);
            }
        }
        run.same(format!("step {i} map"), sortmap::sort_map_json(&map), &step["map"]);
        for tool in &tools {
            let state = sortmap::tool_sort_state(&map, tool);
            let got = json!({"state": sortmap::tool_sort_state_json(&state), "runs": sortmap::runs_without_asking(&state)});
            run.same(format!("step {i} state {}", tool.name), got, &step["states"][&tool.name]);
        }
    }
    for (i, case) in cases["sortMap"]["garbage"].as_array().into_iter().flatten().enumerate() {
        let parsed = sortmap::sort_map_json(&sortmap::parse_sort_map(&case["input"]));
        run.same(format!("garbage {i}"), parsed, &case["parsed"]);
    }
    run.failures
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_the_old_code() {
        let failures = super::failures();
        assert!(failures.is_empty(), "{} disagreements, first: {:?}", failures.len(), &failures[..failures.len().min(5)]);
    }
}
