//! The deterministic half of the safety check, the merge with the model's verdict, and the
//! brand rule. The rule runs first and is conservative: a false failure costs one
//! regeneration, a false pass could serve an unsafe meal.
use crate::rules::fold;
use crate::safety_terms::*;

const MAX_REASON: usize = 200;

/// An ingredient line as the rule reads it.
pub struct Line<'a> {
    pub name: &'a str,
    pub original_text: &'a str,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Pass,
    Fail(String),
}

fn cap(text: &str) -> String {
    text.chars().take(MAX_REASON).collect()
}

/// Accents folded, lower case, words separated by single spaces.
pub fn normalise(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in text.to_lowercase().chars().filter_map(fold) {
        if c.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

fn expansion(phrase: &str) -> Option<Vec<&'static str>> {
    let join = |lists: &[&[&'static str]]| lists.concat();
    Some(match phrase {
        "vegetarian" => join(&[MEAT, FISH, SHELLFISH]),
        "vegan" => join(&[MEAT, FISH, SHELLFISH, DAIRY, EGG, &["honey"]]),
        "pescatarian" | "meat" => MEAT.to_vec(),
        "dairy" | "milk" | "lactose" => DAIRY.to_vec(),
        "cheese" => CHEESE.to_vec(),
        "gluten" | "wheat" | "coeliac" | "celiac" => GLUTEN.to_vec(),
        "egg" | "eggs" => EGG.to_vec(),
        "shellfish" => SHELLFISH.to_vec(),
        "fish" | "seafood" => join(&[FISH, SHELLFISH]),
        "tree nut" | "tree nuts" => TREE_NUTS.to_vec(),
        "nut" | "nuts" => join(&[TREE_NUTS, PEANUT, &["nut", "nuts"]]),
        "peanut" | "peanuts" => PEANUT.to_vec(),
        "pork" => PORK.to_vec(),
        "halal" => join(&[PORK, ALCOHOL]),
        "kosher" => join(&[PORK, SHELLFISH]),
        "alcohol" => ALCOHOL.to_vec(),
        "beef" => vec!["beef", "steak", "veal"],
        "soy" => SOY.to_vec(),
        "sesame" => vec!["sesame", "tahini"],
        _ => return None,
    })
}

const LEADING: &[&str] = &[
    "no ",
    "never ",
    "without ",
    "avoid ",
    "avoids ",
    "allergic to ",
    "allergy to ",
    "not ",
];
const TRAILING: &[&str] = &[
    " allergy",
    " allergies",
    " allergic",
    " intolerance",
    " intolerant",
    " sensitivity",
    " sensitive",
    " free",
];

/// The food a restriction names, without negation or "allergy" style words.
fn phrase_of(restriction: &str) -> String {
    let text = normalise(restriction);
    let mut text = text.as_str();
    if let Some(rest) = LEADING.iter().find_map(|p| text.strip_prefix(p)) {
        text = rest.trim_start();
    }
    if let Some(rest) = TRAILING.iter().find_map(|s| text.strip_suffix(s)) {
        text = rest.trim_end();
    }
    text.to_owned()
}

/// The terms one restriction rules out, with simple plural and singular forms.
fn terms_of(phrase: &str) -> Vec<String> {
    if phrase.is_empty() {
        return vec![];
    }
    let list = expansion(phrase).unwrap_or_else(|| vec![phrase]);
    list.iter()
        .flat_map(|term| {
            let base = normalise(term);
            match base.strip_suffix('s') {
                Some(single) => vec![base.clone(), single.to_owned()],
                None => vec![base.clone(), format!("{base}s"), format!("{base}es")],
            }
        })
        .collect()
}

fn contains_term(haystack: &str, term: &str) -> bool {
    format!(" {haystack} ").contains(&format!(" {term} "))
}

const AFTER_FREE_FROM: &[&str] = &[
    "and", "or", "with", "but", "plus", "contains", "contain", "for", "use", "not", "made",
];
const FARMING: &[&str] = &["range", "run", "roaming", "ranging"];
const NEGATIONS: &[&str] = &["not", "non", "never", "t"];

fn negated(words: &[String]) -> bool {
    let joined = words.join(" ");
    let parts: Vec<&str> = joined.trim().split(' ').collect();
    let last = parts.last().copied().unwrap_or("");
    let previous = if parts.len() >= 2 {
        parts[parts.len() - 2]
    } else {
        ""
    };
    NEGATIONS.contains(&last) || NEGATIONS.contains(&previous)
}

/// Whether the words at `at` spell the food (base, plural or "-es" form) and which form.
fn food_len(words: &[String], at: usize, food: &[Vec<String>]) -> Vec<usize> {
    food.iter()
        .filter(|f| words.len() >= at + f.len() && words[at..at + f.len()] == f[..])
        .map(|f| f.len())
        .collect()
}

/// Removes only the restriction's own label, "gluten free" or "free from gluten", and nothing
/// after it. A different food never clears the rule, and a negated label clears nothing.
fn strip_own_free_label(text: &str, phrase: &str) -> String {
    let base = phrase.strip_suffix('s').unwrap_or(phrase);
    let food: Vec<Vec<String>> = [base.to_owned(), format!("{base}s"), format!("{base}es")]
        .iter()
        .map(|f| f.split(' ').map(str::to_owned).collect())
        .collect();
    let mut words: Vec<String> = text.split(' ').map(str::to_owned).collect();

    // "free from <food>" or "free of <food>", only when the next word does not extend the food.
    let mut i = 0;
    while i < words.len() {
        if words[i] == "free" && words.get(i + 1).is_some_and(|w| w == "from" || w == "of") {
            let hit = food_len(&words, i + 2, &food).into_iter().find(|n| {
                let end = i + 2 + n;
                end == words.len() || AFTER_FREE_FROM.contains(&words[end].as_str())
            });
            if let Some(n) = hit {
                if !negated(&words[..i]) {
                    let end = i + 2 + n;
                    words.splice(i..end, [String::new()]);
                }
            }
        }
        i += 1;
    }

    // "<food> free", unless "range"-like farming words follow.
    let mut i = 0;
    while i < words.len() {
        let hit = food_len(&words, i, &food).into_iter().find(|n| {
            words.get(i + n).is_some_and(|w| w == "free")
                && !words
                    .get(i + n + 1)
                    .is_some_and(|w| FARMING.contains(&w.as_str()))
        });
        if let Some(n) = hit {
            if !negated(&words[..i]) {
                words.splice(i..i + n + 1, [String::new()]);
            }
        }
        i += 1;
    }
    words.join(" ")
}

pub fn deterministic_safety(lines: &[Line], restrictions: &[String]) -> Verdict {
    for restriction in restrictions {
        let phrase = phrase_of(restriction);
        let terms = terms_of(&phrase);
        for line in lines {
            let text = strip_own_free_label(
                &format!("{} {}", normalise(line.name), normalise(line.original_text)),
                &phrase,
            );
            if terms.iter().any(|t| contains_term(&text, t)) {
                return Verdict::Fail(cap(&format!(
                    "{} conflicts with \"{}\"",
                    line.name, restriction
                )));
            }
        }
    }
    Verdict::Pass
}

/// The model can add a failure but never clear the rule's.
pub fn merge(rule: Verdict, model: Option<&Verdict>) -> Verdict {
    match (&rule, model) {
        (Verdict::Fail(_), _) => rule,
        (_, Some(Verdict::Fail(reason))) => Verdict::Fail(cap(reason)),
        _ => rule,
    }
}

const PACKAGED: &[&str] = &[
    "jar",
    "jarred",
    "can",
    "canned",
    "tin",
    "tinned",
    "bottle",
    "bottled",
    "packet",
    "pack",
    "package",
    "packaged",
    "carton",
    "box",
    "boxed",
    "store bought",
    "shop bought",
    "ready made",
    "premade",
    "pre made",
    "instant",
    "stock cube",
    "bouillon",
    "brand",
    "frozen",
    "mix",
];

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn possessive_brand(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    (0..chars.len()).any(|i| {
        if !chars[i].is_uppercase() || (i > 0 && word_char(chars[i - 1])) {
            return false;
        }
        let mut j = i + 1;
        while j < chars.len() && chars[j].is_alphabetic() {
            j += 1;
        }
        chars.get(j) == Some(&'\'')
            && chars.get(j + 1) == Some(&'s')
            && !chars.get(j + 2).copied().is_some_and(word_char)
    })
}

/// True when a line names a brand or a packaged product, whose label must be read.
pub fn brand_rule(original_text: &str) -> bool {
    if original_text.contains(['™', '®', '©']) || possessive_brand(original_text) {
        return true;
    }
    let text = normalise(original_text);
    if PACKAGED
        .iter()
        .any(|w| contains_term(&text, w) || contains_term(&text, &format!("{w}s")))
    {
        return true;
    }
    // A capitalised word after the first one is most likely a brand name.
    original_text.split_whitespace().skip(1).any(|w| {
        let mut chars = w.chars();
        chars.next().is_some_and(char::is_uppercase) && chars.next().is_some_and(char::is_lowercase)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(name: &str, restrictions: &[&str]) -> Verdict {
        let r: Vec<String> = restrictions.iter().map(|s| s.to_string()).collect();
        deterministic_safety(
            &[Line {
                name,
                original_text: name,
            }],
            &r,
        )
    }

    #[test]
    fn diet_words_expand_and_plurals_match() {
        assert!(matches!(
            check("chicken thighs", &["vegetarian"]),
            Verdict::Fail(_)
        ));
        assert!(matches!(check("Honey", &["vegan"]), Verdict::Fail(_)));
        assert_eq!(check("rice", &["vegan"]), Verdict::Pass);
        assert!(matches!(
            check("crushed almond", &["nuts"]),
            Verdict::Fail(_)
        ));
        assert!(matches!(
            check("peanut allergy", &["no peanuts"]),
            Verdict::Fail(_)
        ));
        assert!(matches!(check("flour", &["Gluten-free"]), Verdict::Fail(_)));
        assert_eq!(check("tomato", &[""]), Verdict::Pass);
    }

    #[test]
    fn own_free_label_clears_only_that_food() {
        assert_eq!(check("gluten free brownies", &["gluten"]), Verdict::Pass);
        let lines = [Line {
            name: "brownies",
            original_text: "brownies free from gluten",
        }];
        assert_eq!(
            deterministic_safety(&lines, &["gluten".to_string()]),
            Verdict::Pass
        );
        // A different food, a negated label and a compound food clear nothing.
        assert!(matches!(
            check("lactose free milk", &["dairy"]),
            Verdict::Fail(_)
        ));
        assert!(matches!(
            check("not gluten free pasta", &["gluten"]),
            Verdict::Fail(_)
        ));
        assert!(matches!(
            check("free from milk chocolate", &["milk"]),
            Verdict::Fail(_)
        ));
        // Other words on the line are still scanned.
        assert!(matches!(
            check("gluten free soy sauce", &["gluten"]),
            Verdict::Fail(_)
        ));
        assert!(matches!(
            check("egg free range eggs", &["egg"]),
            Verdict::Fail(_)
        ));
    }

    #[test]
    fn the_reason_is_capped() {
        let long = "x".repeat(400);
        let Verdict::Fail(reason) = check(&format!("chicken {long}"), &["meat"]) else {
            panic!("expected a failure")
        };
        assert_eq!(reason.chars().count(), 200);
    }

    #[test]
    fn the_model_can_add_a_failure_but_never_clear_one() {
        let fail = Verdict::Fail("rule".into());
        assert_eq!(merge(fail.clone(), Some(&Verdict::Pass)), fail);
        assert_eq!(merge(fail.clone(), None), fail);
        assert_eq!(
            merge(Verdict::Pass, Some(&Verdict::Fail("model".into()))),
            Verdict::Fail("model".into())
        );
        assert_eq!(merge(Verdict::Pass, Some(&Verdict::Pass)), Verdict::Pass);
        let long = Verdict::Fail("y".repeat(300));
        let Verdict::Fail(r) = merge(Verdict::Pass, Some(&long)) else {
            panic!()
        };
        assert_eq!(r.chars().count(), 200);
    }

    #[test]
    fn brand_rule_flags_brands_and_packaged_food() {
        assert!(brand_rule("1 jar Sauce"));
        assert!(brand_rule("Kellogg's cereal"));
        assert!(brand_rule("2 cups Heinz ketchup"));
        assert!(brand_rule("Tabasco™ sauce"));
        assert!(!brand_rule("2 cups rice"));
    }
}
