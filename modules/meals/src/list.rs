//! Builds shopping lines from a plan's meals and reconciles them against the stored list. Pure.
//! A line's identity is its normalised name plus unit family; "other" units also keep their
//! unit, so 2 cloves of garlic and 1 head of garlic stay apart.
use crate::pantry::{coverage, is_staple, Coverage, Input as Pantry};
use crate::rules::title_key;
use crate::units::{convert, format_number, normalise_unit, unit_family, Family};
use std::cmp::Ordering;
use std::collections::HashMap;

pub const SECTION_ORDER: [&str; 10] = [
    "produce", "meat_fish", "dairy_eggs", "bakery", "frozen", "pantry", "spices", "drinks",
    "household", "other",
];

/// Smallest pack first.
const PACK_SIZES: &[(&str, &[(f64, &str)])] = &[
    ("milk", &[(500.0, "ml"), (1000.0, "ml"), (2000.0, "ml")]),
    ("cream", &[(250.0, "ml"), (500.0, "ml")]),
    ("butter", &[(250.0, "g"), (500.0, "g")]),
    ("flour", &[(1000.0, "g"), (2000.0, "g")]),
    ("sugar", &[(1000.0, "g")]),
    ("rice", &[(500.0, "g"), (1000.0, "g")]),
    ("pasta", &[(500.0, "g")]),
    ("oats", &[(500.0, "g")]),
    ("yogurt", &[(170.0, "g"), (500.0, "g")]),
    ("cheese", &[(200.0, "g")]),
    ("olive oil", &[(250.0, "ml"), (500.0, "ml"), (1000.0, "ml")]),
    ("chicken stock", &[(1000.0, "ml")]),
    ("canned tomatoes", &[(400.0, "g")]),
    ("coconut milk", &[(400.0, "ml")]),
];

#[derive(Clone, Debug, PartialEq)]
pub struct Purchase {
    pub quantity: f64,
    pub unit: String,
}

#[derive(Clone, Debug)]
pub struct Ingredient {
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub section: String,
}

pub struct MealInput {
    pub meal_id: String,
    pub servings: f64,
    pub base_servings: f64,
    pub ingredients: Vec<Ingredient>,
}

/// The Pantry as the build reads it. Staple lines are always dropped. Coverage applies only
/// when `cover` is set, which is every pantry mode except ignore.
pub struct BuildPantry<'a> {
    pub cover: bool,
    pub input: &'a Pantry,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Generated {
    pub line_key: String,
    pub name_key: String,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub purchase: Option<Purchase>,
    pub section: String,
    pub covered: bool,
    pub converted_from: Vec<String>,
    pub source_meal_ids: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Stored {
    pub line_id: String,
    pub line_key: Option<String>,
    pub manual: bool,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub purchase: Option<Purchase>,
    pub section: String,
    pub covered: bool,
    pub not_in_plan: bool,
    pub converted_from: Vec<String>,
    pub source_meal_ids: Vec<String>,
    pub checked_at: Option<String>,
    pub bought_at: Option<String>,
    /// The row's last-change stamp, which keys the Pantry rows a purchase adds.
    pub version: String,
}

#[derive(Clone, Debug)]
pub struct Update {
    pub line_id: String,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Option<String>,
    pub purchase: Option<Purchase>,
    pub section: String,
    pub covered: bool,
    pub not_in_plan: bool,
    pub converted_from: Vec<String>,
    pub source_meal_ids: Vec<String>,
}

pub struct Diff {
    pub insert: Vec<Generated>,
    pub update: Vec<Update>,
    pub remove: Vec<String>,
}

pub fn ingredient_key(name: &str) -> String {
    let key: String = title_key(name).chars().take(80).collect();
    let key = key.trim();
    if key.is_empty() { "item".into() } else { key.to_owned() }
}

fn line_key_for(name_key: &str, unit: Option<&str>) -> String {
    match unit_family(unit) {
        Family::Other => format!("{name_key}|other:{}", normalise_unit(unit).unwrap_or_default()),
        Family::Mass => format!("{name_key}|mass"),
        Family::Volume => format!("{name_key}|volume"),
        Family::Count => format!("{name_key}|count"),
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

struct Entry {
    name: String,
    section: String,
    quantity: Option<f64>,
    unit: Option<String>,
    meal_id: String,
}

fn merge_group(line_key: &str, name_key: &str, entries: &[Entry]) -> Generated {
    let first = &entries[0];
    let quantified: Vec<&Entry> = entries.iter().filter(|e| e.quantity.is_some()).collect();
    let mut source_meal_ids: Vec<String> = vec![];
    for e in entries {
        if !source_meal_ids.contains(&e.meal_id) {
            source_meal_ids.push(e.meal_id.clone());
        }
    }
    let section = entries
        .iter()
        .find(|e| e.section != "other")
        .map_or(first.section.clone(), |e| e.section.clone());
    let base = Generated {
        line_key: line_key.to_owned(),
        name_key: name_key.to_owned(),
        name: first.name.clone(),
        quantity: None,
        unit: normalise_unit(first.unit.as_deref()),
        purchase: None,
        section,
        covered: false,
        converted_from: vec![],
        source_meal_ids,
    };
    if quantified.is_empty() {
        return base;
    }
    let target = normalise_unit(quantified[0].unit.as_deref());
    let mut total = 0.0;
    let mut converted_from = vec![];
    for e in quantified {
        let q = e.quantity.unwrap_or(0.0);
        let unit = normalise_unit(e.unit.as_deref());
        if unit == target || target.is_none() || unit.is_none() {
            total += q;
            continue;
        }
        let (u, t) = (unit.unwrap_or_default(), target.clone().unwrap_or_default());
        total += convert(q, &u, &t).unwrap_or(q);
        converted_from.push(format!("{} {u}", format_number(q)));
    }
    let mut line = Generated { quantity: Some(round3(total)), unit: target, converted_from, ..base };
    line.purchase = purchase_amount(&line.name_key, line.quantity, line.unit.as_deref());
    line
}

/// The amount to buy. Packaged names round up to the smallest pack that covers the need, or to
/// whole copies of the largest pack. Anything else buys the raw amount, counts rounded up.
pub fn purchase_amount(name_key: &str, quantity: Option<f64>, unit: Option<&str>) -> Option<Purchase> {
    let quantity = quantity?;
    let unit = normalise_unit(unit);
    if let (Some(packs), Some(u)) = (PACK_SIZES.iter().find(|(k, _)| *k == name_key), &unit) {
        let fits: Vec<(f64, &str, f64)> = packs
            .1
            .iter()
            .filter_map(|(q, pu)| convert(quantity, u, pu).map(|need| (*q, *pu, need)))
            .collect();
        if let Some((q, pu, _)) = fits.iter().find(|(q, _, need)| *q >= need - 1e-9) {
            return Some(Purchase { quantity: *q, unit: (*pu).to_owned() });
        }
        if let Some((q, pu, need)) = fits.last() {
            return Some(Purchase { quantity: ((need / q) - 1e-9).ceil() * q, unit: (*pu).to_owned() });
        }
    }
    match unit {
        None => Some(Purchase { quantity: (quantity - 1e-9).ceil(), unit: String::new() }),
        Some(u) => Some(Purchase { quantity, unit: u }),
    }
}

fn with_pantry(lines: Vec<Generated>, pantry: Option<&BuildPantry>) -> Vec<Generated> {
    let Some(p) = pantry else { return lines };
    let mut kept = vec![];
    for line in lines {
        if is_staple(&line.name, p.input) {
            continue;
        }
        let cover = if p.cover {
            coverage(&line.name, line.quantity, line.unit.as_deref(), &p.input.stock)
        } else {
            Coverage::None
        };
        match cover {
            Coverage::Covered => kept.push(Generated { covered: true, ..line }),
            Coverage::Partial(need) => {
                let mut reduced = Generated { quantity: Some(need), ..line };
                reduced.purchase = purchase_amount(&reduced.name_key, reduced.quantity, reduced.unit.as_deref());
                kept.push(reduced);
            }
            Coverage::None => kept.push(line),
        }
    }
    kept
}

/// Orders names as the old list did: letters without case or accents first, lowercase before
/// uppercase on a tie. The old code used the runtime's locale order, which this approximates.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    let key = |s: &str| -> String {
        s.chars().flat_map(char::to_lowercase).map(|c| crate::rules::fold(c).unwrap_or(c)).collect()
    };
    key(a).cmp(&key(b)).then_with(|| b.cmp(a))
}

fn section_rank(section: &str) -> usize {
    SECTION_ORDER.iter().position(|s| *s == section).unwrap_or(usize::MAX)
}

pub fn sort_key(section_a: &str, name_a: &str, section_b: &str, name_b: &str) -> Ordering {
    section_rank(section_a).cmp(&section_rank(section_b)).then_with(|| locale_cmp(name_a, name_b))
}

/// Merges every meal's ingredients into lines, scaled to the servings and grouped by section.
pub fn build_list(meals: &[MealInput], pantry: Option<&BuildPantry>) -> Vec<Generated> {
    let mut order: Vec<String> = vec![];
    let mut groups: HashMap<String, (String, Vec<Entry>)> = HashMap::new();
    for meal in meals {
        let scale = if meal.base_servings > 0.0 { meal.servings / meal.base_servings } else { 1.0 };
        for i in &meal.ingredients {
            let name_key = ingredient_key(&i.name);
            let line_key = line_key_for(&name_key, i.unit.as_deref());
            if !groups.contains_key(&line_key) {
                order.push(line_key.clone());
            }
            groups.entry(line_key).or_insert_with(|| (name_key, vec![])).1.push(Entry {
                name: i.name.clone(),
                section: i.section.clone(),
                quantity: i.quantity.map(|q| q * scale),
                unit: i.unit.clone(),
                meal_id: meal.meal_id.clone(),
            });
        }
    }
    let lines = order
        .iter()
        .map(|k| {
            let (name_key, entries) = &groups[k];
            merge_group(k, name_key, entries)
        })
        .collect();
    let mut lines = with_pantry(lines, pantry);
    lines.sort_by(|a, b| sort_key(&a.section, &a.name, &b.section, &b.name));
    lines
}

/// Rebuilds the stored list from fresh lines without deleting what a shopper has touched.
/// Matching lines update in place, so ticks carry over. Manual and bought lines are left alone.
/// A ticked line that left the plan stays and is marked not in plan; an unticked one goes.
pub fn reconcile_list(stored: &[Stored], generated: &[Generated]) -> Diff {
    let open: Vec<&Stored> = stored.iter().filter(|l| !l.manual && l.bought_at.is_none()).collect();
    let by_key: HashMap<&str, &Stored> =
        open.iter().filter_map(|l| l.line_key.as_deref().map(|k| (k, *l))).collect();
    let mut seen: Vec<&str> = vec![];
    let (mut insert, mut update, mut remove) = (vec![], vec![], vec![]);
    for line in generated {
        let Some(m) = by_key.get(line.line_key.as_str()) else {
            insert.push(line.clone());
            continue;
        };
        seen.push(&line.line_key);
        // An amount the shopper edited stays until the recipes' need itself changes.
        let need_same = m.quantity == line.quantity && m.unit == line.unit;
        let purchase = if need_same { m.purchase.clone() } else { line.purchase.clone() };
        let unchanged = m.name == line.name
            && need_same
            && m.purchase == purchase
            && m.section == line.section
            && m.covered == line.covered
            && !m.not_in_plan
            && m.converted_from == line.converted_from
            && m.source_meal_ids == line.source_meal_ids;
        if unchanged {
            continue;
        }
        update.push(Update {
            line_id: m.line_id.clone(),
            name: line.name.clone(),
            quantity: line.quantity,
            unit: line.unit.clone(),
            purchase,
            section: line.section.clone(),
            covered: line.covered,
            not_in_plan: false,
            converted_from: line.converted_from.clone(),
            source_meal_ids: line.source_meal_ids.clone(),
        });
    }
    for l in open {
        if l.line_key.as_deref().is_some_and(|k| seen.contains(&k)) {
            continue;
        }
        if l.checked_at.is_none() {
            remove.push(l.line_id.clone());
        } else if !l.not_in_plan {
            update.push(Update {
                line_id: l.line_id.clone(),
                name: l.name.clone(),
                quantity: l.quantity,
                unit: l.unit.clone(),
                purchase: l.purchase.clone(),
                section: l.section.clone(),
                covered: l.covered,
                not_in_plan: true,
                converted_from: l.converted_from.clone(),
                source_meal_ids: vec![],
            });
        }
    }
    Diff { insert, update, remove }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pantry::Stock;

    fn ing(name: &str, q: Option<f64>, unit: Option<&str>, section: &str) -> Ingredient {
        Ingredient { name: name.into(), quantity: q, unit: unit.map(Into::into), section: section.into() }
    }
    fn meal(id: &str, servings: f64, base: f64, ingredients: Vec<Ingredient>) -> MealInput {
        MealInput { meal_id: id.into(), servings, base_servings: base, ingredients }
    }

    #[test]
    fn merges_scales_and_converts_within_a_family() {
        let meals = vec![
            meal("m1", 4.0, 2.0, vec![ing("Flour", Some(250.0), Some("g"), "pantry")]),
            meal("m2", 2.0, 2.0, vec![ing("flour", Some(1.0), Some("kg"), "other"), ing("Garlic", Some(2.0), Some("cloves"), "produce")]),
        ];
        let lines = build_list(&meals, None);
        let flour = lines.iter().find(|l| l.name_key == "flour").unwrap();
        assert_eq!((flour.quantity, flour.unit.as_deref()), (Some(500.0 + 1000.0), Some("g")));
        assert_eq!(flour.converted_from, vec!["1 kg"]);
        assert_eq!(flour.purchase, Some(Purchase { quantity: 2000.0, unit: "g".into() }));
        assert_eq!(flour.source_meal_ids, vec!["m1", "m2"]);
        assert_eq!(flour.section, "pantry");
        assert_eq!(lines[0].name, "Garlic", "produce sorts before pantry");
    }

    #[test]
    fn other_units_stay_apart_and_counts_round_up() {
        let meals = vec![meal("m", 1.0, 1.0, vec![
            ing("garlic", Some(2.0), Some("cloves"), "produce"),
            ing("garlic", Some(1.0), Some("head"), "produce"),
            ing("lemon", Some(1.5), None, "produce"),
        ])];
        let lines = build_list(&meals, None);
        assert_eq!(lines.len(), 3);
        let lemon = lines.iter().find(|l| l.name == "lemon").unwrap();
        assert_eq!(lemon.purchase, Some(Purchase { quantity: 2.0, unit: String::new() }));
    }

    #[test]
    fn pantry_drops_staples_marks_covered_and_shrinks_partial() {
        let input = Pantry {
            only: false,
            stock: vec![
                Stock { name: "rice".into(), quantity: Some(300.0), unit: Some("g".into()) },
                Stock { name: "pasta".into(), quantity: None, unit: None },
            ],
            staples: vec!["olive oil".into()],
        };
        let meals = vec![meal("m", 1.0, 1.0, vec![
            ing("rice", Some(500.0), Some("g"), "pantry"),
            ing("pasta", Some(200.0), Some("g"), "pantry"),
            ing("olive oil", Some(2.0), Some("tbsp"), "pantry"),
            ing("water", Some(1.0), Some("l"), "drinks"),
        ])];
        let lines = build_list(&meals, Some(&BuildPantry { cover: true, input: &input }));
        assert_eq!(lines.len(), 2);
        let rice = lines.iter().find(|l| l.name == "rice").unwrap();
        assert_eq!((rice.quantity, rice.covered), (Some(200.0), false));
        assert_eq!(rice.purchase, Some(Purchase { quantity: 500.0, unit: "g".into() }));
        assert!(lines.iter().find(|l| l.name == "pasta").unwrap().covered);
        let ignored = build_list(&meals, Some(&BuildPantry { cover: false, input: &input }));
        assert!(ignored.iter().all(|l| !l.covered) && ignored.len() == 2);
    }

    fn stored(id: &str, key: &str, name: &str, checked: bool) -> Stored {
        Stored { line_id: id.into(), line_key: Some(key.into()), manual: false, name: name.into(), quantity: Some(1.0),
            unit: None, purchase: None, section: "other".into(), covered: false, not_in_plan: false,
            converted_from: vec![], source_meal_ids: vec![], checked_at: checked.then(|| "t".to_owned()), bought_at: None, version: String::new() }
    }

    #[test]
    fn reconcile_keeps_ticks_and_marks_dropped_ticked_lines() {
        let generated = build_list(&[meal("m", 1.0, 1.0, vec![ing("egg", Some(2.0), None, "dairy_eggs")])], None);
        let mut kept = stored("a", "egg|count", "egg", true);
        kept.quantity = Some(2.0);
        kept.purchase = generated[0].purchase.clone();
        kept.section = "dairy_eggs".into();
        kept.source_meal_ids = vec!["m".into()];
        let mut manual = stored("m1", "x|count", "x", false);
        manual.manual = true;
        let diff = reconcile_list(
            &[kept, stored("b", "gone|count", "gone", false), stored("c", "kept|count", "kept", true), manual],
            &generated,
        );
        assert!(diff.insert.is_empty());
        assert_eq!(diff.remove, vec!["b"]);
        assert_eq!(diff.update.len(), 1);
        assert!(diff.update[0].not_in_plan && diff.update[0].line_id == "c");
    }

    #[test]
    fn names_sort_without_case_or_accents() {
        assert_eq!(locale_cmp("apple", "Banana"), Ordering::Less);
        assert_eq!(locale_cmp("Éclair", "eel"), Ordering::Less);
    }
}
