mod common;
use common::{Fake, A, B};
use moss_meals_module::md5::uuid_of;
use serde_json::json;

const KITCHENS: &str = "app.meals_kitchens";
const MEMBERS: &str = "app.meals_household_members";
const RULES: &str = "app.meals_meal_slot_rules";

#[test]
fn a_new_person_reads_the_default_kitchen_without_anything_being_stored() {
    let f = Fake::new();
    let kitchen = f.ok("meals.kitchen.get", json!({}));
    assert_eq!(kitchen["kitchenId"], uuid_of(&format!("meals.kitchen:{A}")));
    assert_eq!(kitchen["unitsSystem"], "us");
    assert_eq!(kitchen["defaultPantryMode"], "prefer");
    assert_eq!(kitchen["slotRules"], json!([]));
    let members = kitchen["members"].as_array().unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0]["name"], "You");
    assert_eq!(members[0]["isSelf"], true);
    assert_eq!(members[0]["memberId"], uuid_of(&format!("meals.self:{A}")));
    assert_eq!(
        members[0]["mealPattern"],
        json!(["breakfast", "lunch", "dinner"])
    );
    assert_eq!(members[0]["favouriteRecipeIds"], json!([]));
    assert!(
        f.rows(KITCHENS).is_empty() && f.rows(MEMBERS).is_empty(),
        "a read must not write"
    );
    assert!(
        f.calls.borrow().iter().all(|c| c.1 != "uuid"),
        "a read must not mint ids"
    );
}

#[test]
fn the_first_save_stores_the_same_ids_the_default_read_showed() {
    let f = Fake::new();
    let before = f.ok("meals.kitchen.get", json!({}));
    let saved = f.ok(
        "meals.kitchen.save",
        json!({"unitsSystem":"metric","defaultPantryMode":"only"}),
    );
    assert_eq!(saved["kitchenId"], before["kitchenId"]);
    assert_eq!(
        saved["members"][0]["memberId"],
        before["members"][0]["memberId"]
    );
    assert_eq!(saved["unitsSystem"], "metric");
    assert_eq!(saved["defaultPantryMode"], "only");
    assert_eq!(f.rows(KITCHENS).len(), 1);
    assert_eq!(f.rows(MEMBERS).len(), 1);
    // A repeat save adds no second kitchen and no second "You".
    f.ok("meals.kitchen.save", json!({"unitsSystem":"us"}));
    assert_eq!((f.rows(KITCHENS).len(), f.rows(MEMBERS).len()), (1, 1));
    assert_eq!(f.ok("meals.kitchen.get", json!({}))["unitsSystem"], "us");
}

#[test]
fn slot_rules_are_cleaned_and_replace_the_stored_rule_for_that_meal() {
    let f = Fake::new();
    let saved = f.ok(
        "meals.kitchen.save",
        json!({"slotRules":[
            {"slotName":"  Lunch ","soloWeekdays":[5,1,5,3],"usualTime":"12:30"},
            {"slotName":"dinner","soloWeekdays":[]}
        ]}),
    );
    assert_eq!(
        saved["slotRules"],
        json!([
            {"slotName":"lunch","soloWeekdays":[1,3,5],"usualTime":"12:30"},
            {"slotName":"dinner","soloWeekdays":[],"usualTime":null}
        ]),
    );
    let rules = f.rows(RULES);
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0]["solo_weekdays"], json!([1, 3, 5]));
    assert_eq!(rules[0]["usual_time"], "12:30");
    f.ok(
        "meals.kitchen.save",
        json!({"slotRules":[{"slotName":"LUNCH","soloWeekdays":[7],"usualTime":null}]}),
    );
    let rules = f.rows(RULES);
    assert_eq!(rules.len(), 2, "one row per slot name");
    assert_eq!(rules[0]["solo_weekdays"], json!([7]));
    assert!(rules[0]["usual_time"].is_null());
}

#[test]
fn household_members_can_be_added_changed_cleared_and_removed() {
    let f = Fake::new();
    let ana = f.ok(
        "meals.household.save",
        json!({"name":" Ana ","calorieTarget":2000,"proteinTargetG":120,"mealPattern":["Breakfast","BREAKFAST","Dinner"],
               "restrictions":["Peanuts","peanuts","Shellfish"],"preferences":["spicy"],"linkedAccountEmail":"ana@example.com"}),
    );
    assert_eq!(ana["name"], "Ana");
    assert_eq!(ana["isSelf"], false);
    assert_eq!(ana["calorieTarget"], 2000);
    assert_eq!(
        ana["macroTargets"],
        json!({"proteinG":120,"carbG":null,"fatG":null})
    );
    assert_eq!(ana["mealPattern"], json!(["breakfast", "dinner"]));
    assert_eq!(ana["restrictions"], json!(["Peanuts", "Shellfish"]));
    let id = ana["memberId"].as_str().unwrap().to_owned();

    let changed = f.ok(
        "meals.household.save",
        json!({"memberId":id,"calorieTarget":null,"linkedAccountEmail":null,"name":"Ana B"}),
    );
    assert_eq!(
        (changed["name"].clone(), changed["calorieTarget"].clone()),
        (json!("Ana B"), json!(null))
    );
    assert!(changed["linkedAccountEmail"].is_null());
    assert_eq!(
        changed["macroTargets"]["proteinG"], 120,
        "an untouched target stays"
    );

    let kitchen = f.ok("meals.kitchen.get", json!({}));
    let names: Vec<_> = kitchen["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["You", "Ana B"], "self first, then by order added");

    assert_eq!(
        f.ok("meals.household.remove", json!({"memberId":id})),
        json!({"removed":true})
    );
    assert_eq!(
        f.ok("meals.household.remove", json!({"memberId":id})),
        json!({"removed":false})
    );
}

#[test]
fn the_self_member_cannot_be_removed_even_before_the_first_save() {
    let f = Fake::new();
    let me = uuid_of(&format!("meals.self:{A}"));
    assert_eq!(
        f.refused("meals.household.remove", json!({"memberId":me})),
        (
            "self_member".into(),
            "the self member cannot be removed".into()
        )
    );
    f.ok("meals.kitchen.save", json!({}));
    assert_eq!(
        f.refused("meals.household.remove", json!({"memberId":me}))
            .0,
        "self_member"
    );
    assert_eq!(f.rows(MEMBERS).len(), 1);
}

#[test]
fn bad_input_gets_the_same_words_as_the_old_tools() {
    let f = Fake::new();
    let bad = |tool: &str, input: serde_json::Value, message: &str| {
        assert_eq!(
            f.refused(tool, input),
            ("invalid_input".into(), message.into())
        );
    };
    bad("meals.kitchen.get", json!({"x":1}), "unknown key: x");
    bad(
        "meals.kitchen.save",
        json!({"unitsSystem":"stone"}),
        "unitsSystem must be one of: us, metric",
    );
    bad(
        "meals.kitchen.save",
        json!({"slotRules":[1]}),
        "slotRules entries must be objects",
    );
    bad(
        "meals.kitchen.save",
        json!({"slotRules":[1,2,3,4,5,6,7]}),
        "slotRules must be an array of at most 6 rules",
    );
    bad(
        "meals.kitchen.save",
        json!({"slotRules":[{"slotName":"a","soloWeekdays":[8]}]}),
        "soloWeekdays must hold ISO weekdays, 1 (Monday) to 7 (Sunday)",
    );
    bad(
        "meals.kitchen.save",
        json!({"slotRules":[{"slotName":"a","soloWeekdays":[],"usualTime":"24:00"}]}),
        "usualTime must be HH:MM or null",
    );
    bad("meals.household.save", json!({}), "name is required");
    bad(
        "meals.household.save",
        json!({"name":"  "}),
        "name must be 1 to 80 characters",
    );
    bad(
        "meals.household.save",
        json!({"name":"A","calorieTarget":799}),
        "calorieTarget must be at least 800",
    );
    bad(
        "meals.household.save",
        json!({"name":"A","calorieTarget":1.5}),
        "calorieTarget must be an integer",
    );
    bad(
        "meals.household.save",
        json!({"name":"A","fatTargetG":401}),
        "fatTargetG must be at most 400",
    );
    bad(
        "meals.household.save",
        json!({"name":"A","linkedAccountEmail":"nobody"}),
        "linkedAccountEmail must be an email address",
    );
    bad(
        "meals.household.save",
        json!({"name":"A","mealPattern":[]}),
        "mealPattern must hold 1 to 6 entries",
    );
    bad(
        "meals.household.save",
        json!({"name":"A","restrictions":[""]}),
        "restrictions entries must be 1 to 80 characters",
    );
    bad(
        "meals.household.save",
        json!({"memberId":"nope"}),
        "memberId must be a uuid",
    );
    bad("meals.household.remove", json!({}), "memberId is required");
    // The host's own id field is dropped before the checks.
    assert!(f.tool("meals.kitchen.get", json!({"actorUserId":B}))["data"]["error"].is_null());
    assert_eq!(f.rows(KITCHENS).len(), 0, "a refused call stores nothing");
}

#[test]
fn an_unknown_member_is_reported_and_nothing_is_changed() {
    let f = Fake::new();
    let missing = "11111111-1111-4111-8111-111111111111";
    assert_eq!(
        f.refused(
            "meals.household.save",
            json!({"memberId":missing,"name":"X"})
        ),
        (
            "member_not_found".into(),
            "memberId names no household member".into()
        )
    );
}

#[test]
fn one_person_cannot_read_change_or_remove_another_persons_household() {
    let f = Fake::new();
    let ana = f.ok("meals.household.save", json!({"name":"Ana"}));
    let id = ana["memberId"].as_str().unwrap().to_owned();
    f.as_actor(B);
    let theirs = f.ok("meals.kitchen.get", json!({}));
    assert_eq!(
        theirs["members"].as_array().unwrap().len(),
        1,
        "only their own default self"
    );
    assert_ne!(theirs["kitchenId"], uuid_of(&format!("meals.kitchen:{A}")));
    assert_eq!(
        f.refused(
            "meals.household.save",
            json!({"memberId":id,"name":"Mine now"})
        )
        .0,
        "member_not_found"
    );
    assert_eq!(
        f.ok("meals.household.remove", json!({"memberId":id})),
        json!({"removed":false})
    );
    f.as_actor(A);
    assert_eq!(
        f.ok("meals.kitchen.get", json!({}))["members"][1]["name"],
        "Ana"
    );
}

#[test]
fn favourites_appear_on_the_member_they_belong_to() {
    let f = Fake::new();
    f.ok("meals.kitchen.save", json!({}));
    let me = uuid_of(&format!("meals.self:{A}"));
    f.seed(
        "app.meals_favourites",
        A,
        json!({"member_id":me,"recipe_id":"22222222-2222-4222-8222-222222222222"}),
    );
    let kitchen = f.ok("meals.kitchen.get", json!({}));
    assert_eq!(
        kitchen["members"][0]["favouriteRecipeIds"],
        json!(["22222222-2222-4222-8222-222222222222"])
    );
}

#[test]
fn the_route_hands_every_tool_to_the_host_for_approval() {
    let f = Fake::new();
    let (status, body) = f.route(
        "POST",
        "/meals/tools/run",
        json!({"tool":"meals.kitchen.get","parameters":{}}),
    );
    assert_eq!(
        (status, body["data"]["ran"].clone()),
        (200, json!("meals.kitchen.get"))
    );
    assert!(f.rows(KITCHENS).is_empty(), "the route itself never writes");
    f.tools_refuse.set(true);
    let (status, body) = f.route(
        "POST",
        "/meals/tools/run",
        json!({"tool":"meals.household.remove","parameters":{"memberId":A}}),
    );
    assert_eq!(status, 403, "{body}");
    assert_eq!(
        f.route(
            "POST",
            "/meals/tools/run",
            json!({"tool":"meals.not.a.tool","parameters":{}})
        )
        .0,
        400
    );
    assert_eq!(
        f.route(
            "POST",
            "/meals/tools/run",
            json!({"tool":"meals.kitchen.get","parameters":[]})
        )
        .0,
        400
    );
    assert_eq!(
        f.route(
            "POST",
            "/meals/tools/run",
            json!({"tool":"meals.kitchen.get","parameters":{},"approved":true})
        )
        .0,
        400
    );
    assert_eq!(f.route("GET", "/meals", json!(null)).0, 404);
}

#[test]
fn the_screen_route_runs_tools_without_chat_approval_and_gates_destructive_ones() {
    let f = Fake::new();
    f.tools_refuse.set(true);
    let (status, body) = f.route(
        "POST",
        "/meals/screen/tool",
        json!({"tool":"meals.kitchen.get","parameters":{}}),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["unitsSystem"], "us");
    let (status, _) = f.route(
        "POST",
        "/meals/screen/tool",
        json!({"tool":"meals.kitchen.save","parameters":{"unitsSystem":"metric"}}),
    );
    assert_eq!(status, 200);
    assert_eq!(f.rows(KITCHENS).len(), 1, "a screen write lands without chat approval");
    let remove = json!({"tool":"meals.household.remove","parameters":{"memberId":B}});
    assert_eq!(f.route("POST", "/meals/screen/tool", remove).0, 409);
    let confirmed = json!({"tool":"meals.household.remove","parameters":{"memberId":B},"confirmed":true});
    assert_eq!(f.route("POST", "/meals/screen/tool", confirmed).0, 200);
    for bad in [
        json!({"tool":"meals.not.a.tool","parameters":{}}),
        json!({"tool":"meals.kitchen.get","parameters":[]}),
    ] {
        assert_eq!(f.route("POST", "/meals/screen/tool", bad).0, 400);
    }
}
