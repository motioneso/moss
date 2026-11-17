//! Unit families and conversion. Mass and volume convert within their family. Count (no unit)
//! and every other unit word never convert across, so "2 cloves" and "10 g" stay apart.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Mass,
    Volume,
    Count,
    Other,
}

/// Grams per unit.
const MASS: &[(&str, f64)] = &[("g", 1.0), ("kg", 1000.0), ("oz", 28.3495), ("lb", 453.592)];
/// Millilitres per unit.
const VOLUME: &[(&str, f64)] = &[
    ("ml", 1.0),
    ("l", 1000.0),
    ("tsp", 4.92892),
    ("tbsp", 14.7868),
    ("fl oz", 29.5735),
    ("cup", 236.588),
    ("pint", 473.176),
    ("quart", 946.353),
    ("gallon", 3785.41),
];

const ALIASES: &[(&str, &str)] = &[
    ("gram", "g"), ("grams", "g"), ("gr", "g"),
    ("kilogram", "kg"), ("kilograms", "kg"), ("kgs", "kg"),
    ("ounce", "oz"), ("ounces", "oz"),
    ("pound", "lb"), ("pounds", "lb"), ("lbs", "lb"),
    ("milliliter", "ml"), ("milliliters", "ml"), ("millilitre", "ml"), ("millilitres", "ml"),
    ("liter", "l"), ("liters", "l"), ("litre", "l"), ("litres", "l"),
    ("teaspoon", "tsp"), ("teaspoons", "tsp"),
    ("tablespoon", "tbsp"), ("tablespoons", "tbsp"), ("tbs", "tbsp"),
    ("cups", "cup"), ("c", "cup"),
    ("fluid ounce", "fl oz"), ("fluid ounces", "fl oz"), ("floz", "fl oz"),
    ("pints", "pint"), ("pt", "pint"),
    ("quarts", "quart"), ("qt", "quart"),
    ("gallons", "gallon"), ("gal", "gallon"),
];

fn factor(table: &[(&str, f64)], unit: &str) -> Option<f64> {
    table.iter().find(|(k, _)| *k == unit).map(|(_, v)| *v)
}

/// The unit's canonical spelling, or its lowercased trimmed text when it is not a known one.
pub fn normalise_unit(unit: Option<&str>) -> Option<String> {
    let text = unit?.trim().to_lowercase();
    let text = text.strip_suffix('.').unwrap_or(&text);
    if text.is_empty() {
        return None;
    }
    Some(ALIASES.iter().find(|(k, _)| *k == text).map_or(text, |(_, v)| v).to_owned())
}

pub fn unit_family(unit: Option<&str>) -> Family {
    match normalise_unit(unit) {
        None => Family::Count,
        Some(n) if factor(MASS, &n).is_some() => Family::Mass,
        Some(n) if factor(VOLUME, &n).is_some() => Family::Volume,
        Some(_) => Family::Other,
    }
}

/// None when the units are not in one convertible family.
pub fn convert(quantity: f64, from: &str, to: &str) -> Option<f64> {
    let (a, b) = (normalise_unit(Some(from))?, normalise_unit(Some(to))?);
    if a == b {
        return Some(quantity);
    }
    for table in [MASS, VOLUME] {
        if let (Some(x), Some(y)) = (factor(table, &a), factor(table, &b)) {
            return Some(quantity * x / y);
        }
    }
    None
}

fn plain(value: f64) -> String {
    let r = if value >= 10.0 { value.round() } else { (value * 100.0).round() / 100.0 };
    format!("{r}")
}

/// A readable number. Quarters read as fractions; anything else rounds to two places.
pub fn format_number(value: f64) -> String {
    let whole = (value + 1e-9).floor();
    let rest = value - whole;
    for (fraction, glyph) in [(0.25, "¼"), (0.5, "½"), (0.75, "¾")] {
        if (rest - fraction).abs() < 0.02 {
            return if whole == 0.0 { glyph.to_owned() } else { format!("{whole}{glyph}") };
        }
    }
    plain(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_and_families() {
        assert_eq!(normalise_unit(Some(" Grams. ")).as_deref(), Some("g"));
        assert_eq!(normalise_unit(Some("  ")), None);
        assert_eq!(unit_family(None), Family::Count);
        assert_eq!(unit_family(Some("tbs")), Family::Volume);
        assert_eq!(unit_family(Some("clove")), Family::Other);
        assert_eq!(unit_family(Some("lbs")), Family::Mass);
    }

    #[test]
    fn conversion_stays_in_family() {
        assert_eq!(convert(2.0, "kg", "g"), Some(2000.0));
        assert_eq!(convert(1.0, "g", "ml"), None);
        assert_eq!(convert(3.0, "clove", "clove"), Some(3.0));
    }

    #[test]
    fn numbers_read_like_the_old_ones() {
        assert_eq!(format_number(0.5), "½");
        assert_eq!(format_number(2.25), "2¼");
        assert_eq!(format_number(1.0), "1");
        assert_eq!(format_number(0.333), "0.33");
        assert_eq!(format_number(12.4), "12");
    }
}
