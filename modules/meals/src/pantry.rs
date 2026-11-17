//! Pantry name matching for the plan: whether a Pantry item or Staple covers an ingredient.
//! Shopping-list quantity maths belongs to the shopping part and is not here.
use crate::rules::title_key;

pub struct Stock {
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
}

pub struct Input {
    pub only: bool,
    pub stock: Vec<Stock>,
    pub staples: Vec<String>,
}

/// Words that describe a food's state without making it a different food.
const DESCRIPTORS: &[&str] = &[
    "fresh", "dried", "dry", "ground", "organic", "large", "small", "medium", "raw", "ripe",
    "frozen", "chopped", "sliced", "minced", "plain", "basmati", "jasmine", "long", "grain",
];

fn singular(word: &str) -> String {
    let n = word.chars().count();
    if n > 3 && word.ends_with("ies") {
        return format!("{}y", &word[..word.len() - 3]);
    }
    if n > 3
        && ["ches", "shes", "ses", "xes", "oes"]
            .iter()
            .any(|s| word.ends_with(s))
    {
        return word[..word.len() - 2].to_owned();
    }
    if n > 2 && word.ends_with('s') && !word.ends_with("ss") {
        return word[..word.len() - 1].to_owned();
    }
    word.to_owned()
}

fn words(name: &str) -> Vec<String> {
    title_key(name)
        .split(' ')
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn core(name: &str) -> Vec<String> {
    let all: Vec<String> = words(name).iter().map(|w| singular(w)).collect();
    let kept: Vec<String> = all
        .iter()
        .filter(|w| !DESCRIPTORS.contains(&w.as_str()))
        .cloned()
        .collect();
    if kept.is_empty() {
        all
    } else {
        kept
    }
}

/// True when two names are the same food: "rice" matches "Basmati rice", "milk" does not
/// match "coconut milk".
pub fn names_match(a: &str, b: &str) -> bool {
    let (l, r) = (core(a), core(b));
    !l.is_empty() && l == r
}

pub fn is_staple(name: &str, input: &Input) -> bool {
    matches!(words(name).join(" ").as_str(), "water" | "ice")
        || input.staples.iter().any(|s| names_match(s, name))
}

/// Names of ingredients that neither the Pantry nor the Staples cover.
pub fn off_pantry<'a>(names: impl Iterator<Item = &'a str>, input: &Input) -> Vec<String> {
    names
        .filter(|n| !is_staple(n, input) && !input.stock.iter().any(|s| names_match(&s.name, n)))
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_folds_plurals_and_descriptors_only() {
        assert!(names_match("rice", "Basmati rice"));
        assert!(names_match("tomatoes", "tomato"));
        assert!(names_match("berries", "berry"));
        assert!(!names_match("milk", "coconut milk"));
        assert!(!names_match("pepper", "bell pepper"));
        assert!(!names_match("rice", "rice vinegar"));
        assert!(!names_match("", "rice"));
    }

    #[test]
    fn off_pantry_skips_stock_staples_and_water() {
        let input = Input {
            only: true,
            stock: vec![Stock {
                name: "rice".into(),
                quantity: None,
                unit: None,
            }],
            staples: vec!["olive oil".into()],
        };
        let names = ["Water", "olive oil", "rice", "saffron"];
        assert_eq!(off_pantry(names.into_iter(), &input), vec!["saffron"]);
    }
}
