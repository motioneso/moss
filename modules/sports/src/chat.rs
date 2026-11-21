//! Chat adapters reuse the source card and follow route contracts.
use crate::{follow_tools, source_approval, teams::TeamList};
use moss_module_sdk::{Host, Result};
use serde_json::{json, Map, Value};

pub fn prepare<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, input: &Value) -> Result<Value> {
    let Some(tool) = input["tool"].as_str() else { return Ok(Value::Null) };
    let parameters = &input["parameters"];
    if source_approval::action(tool).is_some() {
        return Ok(source_approval::card(host, teams, tool, parameters)?.unwrap_or(Value::Null));
    }
    let action = match tool {
        follow_tools::FOLLOW => "Follow",
        follow_tools::UNFOLLOW => "Unfollow",
        _ => return Ok(Value::Null),
    };
    let Some(map) = parameters.as_object() else { return Ok(Value::Null) };
    let Ok((competition, team)) = follow_tools::keys(map, "follow") else { return Ok(Value::Null) };
    Ok(json!({"target":"Sports follows","fields":[
        {"label":"Action","value":action},
        {"label":"Competition","value":competition},
        {"label":"Team","value":team.as_deref().unwrap_or("Whole competition")}
    ]}))
}

pub fn change_follow<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, tool: &str, input: &Map<String, Value>) -> Result<Value> {
    let Ok((competition, team)) = follow_tools::keys(input, "follow") else {
        return if tool == follow_tools::FOLLOW { follow_tools::follow(host, teams, input) } else { follow_tools::unfollow(host, teams, input) };
    };
    let before = follow_tools::saved(host, teams, &competition, team.as_deref())?.is_some();
    let mut result = if tool == follow_tools::FOLLOW {
        follow_tools::follow(host, teams, input)?
    } else {
        follow_tools::unfollow(host, teams, input)?
    };
    if result["data"].get("error").is_none() {
        let after = if tool == follow_tools::FOLLOW { true } else { before && result["data"]["removed"] != true };
        result["data"]["changed"] = json!([
            {"label":"Competition","before":competition,"after":competition},
            {"label":"Team","before":team.as_deref().unwrap_or("Whole competition"),"after":team.as_deref().unwrap_or("Whole competition")},
            {"label":"Following","before":if before {"Following"} else {"Not followed"},"after":if after {"Following"} else {"Not followed"}}
        ]);
    }
    Ok(result)
}
