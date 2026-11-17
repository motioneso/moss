//! Model job 1, write one recipe, and job 2, judge each eater's restrictions. This file holds the
//! prompts and the strict readers of the model's answers. Eaters are numbered, never named,
//! so no household name reaches a prompt.
use crate::safety::Verdict;
use serde_json::{json, Value};

pub const STORE_SECTIONS: &[&str] = &[
    "produce",
    "meat_fish",
    "dairy_eggs",
    "bakery",
    "frozen",
    "pantry",
    "spices",
    "drinks",
    "household",
    "other",
];

const MAX_AVOID_TITLES: usize = 60;
const MAX_PANTRY_LINES: usize = 80;
const MAX_REJECTED: usize = 12;
const MAX_INGREDIENTS: usize = 40;
const MAX_STEPS: usize = 30;
const MAX_STEP_LENGTH: usize = 600;
const FALLBACK_REASON: &str = "Flagged by the safety check";
pub const MISSING_REASON: &str = "The safety check gave no answer for this eater";

pub struct Eater {
    pub share_kcal: Option<i64>,
    pub restrictions: Vec<String>,
    pub preferences: Vec<String>,
}

pub struct Pantry {
    pub only: bool,
    pub items: Vec<String>,
    pub staples: Vec<String>,
}

pub struct Request<'a> {
    pub slot_name: &'a str,
    pub date: &'a str,
    pub eaters: &'a [Eater],
    pub cook_time_limit: Option<i64>,
    pub request_text: Option<&'a str>,
    pub avoid_titles: &'a [String],
    pub metric: bool,
    pub pantry: Option<&'a Pantry>,
    pub rejected: &'a [String],
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ingredient {
    pub original_text: String,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub section: String,
    pub check_label: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub title: String,
    pub steps: Vec<String>,
    pub cook_minutes: i64,
    pub base_servings: f64,
    pub ingredients: Vec<Ingredient>,
}

/// The shape the model must answer with. The prompt carries it, and the reader enforces it.
pub fn recipe_schema() -> Value {
    json!({
        "type": "object", "additionalProperties": false,
        "required": ["title", "cookMinutes", "baseServings", "steps", "ingredients"],
        "properties": {
            "title": {"type": "string", "description": "Short dish name, at most 120 characters."},
            "cookMinutes": {"type": "integer", "description": "Total time from start to plate, in minutes."},
            "baseServings": {"type": "number", "description": "How many standard servings the amounts make."},
            "steps": {"type": "array", "items": {"type": "string"}, "description": "Method, 1 to 30 entries."},
            "ingredients": {"type": "array", "description": "Every ingredient, 1 to 40 entries.", "items": {
                "type": "object", "additionalProperties": false,
                "required": ["originalText", "name", "quantity", "unit", "section", "checkLabel"],
                "properties": {
                    "originalText": {"type": "string", "description": "The full line, for example \"2 tbsp olive oil\"."},
                    "name": {"type": "string", "description": "The food alone."},
                    "quantity": {"type": ["number", "null"]},
                    "unit": {"type": ["string", "null"]},
                    "section": {"type": "string", "enum": STORE_SECTIONS},
                    "checkLabel": {"type": "boolean", "description": "True for a packaged or branded product."}
                }
            }}
        }
    })
}

pub fn safety_schema() -> Value {
    json!({
        "type": "object", "additionalProperties": false, "required": ["eaters"],
        "properties": {"eaters": {"type": "array", "items": {
            "type": "object", "additionalProperties": false,
            "required": ["eater", "verdict", "reason"],
            "properties": {
                "eater": {"type": "integer", "description": "The eater's number from the prompt."},
                "verdict": {"type": "string", "enum": ["pass", "fail"]},
                "reason": {"type": ["string", "null"]}
            }
        }}}
    })
}

/// Rules are quoted so a diet word reads as a diet to follow, not as a food to leave out.
pub fn quoted_rules(rules: &[String]) -> String {
    rules
        .iter()
        .map(|r| Value::String(r.clone()).to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn eater_line(eater: &Eater, index: usize) -> String {
    let mut parts = vec![format!("Eater {}:", index + 1)];
    parts.push(if eater.restrictions.is_empty() {
        "no restrictions".into()
    } else {
        format!("must follow {}", quoted_rules(&eater.restrictions))
    });
    if !eater.preferences.is_empty() {
        parts.push(format!("prefers {}", eater.preferences.join(", ")));
    }
    if let Some(kcal) = eater.share_kcal {
        parts.push(format!("about {kcal} kcal for this meal"));
    }
    parts.join("; ")
}

fn quote(list: &[String]) -> String {
    quoted_rules(&list[..list.len().min(MAX_PANTRY_LINES)])
}

fn tail<T>(list: &[T], n: usize) -> &[T] {
    &list[list.len().saturating_sub(n)..]
}

pub fn build_recipe_prompt(r: &Request) -> String {
    let mut lines: Vec<String> = vec![
        "Write one home-cooked recipe for the meal below, for every eater listed.".into(),
        "Each eater's rules name foods they cannot eat, or a diet such as \"vegetarian\" whose excluded foods they cannot eat.".into(),
        "Never use an ingredient any eater's rules exclude, including in sauces, stocks and garnishes.".into(),
        "Set checkLabel on any packaged or branded product.".into(),
        format!("Use {} units.", if r.metric { "metric" } else { "US" }),
        "Answer with one JSON object only, matching this schema:".into(),
        recipe_schema().to_string(),
        String::new(),
        "Example: dinner for one eater who never eats peanuts -> title \"Chicken and broccoli stir-fry\", cookMinutes 25, baseServings 2, ingredients include {originalText \"2 tbsp soy sauce\", name \"soy sauce\", quantity 2, unit \"tbsp\", section \"pantry\", checkLabel true}.".into(),
        String::new(),
        format!("Meal: {} on {}", r.slot_name, r.date),
    ];
    lines.extend(r.eaters.iter().enumerate().map(|(i, e)| eater_line(e, i)));
    if let Some(limit) = r.cook_time_limit {
        lines.push(format!("Must be ready in {limit} minutes or less."));
    }
    let avoid = tail(r.avoid_titles, MAX_AVOID_TITLES);
    if !avoid.is_empty() {
        lines.push(format!(
            "Do not repeat any of these dishes: {}",
            avoid.join("; ")
        ));
    }
    if let Some(p) = r.pantry {
        lines.push(if p.only {
            "Cook only from the ingredients on hand and the Staples listed here. Use no other ingredient.".into()
        } else {
            "Prefer ingredients the household already has on hand where they suit the meal, and add others only as needed.".into()
        });
        lines.push(if p.items.is_empty() {
            "Nothing is on hand.".into()
        } else {
            format!("On hand: {}", quote(&p.items))
        });
        if !p.staples.is_empty() {
            lines.push(format!("Staples, always available: {}", quote(&p.staples)));
        }
    }
    if !r.rejected.is_empty() {
        lines.push(format!(
            "Earlier tries were turned down. Leave out these ingredients and anything made with them: {}",
            tail(r.rejected, MAX_REJECTED).join("; ")
        ));
    }
    if let Some(text) = r.request_text.filter(|t| !t.is_empty()) {
        lines.push(format!("The household asked: {text}"));
    }
    lines.join("\n")
}

pub fn build_safety_prompt(recipe: &Draft, eaters: &[Vec<String>]) -> String {
    let mut lines: Vec<String> = vec![
        "Check one recipe against each eater's food rules. A rule names a food, or a diet such as \"vegetarian\" that excludes foods.".into(),
        "When unsure, fail. A \"might contain\" or cross-contact risk counts as unsure. Name the specific ingredient and the rule it breaks in the reason.".into(),
        "A line explicitly marked free of the excluded food (gluten-free bread for a gluten rule) passes that rule only, never a different one.".into(),
        "Answer with one JSON object only, matching this schema:".into(),
        safety_schema().to_string(),
        String::new(),
        "Example: eater 1 never eats fish; ingredient \"1 tbsp Thai red curry paste\" -> {eater 1, verdict \"fail\", reason \"Red curry paste often contains shrimp paste\"}.".into(),
        String::new(),
        format!("Recipe: {}", recipe.title),
    ];
    lines.extend(
        recipe
            .ingredients
            .iter()
            .map(|l| format!("- {}", l.original_text)),
    );
    lines.extend(eaters.iter().enumerate().map(|(i, rules)| {
        if rules.is_empty() {
            format!("Eater {} has no rules", i + 1)
        } else {
            format!("Eater {} must follow {}", i + 1, quoted_rules(rules))
        }
    }));
    lines.join("\n")
}

/// The first JSON object in a model answer, which may arrive inside a code fence.
pub fn json_object(answer: &str) -> Option<Value> {
    let (start, end) = (answer.find('{')?, answer.rfind('}')?);
    serde_json::from_str(answer.get(start..=end)?).ok()
}

fn bounded(value: &Value, max: usize) -> Option<String> {
    let text = value.as_str()?.trim();
    let n = text.chars().count();
    (1..=max).contains(&n).then(|| text.to_owned())
}

fn only_keys(map: &serde_json::Map<String, Value>, known: &[&str]) -> Option<()> {
    map.keys()
        .all(|k| known.contains(&k.as_str()))
        .then_some(())
}

fn parse_ingredient(raw: &Value) -> Option<Ingredient> {
    let m = raw.as_object()?;
    only_keys(
        m,
        &[
            "originalText",
            "name",
            "quantity",
            "unit",
            "section",
            "checkLabel",
        ],
    )?;
    let quantity = match m.get("quantity")? {
        Value::Null => None,
        q => {
            let q = q.as_f64()?;
            // The column keeps three decimals, so less than 0.001 would store as 0.
            if !(0.001..=1e6).contains(&q) {
                return None;
            }
            Some(q)
        }
    };
    let unit = match m.get("unit")? {
        Value::Null => None,
        u => Some(bounded(u, 24)?),
    };
    let section = m.get("section")?.as_str()?;
    if !STORE_SECTIONS.contains(&section) {
        return None;
    }
    Some(Ingredient {
        original_text: bounded(m.get("originalText")?, 200)?,
        name: bounded(m.get("name")?, 80)?,
        quantity,
        unit,
        section: section.to_owned(),
        check_label: m.get("checkLabel")?.as_bool()?,
    })
}

/// None for any shape or range the tables would refuse, or a cook time over the limit.
pub fn parse_recipe(raw: &Value, cook_time_limit: Option<i64>) -> Option<Draft> {
    let m = raw.as_object()?;
    only_keys(
        m,
        &[
            "title",
            "cookMinutes",
            "baseServings",
            "steps",
            "ingredients",
        ],
    )?;
    let minutes = m.get("cookMinutes")?;
    let cook_minutes = minutes.as_i64().or_else(|| {
        let f = minutes.as_f64()?;
        (f.fract() == 0.0).then_some(f as i64)
    })?;
    if !(1..=600).contains(&cook_minutes) || cook_time_limit.is_some_and(|l| cook_minutes > l) {
        return None;
    }
    let base_servings = (m.get("baseServings")?.as_f64()? * 2.0).round() / 2.0;
    if !(0.5..=24.0).contains(&base_servings) {
        return None;
    }
    let steps = m.get("steps")?.as_array()?;
    let ingredients = m.get("ingredients")?.as_array()?;
    if !(1..=MAX_STEPS).contains(&steps.len())
        || !(1..=MAX_INGREDIENTS).contains(&ingredients.len())
    {
        return None;
    }
    Some(Draft {
        title: bounded(m.get("title")?, 120)?,
        steps: steps
            .iter()
            .map(|s| bounded(s, MAX_STEP_LENGTH))
            .collect::<Option<_>>()?,
        cook_minutes,
        base_servings,
        ingredients: ingredients
            .iter()
            .map(parse_ingredient)
            .collect::<Option<_>>()?,
    })
}

/// One verdict per eater, in prompt order. An eater the answer leaves out fails, because the
/// check fails closed. None for a malformed answer.
pub fn parse_safety(raw: &Value, eater_count: usize) -> Option<Vec<Verdict>> {
    let m = raw.as_object()?;
    only_keys(m, &["eaters"])?;
    let mut verdicts: Vec<Option<Verdict>> = vec![None; eater_count];
    for entry in m.get("eaters")?.as_array()? {
        let e = entry.as_object()?;
        let verdict = e.get("verdict")?.as_str()?;
        if verdict != "pass" && verdict != "fail" {
            return None;
        }
        let Some(index) = e
            .get("eater")
            .and_then(Value::as_i64)
            .and_then(|n| usize::try_from(n - 1).ok())
            .filter(|i| *i < eater_count)
        else {
            continue;
        };
        if verdict == "pass" {
            if !matches!(verdicts[index], Some(Verdict::Fail(_))) {
                verdicts[index] = Some(Verdict::Pass);
            }
            continue;
        }
        let reason = e
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or(FALLBACK_REASON);
        verdicts[index] = Some(Verdict::Fail(reason.chars().take(200).collect()));
    }
    Some(
        verdicts
            .into_iter()
            .map(|v| v.unwrap_or_else(|| Verdict::Fail(MISSING_REASON.into())))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn good() -> Value {
        json!({"title":"Lentil soup","cookMinutes":40,"baseServings":3.2,"steps":["Chop","Simmer"],
          "ingredients":[{"originalText":"1 cup lentils","name":"lentils","quantity":1,"unit":"cup","section":"pantry","checkLabel":false}]})
    }

    #[test]
    fn a_good_recipe_parses_and_servings_round_to_halves() {
        let d = parse_recipe(&good(), None).unwrap();
        assert_eq!(d.base_servings, 3.0);
        assert_eq!(d.ingredients[0].unit.as_deref(), Some("cup"));
    }

    #[test]
    fn every_schema_break_is_refused() {
        let cases: Vec<(&str, Value)> = vec![
            ("extra key", json!({"x":1})),
            ("minutes", json!({"cookMinutes":0})),
            ("minutes text", json!({"cookMinutes":"40"})),
            ("minutes over", json!({"cookMinutes":601})),
            ("servings", json!({"baseServings":25})),
            ("no steps", json!({"steps":[]})),
            ("blank step", json!({"steps":["  "]})),
            ("title", json!({"title":"x".repeat(121)})),
            ("no ingredients", json!({"ingredients":[]})),
            (
                "tiny quantity",
                json!({"ingredients":[{"originalText":"a","name":"a","quantity":0.0001,"unit":null,"section":"pantry","checkLabel":false}]}),
            ),
            (
                "section",
                json!({"ingredients":[{"originalText":"a","name":"a","quantity":1,"unit":null,"section":"garage","checkLabel":false}]}),
            ),
            (
                "flag",
                json!({"ingredients":[{"originalText":"a","name":"a","quantity":1,"unit":null,"section":"pantry","checkLabel":"no"}]}),
            ),
            (
                "ingredient key",
                json!({"ingredients":[{"originalText":"a","name":"a","quantity":1,"unit":null,"section":"pantry","checkLabel":false,"z":1}]}),
            ),
        ];
        for (label, patch) in cases {
            let mut v = good();
            for (k, x) in patch.as_object().unwrap() {
                v[k] = x.clone();
            }
            assert!(
                parse_recipe(&v, None).is_none(),
                "{label} should be refused"
            );
        }
        assert!(
            parse_recipe(&good(), Some(30)).is_none(),
            "over the cook-time limit"
        );
        assert!(parse_recipe(&json!([1]), None).is_none());
    }

    #[test]
    fn a_missing_verdict_counts_as_a_fail_and_a_fail_is_never_overwritten() {
        let raw = json!({"eaters":[
            {"eater":1,"verdict":"pass","reason":null},
            {"eater":3,"verdict":"fail","reason":"  "},
            {"eater":3,"verdict":"pass","reason":null},
            {"eater":9,"verdict":"pass","reason":null}]});
        let v = parse_safety(&raw, 3).unwrap();
        assert_eq!(v[0], Verdict::Pass);
        assert_eq!(v[1], Verdict::Fail(MISSING_REASON.into()));
        assert_eq!(v[2], Verdict::Fail(FALLBACK_REASON.into()));
        assert!(parse_safety(&json!({"eaters":[{"eater":1,"verdict":"maybe"}]}), 1).is_none());
        assert!(parse_safety(&json!({"eaters":{}}), 1).is_none());
        assert!(parse_safety(&json!({"eaters":[],"x":1}), 1).is_none());
        let empty = parse_safety(&json!({"eaters":[]}), 2).unwrap();
        assert!(empty.iter().all(|v| matches!(v, Verdict::Fail(_))));
    }

    #[test]
    fn prompts_number_eaters_and_never_carry_names() {
        let eaters = [Eater {
            share_kcal: Some(600),
            restrictions: vec!["vegan".into()],
            preferences: vec![],
        }];
        let p = build_recipe_prompt(&Request {
            slot_name: "dinner",
            date: "2026-11-16",
            eaters: &eaters,
            cook_time_limit: Some(30),
            request_text: Some("something warm"),
            avoid_titles: &[],
            metric: true,
            pantry: None,
            rejected: &["honey".into()],
        });
        assert!(p.contains("Eater 1:; must follow \"vegan\"; about 600 kcal for this meal"));
        assert!(p.contains("metric") && p.contains("30 minutes") && p.contains("something warm"));
        assert!(p.contains("honey") && p.len() < 64 * 1024);
        assert_eq!(json_object("```json\n{\"a\":1}\n```"), Some(json!({"a":1})));
    }
}
