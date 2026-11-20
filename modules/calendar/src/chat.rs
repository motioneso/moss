//! Approval previews for Calendar's validated chat actions.
use crate::{events, plans, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub fn prepare(host: &impl Host, input: &Value) -> Result<Value> {
    let tool = input["tool"].as_str().unwrap_or("");
    let action = match tool {
        "calendar.createEvent" => "Create event",
        "calendar.deleteEvent" => "Delete event",
        "calendar.rescheduleEvent" => "Move event without guests",
        "calendar.dayPlanDraft" => "Save day-plan intent",
        _ => return Err(Error::new(400, "Unknown Calendar action")),
    };
    let parameters = input["parameters"]
        .as_object()
        .ok_or_else(|| Error::new(400, "Invalid Calendar card input"))?;
    let mut fields = vec![json!({"label":"Action","value":action})];
    if tool == "calendar.deleteEvent" {
        let id = input["parameters"]["eventId"].as_str().unwrap_or("");
        let event =
            events::get(host, id)?.ok_or_else(|| Error::new(404, "Calendar event not found"))?;
        fields.push(json!({"label":"Saved event","value":event["title"].as_str().unwrap_or("")}));
        fields
            .push(json!({"label":"Saved start","value":event["startsAt"].as_str().unwrap_or("")}));
    }
    if tool == "calendar.dayPlanDraft" {
        plans::get_by_id(host, input["parameters"]["planId"].as_str().unwrap_or(""))?;
    }
    for (key, value) in parameters {
        let label = match key.as_str() {
            "date" => "Date",
            "partOfDay" => "Part of day",
            "start" => "Start",
            "durationMinutes" => "Minutes",
            "title" => "Title",
            "eventId" => "Event ID",
            "displayTitle" => "Requested display title",
            "displayWhen" => "Requested display time",
            "eventRef" => "Event reference",
            "newStart" => "New start",
            "newEnd" => "New end",
            "planId" => "Plan ID",
            "expectedRevision" => "Expected revision",
            "eveningIntent" => "Evening intent",
            "additions" => "Task additions",
            _ => return Err(Error::new(400, "Unknown Calendar card field")),
        };
        fields.push(json!({"label":label,"value":value.as_str().map(str::to_owned).unwrap_or_else(||value.to_string())}));
    }
    Ok(json!({"fields":fields}))
}

pub fn completed(tool: &str, mut result: Value) -> Value {
    let label = match tool {
        "calendar.createEvent" => "Created calendar event",
        _ => return result,
    };
    let data = &result["data"];
    let ok = data["created"] == true;
    if ok {
        let after = data.to_string();
        if after.len() <= 8192 {
            result["data"]["changed"] =
                json!([{"label":label,"before":"No new event","after":after}]);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    struct NoCalls;
    impl Host for NoCalls {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> moss_module_sdk::Result<Value> {
            panic!("Preparing a create preview must not call a provider")
        }
    }
    #[test]
    fn requested_title_is_a_field_value_and_preparation_has_no_provider_effect() {
        let card = prepare(&NoCalls, &json!({"tool":"calendar.createEvent","parameters":{"title":"MODEL-MARKER","durationMinutes":60}})).unwrap();
        assert!(card.get("title").is_none());
        assert!(card.get("target").is_none());
        assert!(card["fields"]
            .as_array()
            .unwrap()
            .contains(&json!({"label":"Title","value":"MODEL-MARKER"})));
    }
    #[test]
    fn only_confirmed_creates_get_a_done_receipt() {
        let failed = json!({"data":{"created":false,"conflict":"busy"}});
        assert_eq!(completed("calendar.createEvent", failed.clone()), failed);
        let saved = completed(
            "calendar.createEvent",
            json!({"data":{"created":true,"resolvedStart":"2026-11-20T10:00:00Z"}}),
        );
        assert!(saved["data"]["changed"][0]["after"]
            .as_str()
            .unwrap()
            .contains("2026-11-20T10:00:00Z"));
    }
}
