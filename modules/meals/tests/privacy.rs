mod common;
use common::Fake;
use serde_json::json;

const MARK: &str = "PLANTED-MARKER-7d2e41";

#[test]
fn private_text_reaches_no_host_call_beyond_the_kitchen_tables() {
    let f = Fake::new();
    let ana = f.ok(
        "meals.household.save",
        json!({"name":MARK,"restrictions":[MARK],"preferences":[MARK],"linkedAccountEmail":format!("{MARK}@example.com")}),
    );
    f.ok(
        "meals.household.save",
        json!({"memberId":ana["memberId"],"name":format!("{MARK} two")}),
    );
    f.ok(
        "meals.kitchen.save",
        json!({"slotRules":[{"slotName":MARK,"soloWeekdays":[1]}]}),
    );
    f.ok(
        "meals.household.remove",
        json!({"memberId":ana["memberId"]}),
    );
    // Every host call is a database query on the four kitchen tables, a clock read or an id.
    // There are no job, log, model, network or file calls in this package at all.
    for (port, _, resource, _) in f.calls.borrow().iter() {
        assert!(port == "db" || port == "context", "unexpected port {port}");
        if port == "db" {
            assert!(
                [
                    "app.meals_kitchens",
                    "app.meals_household_members",
                    "app.meals_meal_slot_rules",
                    "app.meals_favourites"
                ]
                .contains(&resource.as_str()),
                "{resource}"
            );
        }
    }
    // A refused input and a host failure must not echo the marker back.
    let (_, message) = f.refused(
        "meals.household.save",
        json!({"name":MARK,"linkedAccountEmail":MARK}),
    );
    assert!(!message.contains(MARK), "{message}");
    *f.db_failure.borrow_mut() = Some(format!("failed on {MARK}"));
    let (status, body) = f.route(
        "POST",
        "/meals/tools/run",
        json!({"tool":"meals.kitchen.get","parameters":{}}),
    );
    assert_eq!(status, 200, "the route only asks the host");
    assert!(!body.to_string().contains(MARK));
    let payload = json!({"tool":"meals.kitchen.get","parameters":{}}).to_string();
    let failed = moss_meals_module::handle(&f, "tool", &payload).unwrap_err();
    assert!(!failed.to_string().contains(MARK), "{failed}");
}
