//! Nutrient figures for a logged meal. Every figure is a number or unknown. Unknown is never
//! zero, so a total with no known figure stays unknown instead of reading as nothing eaten.
use crate::util::jopt;
use serde_json::{json, Value};

/// The seven figures, in the order they are stored and shown.
pub const KEYS: [&str; 7] = [
    "caloriesKcal",
    "proteinG",
    "carbohydratesG",
    "fatG",
    "fiberG",
    "sugarG",
    "sodiumMg",
];

/// The matching stored column names.
pub const COLUMNS: [&str; 7] = [
    "calories_kcal",
    "protein_g",
    "carbohydrates_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "sodium_mg",
];

/// The largest believable figure for one meal. A number above it is treated as unknown.
const CEILINGS: [f64; 7] = [5000.0, 500.0, 1000.0, 500.0, 200.0, 500.0, 20000.0];

pub type Figures = [Option<f64>; 7];

pub const UNKNOWN: Figures = [None; 7];

/// Whatever the model wrote, cleaned. Anything that is not a plausible, finite, non-negative
/// number becomes unknown. A bad figure never discards the good ones beside it.
pub fn validate(raw: &Value) -> Figures {
    let mut out = UNKNOWN;
    for (index, key) in KEYS.iter().enumerate() {
        out[index] = raw[*key]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= CEILINGS[index]);
    }
    out
}

/// The sum of each figure over the items that know it. A figure no item knows stays unknown.
pub fn sum<'a>(parts: impl IntoIterator<Item = &'a Figures>) -> Figures {
    let mut totals = UNKNOWN;
    for part in parts {
        for (total, figure) in totals.iter_mut().zip(part) {
            if let Some(n) = figure {
                *total = Some(total.unwrap_or(0.0) + n);
            }
        }
    }
    totals
}

pub fn view(figures: &Figures) -> Value {
    let mut out = serde_json::Map::new();
    for (key, figure) in KEYS.iter().zip(figures) {
        out.insert((*key).to_owned(), jopt(*figure));
    }
    Value::Object(out)
}

/// A stored numeric column, which the host sends as a number or as text.
pub fn column(row: &Value, name: &str) -> Option<f64> {
    crate::store::num(&row[name]).filter(|n| n.is_finite())
}

pub fn from_row(row: &Value) -> Figures {
    let mut out = UNKNOWN;
    for (slot, name) in out.iter_mut().zip(COLUMNS) {
        *slot = column(row, name);
    }
    out
}

/// The stored column values for a set of figures.
pub fn to_columns(figures: &Figures) -> Vec<(&'static str, Value)> {
    COLUMNS
        .iter()
        .zip(figures)
        .map(|(name, figure)| (*name, figure.map_or(Value::Null, |n| json!(n))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_figures_become_unknown_and_good_ones_stay() {
        let raw = json!({
            "caloriesKcal": 310, "proteinG": -1, "carbohydratesG": 1001, "fatG": "5",
            "fiberG": 0, "sugarG": null, "sodiumMg": 20000
        });
        let got = validate(&raw);
        assert_eq!(got[0], Some(310.0));
        assert_eq!(&got[1..4], &[None, None, None]);
        assert_eq!(got[4], Some(0.0));
        assert_eq!(got[5], None);
        assert_eq!(got[6], Some(20000.0));
    }

    #[test]
    fn a_sum_is_unknown_until_one_item_knows_the_figure() {
        let a: Figures = [Some(100.0), None, None, None, None, None, None];
        let b: Figures = [Some(5.5), Some(2.0), None, None, None, None, None];
        let total = sum([&a, &b]);
        assert_eq!(total[0], Some(105.5));
        assert_eq!(total[1], Some(2.0));
        assert_eq!(total[2], None);
        assert_eq!(sum([&UNKNOWN]), UNKNOWN);
    }
}
