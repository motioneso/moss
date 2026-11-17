//! Turns a meal description into an estimate. The schema rides in the prompt, the answer is
//! parsed strictly, and every figure goes through the boundary check. Nothing here fails
//! loudly: any model error or malformed answer becomes a failed estimate, which the person can
//! retry. The entry's figures always equal the sum of its items, never a lump figure the model
//! gave for the whole meal.
use crate::draft::Model;
use crate::nutrients::{self, Figures, KEYS};
use crate::recipe::json_object;
use serde_json::{json, Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub label: String,
    pub portion_note: Option<String>,
    pub figures: Figures,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Estimated {
        items: Vec<Item>,
        totals: Figures,
    },
    NeedsDetails {
        missing: String,
        question: String,
    },
    Failed,
}

fn nutrient_property(what: &str, unit: &str) -> Value {
    json!({
        "type": ["number", "null"],
        "description": format!("{what} for this item only, in {unit}. Null if you cannot estimate it.")
    })
}

pub fn schema() -> Value {
    let mut item_props = Map::new();
    item_props.insert(
        "label".into(),
        json!({"type":"string","description":"The food itself, without the amount, such as \"hot wings\", \"breadsticks\", \"Coke Zero\"."}),
    );
    item_props.insert(
        "portionNote".into(),
        json!({"type":["string","null"],"description":"The amount as described, without the food, such as \"6\", \"32 oz\", \"1 cup cooked\". Null if the description gave no amount for this item."}),
    );
    let units = [
        ("Energy", "kilocalories (kcal)"),
        ("Protein", "grams (g)"),
        ("Total carbohydrates", "grams (g)"),
        ("Total fat", "grams (g)"),
        ("Dietary fiber", "grams (g)"),
        ("Total sugar", "grams (g)"),
        ("Sodium", "milligrams (mg)"),
    ];
    for (key, (what, unit)) in KEYS.iter().zip(units) {
        item_props.insert((*key).to_owned(), nutrient_property(what, unit));
    }
    let mut required = vec!["label".to_owned(), "portionNote".to_owned()];
    required.extend(KEYS.iter().map(|k| (*k).to_owned()));
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["outcome", "items", "missingDetails", "clarificationQuestion"],
        "properties": {
            "outcome": {
                "type": "string",
                "enum": ["estimated", "needs_details"],
                "description": "\"estimated\" if the description names real food with enough sense of amount to guess nutrition; \"needs_details\" if it is too vague to estimate even roughly (no food named, or food named with no sense of portion)."
            },
            "items": {
                "type": "array",
                "description": "One entry per individual food in the meal, in the order described. A meal of one food has one entry. Empty when outcome is needs_details.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": required,
                    "properties": item_props
                }
            },
            "missingDetails": {
                "type": ["string", "null"],
                "description": "When outcome is needs_details, a short phrase naming what is missing, such as \"no portion size\". Null when outcome is estimated."
            },
            "clarificationQuestion": {
                "type": ["string", "null"],
                "description": "When outcome is needs_details, one short question to ask the user that would let you estimate. Null when outcome is estimated."
            }
        }
    })
}

pub fn build_prompt(description: &str, serving_note: Option<&str>) -> String {
    let mut lines = vec![
        "Estimate the nutrition in one meal from its plain-text description.".to_owned(),
        "Break the meal into the individual foods it contains, one item per food, and estimate each item on its own. Never return one lump figure for the whole meal.".into(),
        "If it names real food with a rough sense of amount, return outcome \"estimated\" with your best-guess value for every nutrient field of every item, in the units the schema field descriptions name.".into(),
        "If it is too vague to estimate even roughly, return outcome \"needs_details\", an empty items list, and one short clarifying question.".into(),
        "Answer with one JSON object only, matching this schema:".into(),
        schema().to_string(),
        String::new(),
        "Example: \"a bowl of oatmeal with a banana\" -> outcome \"estimated\", two items: {label \"oatmeal\", portionNote \"1 bowl\", caloriesKcal 310, proteinG 8, carbohydratesG 55, fatG 5, fiberG 8, sugarG 2, sodiumMg 140} and {label \"banana\", portionNote \"1\", caloriesKcal 105, proteinG 1, carbohydratesG 27, fatG 0, fiberG 3, sugarG 14, sodiumMg 1}.".into(),
        String::new(),
        format!("Meal description: {description}"),
    ];
    if let Some(note) = serving_note.filter(|n| !n.is_empty()) {
        lines.push(format!("Serving note: {note}"));
    }
    lines.join("\n")
}

fn nullable_text(value: &Value) -> Option<Option<String>> {
    match value {
        Value::Null => Some(None),
        Value::String(text) => Some(Some(text.clone())),
        _ => None,
    }
}

fn only(map: &Map<String, Value>, known: &[&str]) -> Option<()> {
    map.keys().all(|k| known.contains(&k.as_str())).then_some(())
}

fn parse_item(raw: &Value) -> Option<Item> {
    let map = raw.as_object()?;
    let mut known = vec!["label", "portionNote"];
    known.extend(KEYS);
    only(map, &known)?;
    let label = map.get("label")?.as_str().filter(|l| !l.trim().is_empty())?;
    let portion_note = nullable_text(map.get("portionNote")?)?;
    Some(Item {
        label: label.to_owned(),
        portion_note,
        figures: nutrients::validate(raw),
    })
}

/// A parsed answer. Anything shaped wrong is refused, never coerced and never partly kept.
pub fn parse(raw: &Value) -> Option<Outcome> {
    let map = raw.as_object()?;
    only(map, &["outcome", "items", "missingDetails", "clarificationQuestion"])?;
    let outcome = map.get("outcome")?.as_str()?;
    let missing = nullable_text(map.get("missingDetails")?)?;
    let question = nullable_text(map.get("clarificationQuestion")?)?;
    let items: Option<Vec<Item>> = map.get("items")?.as_array()?.iter().map(parse_item).collect();
    let items = items?;
    match outcome {
        "needs_details" => Some(Outcome::NeedsDetails {
            missing: missing.filter(|m| !m.is_empty())?,
            question: question.filter(|q| !q.is_empty())?,
        }),
        "estimated" if !items.is_empty() => {
            let totals = nutrients::sum(items.iter().map(|i| &i.figures));
            Some(Outcome::Estimated { items, totals })
        }
        _ => None,
    }
}

pub fn estimate(model: &mut dyn Model, description: &str, serving_note: Option<&str>) -> Outcome {
    let Ok(answer) = model.ask(&build_prompt(description, serving_note)) else {
        return Outcome::Failed;
    };
    json_object(&answer)
        .and_then(|raw| parse(&raw))
        .unwrap_or(Outcome::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> Value {
        json!({
            "outcome": "estimated",
            "items": [
                {"label":"oatmeal","portionNote":"1 bowl","caloriesKcal":310,"proteinG":8,
                 "carbohydratesG":55,"fatG":5,"fiberG":8,"sugarG":2,"sodiumMg":140},
                {"label":"banana","portionNote":null,"caloriesKcal":105,"proteinG":1,
                 "carbohydratesG":27,"fatG":0,"fiberG":3,"sugarG":14,"sodiumMg":1}
            ],
            "missingDetails": null,
            "clarificationQuestion": null
        })
    }

    #[test]
    fn a_good_answer_is_an_estimate_summed_from_its_items() {
        let Some(Outcome::Estimated { items, totals }) = parse(&good()) else {
            panic!("expected an estimate");
        };
        assert_eq!(items.len(), 2);
        assert_eq!(totals[0], Some(415.0));
        assert_eq!(totals[6], Some(141.0));
    }

    #[test]
    fn the_prompt_carries_the_schema_and_the_meal() {
        let prompt = build_prompt("two eggs", Some("fried"));
        assert!(prompt.contains("\"additionalProperties\":false"));
        assert!(prompt.contains("Meal description: two eggs"));
        assert!(prompt.ends_with("Serving note: fried"));
        assert!(!build_prompt("two eggs", None).contains("Serving note"));
    }

    #[test]
    fn every_shape_break_is_refused() {
        let mut breaks: Vec<Value> = vec![json!([]), json!({})];
        let mut extra = good();
        extra["notes"] = json!("hi");
        breaks.push(extra);
        let mut extra_item = good();
        extra_item["items"][1]["price"] = json!(3);
        breaks.push(extra_item);
        let mut blank = good();
        blank["items"][0]["label"] = json!("  ");
        breaks.push(blank);
        let mut empty = good();
        empty["items"] = json!([]);
        breaks.push(empty);
        let mut bad_note = good();
        bad_note["items"][0]["portionNote"] = json!(4);
        breaks.push(bad_note);
        let mut bad_outcome = good();
        bad_outcome["outcome"] = json!("measured");
        breaks.push(bad_outcome);
        breaks.push(json!({"outcome":"needs_details","items":[],"missingDetails":"portion",
                           "clarificationQuestion":null}));
        breaks.push(json!({"outcome":"needs_details","items":[],"missingDetails":"",
                           "clarificationQuestion":"How much?"}));
        for raw in breaks {
            assert_eq!(parse(&raw), None, "{raw}");
        }
    }

    #[test]
    fn a_vague_meal_asks_a_question_and_stores_no_figures() {
        let raw = json!({"outcome":"needs_details","items":[],"missingDetails":"no portion",
                         "clarificationQuestion":"How much did you have?"});
        assert_eq!(
            parse(&raw),
            Some(Outcome::NeedsDetails {
                missing: "no portion".into(),
                question: "How much did you have?".into()
            })
        );
    }

    #[test]
    fn a_failing_or_garbled_model_is_a_failed_estimate() {
        let mut broken = |_: &str| -> Result<String, &'static str> { Err("provider_error") };
        assert_eq!(estimate(&mut broken, "toast", None), Outcome::Failed);
        let mut garbled = |_: &str| -> Result<String, &'static str> { Ok("sorry".into()) };
        assert_eq!(estimate(&mut garbled, "toast", None), Outcome::Failed);
        let mut fenced =
            |_: &str| -> Result<String, &'static str> { Ok(format!("```json\n{}\n```", good())) };
        assert!(matches!(estimate(&mut fenced, "x", None), Outcome::Estimated { .. }));
    }

    #[test]
    fn an_implausible_figure_becomes_unknown_but_the_item_stays() {
        let mut raw = good();
        raw["items"][0]["caloriesKcal"] = json!(40000);
        let Some(Outcome::Estimated { items, totals }) = parse(&raw) else {
            panic!("expected an estimate");
        };
        assert_eq!(items[0].figures[0], None);
        assert_eq!(totals[0], Some(105.0));
    }
}
