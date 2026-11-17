//! Writes one recipe that passes every rule: the cook-time cap, the brand rule, no repeats, the
//! Pantry rule and the safety check for each eater. The day job and the swap job both use it,
//! so a swap choice passes exactly what a planned meal passes.
use crate::pantry::{off_pantry, Input as PantryInput, Stock};
use crate::recipe::{
    build_recipe_prompt, build_safety_prompt, json_object, parse_recipe, parse_safety, Draft,
    Eater, Pantry, Request,
};
use crate::rules::title_key;
use crate::safety::{brand_rule, deterministic_safety, merge, Line, Verdict};
use std::collections::HashSet;

/// The first attempt plus two regenerations.
pub const MAX_ATTEMPTS: usize = 3;

/// Why a draft failed. These are the old module's wording for the stored failure reason.
pub type Reason = &'static str;

pub struct Person {
    pub restrictions: Vec<String>,
    pub preferences: Vec<String>,
    pub share_kcal: Option<i64>,
}

pub struct Ask<'a> {
    pub slot_name: &'a str,
    pub date: &'a str,
    /// One entry per eater, in eater order. None for a member who has been removed.
    pub people: &'a [Option<Person>],
    pub cook_time_limit: Option<i64>,
    pub request_text: Option<&'a str>,
    pub avoid_titles: &'a [String],
    pub recent_keys: &'a HashSet<String>,
    /// Title keys this meal must not use, such as one-star recipes for the people eating it.
    pub vetoed_keys: &'a HashSet<String>,
    pub allow_repeats: bool,
    pub metric: bool,
    /// None when the plan ignores the Pantry.
    pub pantry: Option<&'a PantryInput>,
}

pub enum Outcome {
    Ready {
        draft: Draft,
        key: String,
        verdicts: Vec<Verdict>,
        attempts: usize,
    },
    Failed {
        reason: Reason,
        attempts: usize,
        /// The last safety verdicts, when the final attempt failed the check.
        verdicts: Option<Vec<Verdict>>,
    },
}

/// Asks the model one question and returns its text, or the failure reason.
pub trait Model {
    fn ask(&mut self, prompt: &str) -> Result<String, Reason>;
}

impl<F: FnMut(&str) -> Result<String, Reason>> Model for F {
    fn ask(&mut self, prompt: &str) -> Result<String, Reason> {
        self(prompt)
    }
}

fn pantry_text(s: &Stock) -> String {
    match s.quantity {
        None => s.name.clone(),
        Some(q) => match &s.unit {
            Some(u) if !u.is_empty() => format!("{} ({} {u})", s.name, crate::util::number(q)),
            _ => format!("{} ({})", s.name, crate::util::number(q)),
        },
    }
}

/// The rule check first. A rule failure skips the model. Otherwise the model judges, and a
/// model pass can never clear a rule failure. Err carries the failure reason.
pub fn check_safety(
    model: &mut dyn Model,
    draft: &Draft,
    restrictions: &[Vec<String>],
) -> Result<Vec<Verdict>, Reason> {
    let lines: Vec<Line> = draft
        .ingredients
        .iter()
        .map(|i| Line {
            name: &i.name,
            original_text: &i.original_text,
        })
        .collect();
    let rule: Vec<Verdict> = restrictions
        .iter()
        .map(|r| deterministic_safety(&lines, r))
        .collect();
    if rule.iter().any(|v| matches!(v, Verdict::Fail(_))) {
        return Ok(rule);
    }
    let answer = model.ask(&build_safety_prompt(draft, restrictions))?;
    let judged = json_object(&answer)
        .and_then(|v| parse_safety(&v, restrictions.len()))
        .ok_or("validation_failed")?;
    Ok(rule
        .into_iter()
        .enumerate()
        .map(|(i, v)| merge(v, judged.get(i)))
        .collect())
}

pub fn draft_safe_recipe(model: &mut dyn Model, ask: &Ask) -> Outcome {
    let restrictions: Vec<Vec<String>> = ask
        .people
        .iter()
        .map(|p| {
            p.as_ref()
                .map(|p| p.restrictions.clone())
                .unwrap_or_default()
        })
        .collect();
    let eaters: Vec<Eater> = ask
        .people
        .iter()
        .map(|p| match p {
            Some(p) => Eater {
                share_kcal: p.share_kcal,
                restrictions: p.restrictions.clone(),
                preferences: p.preferences.clone(),
            },
            None => Eater {
                share_kcal: None,
                restrictions: vec![],
                preferences: vec![],
            },
        })
        .collect();
    let pantry = ask.pantry.map(|p| Pantry {
        only: p.only,
        items: p.stock.iter().map(pantry_text).collect(),
        staples: p.staples.clone(),
    });

    let mut attempts = 0;
    let mut last_verdicts: Option<Vec<Verdict>> = None;
    let mut last_rejection = "safety";
    let mut rejected: Vec<String> = vec![];
    let failed = |reason, attempts, verdicts: &Option<Vec<Verdict>>| Outcome::Failed {
        reason,
        attempts,
        verdicts: verdicts.clone(),
    };

    while attempts < MAX_ATTEMPTS {
        attempts += 1;
        let prompt = build_recipe_prompt(&Request {
            slot_name: ask.slot_name,
            date: ask.date,
            eaters: &eaters,
            cook_time_limit: ask.cook_time_limit,
            request_text: ask.request_text,
            avoid_titles: ask.avoid_titles,
            metric: ask.metric,
            pantry: pantry.as_ref(),
            rejected: &rejected,
        });
        let answer = match model.ask(&prompt) {
            Ok(a) => a,
            Err(reason) => return failed(reason, attempts, &last_verdicts),
        };
        let Some(mut draft) =
            json_object(&answer).and_then(|v| parse_recipe(&v, ask.cook_time_limit))
        else {
            return failed("validation_failed", attempts, &last_verdicts);
        };
        for line in &mut draft.ingredients {
            line.check_label = line.check_label || brand_rule(&line.original_text);
        }
        let key = title_key(&draft.title);
        if !ask.allow_repeats && ask.recent_keys.contains(&key) {
            last_rejection = "repeat";
            continue;
        }
        if ask.vetoed_keys.contains(&key) {
            last_rejection = "veto";
            continue;
        }
        if let Some(p) = ask.pantry.filter(|p| p.only) {
            if !off_pantry(draft.ingredients.iter().map(|i| i.name.as_str()), p).is_empty() {
                last_rejection = "pantry";
                continue;
            }
        }
        let verdicts = match check_safety(model, &draft, &restrictions) {
            Ok(v) => v,
            Err(reason) => return failed(reason, attempts, &last_verdicts),
        };
        if verdicts.iter().any(|v| matches!(v, Verdict::Fail(_))) {
            for v in &verdicts {
                if let Verdict::Fail(reason) = v {
                    if !rejected.contains(reason) {
                        rejected.push(reason.clone());
                    }
                }
            }
            last_verdicts = Some(verdicts);
            last_rejection = "safety";
            continue;
        }
        return Outcome::Ready {
            draft,
            key,
            verdicts,
            attempts,
        };
    }
    // Running out of tries on the Pantry or a one-star rule is not a safety problem.
    failed(
        if last_rejection == "safety" {
            "safety_cap"
        } else {
            "validation_failed"
        },
        attempts,
        &last_verdicts,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn recipe(title: &str, ingredient: &str) -> String {
        json!({"title":title,"cookMinutes":30,"baseServings":2,"steps":["Cook"],
          "ingredients":[{"originalText":ingredient,"name":ingredient,"quantity":1,"unit":null,"section":"pantry","checkLabel":false}]}).to_string()
    }
    fn pass(n: usize) -> String {
        let e: Vec<Value> = (1..=n)
            .map(|i| json!({"eater":i,"verdict":"pass","reason":null}))
            .collect();
        json!({"eaters":e}).to_string()
    }
    fn vegan() -> Vec<Option<Person>> {
        vec![Some(Person {
            restrictions: vec!["vegan".into()],
            preferences: vec![],
            share_kcal: None,
        })]
    }
    fn ask<'a>(
        people: &'a [Option<Person>],
        none: &'a HashSet<String>,
        titles: &'a [String],
    ) -> Ask<'a> {
        Ask {
            slot_name: "dinner",
            date: "2026-11-16",
            people,
            cook_time_limit: None,
            request_text: None,
            avoid_titles: titles,
            recent_keys: none,
            vetoed_keys: none,
            allow_repeats: false,
            metric: false,
            pantry: None,
        }
    }
    fn scripted(
        answers: Vec<Result<String, Reason>>,
    ) -> (
        impl FnMut(&str) -> Result<String, Reason>,
        std::rc::Rc<std::cell::RefCell<Vec<String>>>,
    ) {
        let prompts = std::rc::Rc::new(std::cell::RefCell::new(vec![]));
        let seen = prompts.clone();
        let mut it = answers.into_iter();
        (
            move |p: &str| {
                seen.borrow_mut().push(p.to_owned());
                it.next().expect("unexpected extra model call")
            },
            prompts,
        )
    }

    #[test]
    fn a_passing_recipe_is_served_after_one_recipe_call_and_one_check() {
        let (mut m, prompts) = scripted(vec![Ok(recipe("Lentil soup", "lentils")), Ok(pass(1))]);
        let none = HashSet::new();
        let people = vegan();
        let Outcome::Ready {
            draft, attempts, ..
        } = draft_safe_recipe(&mut m, &ask(&people, &none, &[]))
        else {
            panic!("not ready")
        };
        assert_eq!(
            (draft.title.as_str(), attempts, prompts.borrow().len()),
            ("Lentil soup", 1, 2)
        );
    }

    #[test]
    fn a_rule_failure_skips_the_model_check_and_feeds_the_next_try() {
        let (mut m, prompts) = scripted(vec![
            Ok(recipe("Chicken pot", "chicken")),
            Ok(recipe("Lentil soup", "lentils")),
            Ok(pass(1)),
        ]);
        let none = HashSet::new();
        let people = vegan();
        let Outcome::Ready {
            draft, attempts, ..
        } = draft_safe_recipe(&mut m, &ask(&people, &none, &[]))
        else {
            panic!()
        };
        assert_eq!((draft.title.as_str(), attempts), ("Lentil soup", 2));
        // Calls: recipe, recipe, check. The failed first try never reached the model check.
        assert_eq!(prompts.borrow().len(), 3);
        assert!(prompts.borrow()[1].contains("chicken conflicts with"));
    }

    #[test]
    fn a_model_pass_never_clears_a_rule_failure_and_a_model_fail_blocks() {
        let (mut m, _) = scripted(vec![
            Ok(recipe("Rice", "rice")),
            Ok(
                json!({"eaters":[{"eater":1,"verdict":"fail","reason":"Might contain shrimp"}]})
                    .to_string(),
            ),
            Ok(recipe("Rice again", "rice")),
            Ok(
                json!({"eaters":[{"eater":1,"verdict":"fail","reason":"Might contain shrimp"}]})
                    .to_string(),
            ),
            Ok(recipe("Rice thrice", "rice")),
            Ok(
                json!({"eaters":[{"eater":1,"verdict":"fail","reason":"Might contain shrimp"}]})
                    .to_string(),
            ),
        ]);
        let none = HashSet::new();
        let people = vegan();
        let Outcome::Failed {
            reason,
            attempts,
            verdicts,
        } = draft_safe_recipe(&mut m, &ask(&people, &none, &[]))
        else {
            panic!("a failed recipe must not be served")
        };
        assert_eq!((reason, attempts), ("safety_cap", 3));
        assert!(matches!(verdicts.unwrap()[0], Verdict::Fail(_)));
    }

    #[test]
    fn a_missing_eater_verdict_fails_the_recipe() {
        let people = vec![
            Some(Person {
                restrictions: vec![],
                preferences: vec![],
                share_kcal: None,
            }),
            Some(Person {
                restrictions: vec![],
                preferences: vec![],
                share_kcal: None,
            }),
        ];
        let only_first = json!({"eaters":[{"eater":1,"verdict":"pass","reason":null}]}).to_string();
        let answers: Vec<_> = (0..3)
            .flat_map(|i| {
                [
                    Ok(recipe(&format!("Dish {i}"), "rice")),
                    Ok(only_first.clone()),
                ]
            })
            .collect();
        let (mut m, _) = scripted(answers);
        let none = HashSet::new();
        assert!(matches!(
            draft_safe_recipe(&mut m, &ask(&people, &none, &[])),
            Outcome::Failed {
                reason: "safety_cap",
                ..
            }
        ));
    }

    #[test]
    fn repeats_and_vetoes_are_retried_and_a_model_error_stops_at_once() {
        let recent: HashSet<String> = [title_key("Lentil soup")].into();
        let (mut m, _) = scripted(vec![
            Ok(recipe("lentil SOUP!", "lentils")),
            Ok(recipe("Pea soup", "peas")),
            Ok(pass(1)),
        ]);
        let people = vegan();
        let Outcome::Ready { draft, .. } = draft_safe_recipe(&mut m, &ask(&people, &recent, &[]))
        else {
            panic!()
        };
        assert_eq!(draft.title, "Pea soup");

        let (mut bad, _) = scripted(vec![Ok("not json".into())]);
        assert!(matches!(
            draft_safe_recipe(&mut bad, &ask(&people, &HashSet::new(), &[])),
            Outcome::Failed {
                reason: "validation_failed",
                attempts: 1,
                ..
            }
        ));
        let (mut down, _) = scripted(vec![Err("provider_error")]);
        assert!(matches!(
            draft_safe_recipe(&mut down, &ask(&people, &HashSet::new(), &[])),
            Outcome::Failed {
                reason: "provider_error",
                ..
            }
        ));
    }

    #[test]
    fn pantry_only_rejects_off_pantry_recipes() {
        let pantry = PantryInput {
            only: true,
            stock: vec![Stock {
                name: "rice".into(),
                quantity: Some(500.0),
                unit: Some("g".into()),
            }],
            staples: vec![],
        };
        let (mut m, prompts) = scripted(vec![
            Ok(recipe("Saffron rice", "saffron")),
            Ok(recipe("Plain rice", "rice")),
            Ok(pass(1)),
        ]);
        let none = HashSet::new();
        let people = vegan();
        let mut a = ask(&people, &none, &[]);
        a.pantry = Some(&pantry);
        assert!(matches!(
            draft_safe_recipe(&mut m, &a),
            Outcome::Ready { attempts: 2, .. }
        ));
        assert!(prompts.borrow()[0].contains("rice (500 g)"));
    }
}
