//! Chat cards use code-owned labels and the exact validated input values.
use moss_module_sdk::{Error, Result};
use serde_json::{json, Value};

pub fn action(tool: &str) -> Option<&'static str> {
    match tool {
        "meals.kitchen.save" => Some("Kitchen save"),
        "meals.household.save" => Some("Household save"),
        "meals.household.remove" => Some("Household remove"),
        "meals.plan.create" => Some("Plan create"),
        "meals.plan.control" => Some("Plan control"),
        "meals.list.build" => Some("List build"),
        "meals.list.edit" => Some("List edit"),
        "meals.list.bought" => Some("List bought"),
        "meals.list.clear" => Some("List clear"),
        "meals.pantry.edit" => Some("Pantry edit"),
        "meals.log.add" => Some("Log add"),
        "meals.log.reestimate" => Some("Log reestimate"),
        "meals.log.correct" => Some("Log correct"),
        "meals.log.delete" => Some("Log delete"),
        "meals.meal.cooked" => Some("Meal cooked"),
        "meals.meal.rate" => Some("Meal rate"),
        "meals.undo" => Some("Undo"),
        "meals.plan.delete" => Some("Plan delete"),
        "meals.meal.servings" => Some("Meal servings"),
        "meals.meal.edit" => Some("Meal edit"),
        "meals.meal.swap" => Some("Meal swap"),
        "meals.day.edit" => Some("Day edit"),
        "meals.favourites.edit" => Some("Favourites edit"),
        _ => None,
    }
}
fn label(key: &str) -> Option<&'static str> {
    match key {
        "action" => Some("Action"),
        "actionId" => Some("Action id"),
        "allowRepeats" => Some("Allow repeats"),
        "calorieTarget" => Some("Calorie target"),
        "captureKind" => Some("Capture kind"),
        "carbTargetG" => Some("Carb target g"),
        "choiceId" => Some("Choice id"),
        "consumedAt" => Some("Consumed at"),
        "date" => Some("Date"),
        "dayId" => Some("Day id"),
        "days" => Some("Days"),
        "defaultPantryMode" => Some("Default pantry mode"),
        "description" => Some("Description"),
        "eaterIds" => Some("Eater ids"),
        "entryId" => Some("Entry id"),
        "expectedRevision" => Some("Expected revision"),
        "fatTargetG" => Some("Fat target g"),
        "fromLocalDate" => Some("From local date"),
        "idempotencyKey" => Some("Idempotency key"),
        "itemId" => Some("Item id"),
        "items" => Some("Items"),
        "limit" => Some("Limit"),
        "lineId" => Some("Line id"),
        "lineIds" => Some("Line ids"),
        "lines" => Some("Lines"),
        "linkedAccountEmail" => Some("Linked account email"),
        "listId" => Some("List id"),
        "localDate" => Some("Local date"),
        "maxMinutes" => Some("Max minutes"),
        "mealId" => Some("Meal id"),
        "mealPattern" => Some("Meal pattern"),
        "mealType" => Some("Meal type"),
        "mealTypes" => Some("Meal types"),
        "memberId" => Some("Member id"),
        "minutes" => Some("Minutes"),
        "name" => Some("Name"),
        "pantryMode" => Some("Pantry mode"),
        "planId" => Some("Plan id"),
        "preferences" => Some("Preferences"),
        "proteinTargetG" => Some("Protein target g"),
        "quantity" => Some("Quantity"),
        "ratings" => Some("Ratings"),
        "recipeId" => Some("Recipe id"),
        "requestText" => Some("Request text"),
        "restrictions" => Some("Restrictions"),
        "section" => Some("Section"),
        "servingNote" => Some("Serving note"),
        "servings" => Some("Servings"),
        "sharing" => Some("Sharing"),
        "slotName" => Some("Slot name"),
        "slotRules" => Some("Slot rules"),
        "stapleId" => Some("Staple id"),
        "startDate" => Some("Start date"),
        "target" => Some("Target"),
        "targetDate" => Some("Target date"),
        "targetDayId" => Some("Target day id"),
        "targetSlotName" => Some("Target slot name"),
        "text" => Some("Text"),
        "timeZone" => Some("Time zone"),
        "toLocalDate" => Some("To local date"),
        "unit" => Some("Unit"),
        "unitsSystem" => Some("Units system"),
        _ => None,
    }
}
pub fn prepare(input: &Value) -> Result<Value> {
    let action = input["tool"]
        .as_str()
        .and_then(action)
        .ok_or_else(|| Error::new("Unknown Meals action"))?;
    let params = input["parameters"]
        .as_object()
        .ok_or_else(|| Error::new("Invalid Meals card input"))?;
    let mut fields = vec![json!({"label":"Action","value":action})];
    for (key, value) in params {
        let label = label(key).ok_or_else(|| Error::new("Unknown Meals card field"))?;
        fields.push(json!({"label":label,"value":value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string())}));
    }
    Ok(json!({"fields":fields}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_values_only_fill_code_labelled_fields() {
        let card =
            prepare(&json!({"tool":"meals.household.save","parameters":{"name":"MODEL-MARKER"}}))
                .unwrap();
        assert!(card.get("title").is_none());
        assert!(card.get("target").is_none());
        assert_eq!(
            card["fields"][0],
            json!({"label":"Action","value":"Household save"})
        );
        assert_eq!(
            card["fields"][1],
            json!({"label":"Name","value":"MODEL-MARKER"})
        );
    }
}
