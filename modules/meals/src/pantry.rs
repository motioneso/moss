//! Pantry name matching for the plan: whether a Pantry item or Staple covers an ingredient.
//! Coverage of a shopping need by the Pantry stock.
use crate::rules::title_key;
use crate::units::{convert, normalise_unit};

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

/// How the Pantry stock covers a need.
#[derive(Debug, PartialEq)]
pub enum Coverage {
    /// All of it, or some with no amount recorded.
    Covered,
    /// Part of it. The value is what is still missing, in the line's unit.
    Partial(f64),
    None,
}

pub fn coverage(name: &str, quantity: Option<f64>, unit: Option<&str>, stock: &[Stock]) -> Coverage {
    let matches: Vec<&Stock> = stock.iter().filter(|s| names_match(&s.name, name)).collect();
    if matches.is_empty() {
        return Coverage::None;
    }
    let Some(need) = quantity else { return Coverage::Covered };
    if matches.iter().any(|s| s.quantity.is_none()) {
        return Coverage::Covered;
    }
    let target = normalise_unit(unit);
    let mut have = 0.0;
    for row in matches {
        let from = normalise_unit(row.unit.as_deref());
        let q = row.quantity.unwrap_or(0.0);
        if from == target {
            have += q;
        } else if let (Some(f), Some(t)) = (&from, &target) {
            have += convert(q, f, t).unwrap_or(0.0);
        }
    }
    if have <= 0.0 {
        Coverage::None
    } else if have >= need - 1e-9 {
        Coverage::Covered
    } else {
        Coverage::Partial(((need - have) * 1000.0).round() / 1000.0)
    }
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

    #[test]
    fn coverage_converts_and_reports_the_gap() {
        let stock = |q: Option<f64>, u: &str| vec![Stock { name: "flour".into(), quantity: q, unit: Some(u.into()) }];
        assert_eq!(coverage("Flour", Some(500.0), Some("g"), &stock(Some(1.0), "kg")), Coverage::Covered);
        assert_eq!(coverage("flour", Some(500.0), Some("g"), &stock(Some(200.0), "g")), Coverage::Partial(300.0));
        assert_eq!(coverage("flour", Some(500.0), Some("g"), &stock(Some(2.0), "cup")), Coverage::None);
        assert_eq!(coverage("flour", Some(5.0), None, &stock(None, "g")), Coverage::Covered);
        assert_eq!(coverage("salt", Some(1.0), None, &stock(None, "g")), Coverage::None);
    }
}
