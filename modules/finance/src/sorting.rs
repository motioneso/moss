//! Category sorting for new transactions. The decision code is pure so it tests without a host.
//!
//! Order per uncategorized row is rule, then bank category map, then AI. A rule always confirms.
//! A bank-map or AI result confirms only when the account's tier for its family is trusted_auto.
//! The family is `sorting` for a merchant with confirmed history and `sorting_new` for a new one.
//! An AI guess under 0.6 confidence, or with none, always needs a look.
use crate::text::normalize_payee;
use std::collections::{BTreeMap, BTreeSet};

pub const AI_CONFIDENCE_FLOOR: f64 = 0.6;
pub const AI_BATCH_SIZE: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tier {
    AskEachTime,
    TrustedAuto,
    AlwaysConfirm,
}
impl Tier {
    pub fn parse(text: &str) -> Option<Tier> {
        match text {
            "ask_each_time" => Some(Tier::AskEachTime),
            "trusted_auto" => Some(Tier::TrustedAuto),
            "always_confirm" => Some(Tier::AlwaysConfirm),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source {
    Rule,
    BankMap,
    Ai,
}

/// Tiers of the two sorting families.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Policy {
    pub sorting: Tier,
    pub sorting_new: Tier,
}
impl Default for Policy {
    /// The install defaults the old manifest declared.
    fn default() -> Self {
        Policy { sorting: Tier::TrustedAuto, sorting_new: Tier::AskEachTime }
    }
}

pub fn decide_review(source: Source, seen: bool, confidence: Option<f64>, policy: &Policy) -> &'static str {
    if source == Source::Rule {
        return "confirmed";
    }
    if source == Source::Ai && confidence.map_or(true, |c| c < AI_CONFIDENCE_FLOOR) {
        return "needs_look";
    }
    let tier = if seen { policy.sorting } else { policy.sorting_new };
    if tier == Tier::TrustedAuto { "confirmed" } else { "needs_look" }
}

/// Coarse bank category to category id. Anything unmapped falls through to AI or stays open.
pub fn bank_map(category: &str) -> Option<&'static str> {
    Some(match category {
        "FOOD_AND_DRINK" => "dining",
        "GENERAL_MERCHANDISE" | "HOME_IMPROVEMENT" => "shopping",
        "RENT_AND_UTILITIES" => "utilities",
        "TRANSPORTATION" => "transport",
        "TRAVEL" => "travel",
        "MEDICAL" => "health",
        "ENTERTAINMENT" => "entertainment",
        "INCOME" => "income",
        "TRANSFER_IN" | "TRANSFER_OUT" => "transfers",
        "LOAN_PAYMENTS" => "rent-mortgage",
        "BANK_FEES" | "GENERAL_SERVICES" | "GOVERNMENT_AND_NON_PROFIT" => "subscriptions",
        "PERSONAL_CARE" => "personal-care",
        _ => return None,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub amount_cents: i64,
    pub date: String,
    pub plaid_category: Option<String>,
    pub category_id: Option<String>,
    pub categorized_by: Option<String>,
    pub review_state: String,
    pub ai_confidence: Option<f64>,
    /// The row carries balanced split parts, so it needs no single category.
    pub split_balanced: bool,
}

/// The only fields that ever leave for a model: id, payee, amount and date.
#[derive(Clone, Debug, PartialEq)]
pub struct AiInput {
    pub id: String,
    pub payee: String,
    pub amount_cents: i64,
    pub date: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Guess {
    pub category_id: String,
    pub confidence: f64,
}
pub trait Ai {
    fn guess(&self, batch: &[AiInput], category_ids: &[String]) -> Result<BTreeMap<String, Guess>, ()>;
}

pub struct Context<'a> {
    /// Enabled rules as payee key to category id.
    pub rules: &'a BTreeMap<String, String>,
    pub live_ids: &'a [String],
    pub policy: Policy,
    /// Payee keys of merchants with confirmed, categorized history.
    pub seen: BTreeSet<String>,
}

/// Sorts the rows that have no category yet. Rows already placed are returned unchanged, so a
/// second run over the same rows changes nothing. Leftover open rows wait in "needs a look".
pub fn categorize(rows: Vec<Row>, context: &Context, ai: Option<&dyn Ai>) -> Vec<Row> {
    let mut seen = context.seen.clone();
    let live: BTreeSet<&str> = context.live_ids.iter().map(String::as_str).collect();
    let mut decide = |row: &Row, source: Source, confidence: Option<f64>| -> String {
        let key = normalize_payee(&row.name);
        let state = decide_review(source, seen.contains(&key), confidence, &context.policy);
        if state == "confirmed" {
            seen.insert(key);
        }
        state.to_owned()
    };
    let mut out: Vec<Row> = Vec::with_capacity(rows.len());
    let mut open: Vec<usize> = Vec::new();
    for row in rows {
        if row.category_id.is_some() || row.categorized_by.is_some() || row.split_balanced {
            out.push(row);
            continue;
        }
        let ruled = context.rules.get(&normalize_payee(&row.name)).filter(|c| live.contains(c.as_str()));
        if let Some(category) = ruled {
            let state = decide(&row, Source::Rule, None);
            out.push(Row { category_id: Some(category.clone()), categorized_by: Some("rule".into()), review_state: state, ai_confidence: None, ..row });
            continue;
        }
        if let Some(mapped) = row.plaid_category.as_deref().and_then(bank_map) {
            let state = decide(&row, Source::BankMap, None);
            out.push(Row { category_id: Some(mapped.into()), categorized_by: Some("plaid-map".into()), review_state: state, ai_confidence: None, ..row });
            continue;
        }
        open.push(out.len());
        out.push(row);
    }
    if let (Some(ai), false) = (ai, open.is_empty()) {
        let mut assigned: BTreeMap<String, Guess> = BTreeMap::new();
        for chunk in open.chunks(AI_BATCH_SIZE) {
            let batch: Vec<AiInput> = chunk
                .iter()
                .map(|&i| AiInput { id: out[i].id.clone(), payee: out[i].name.clone(), amount_cents: out[i].amount_cents, date: out[i].date.clone() })
                .collect();
            // A failed batch stays open and later batches still run.
            if let Ok(found) = ai.guess(&batch, context.live_ids) {
                for (id, guess) in found {
                    // An unknown or archived id is dropped, never matched to the nearest one.
                    if live.contains(guess.category_id.as_str()) {
                        assigned.insert(id, guess);
                    }
                }
            }
        }
        for &i in &open {
            if let Some(guess) = assigned.get(&out[i].id).cloned() {
                let state = decide(&out[i], Source::Ai, Some(guess.confidence));
                let row = &mut out[i];
                row.category_id = Some(guess.category_id);
                row.categorized_by = Some("ai".into());
                row.review_state = state;
                row.ai_confidence = Some(guess.confidence);
            }
        }
    }
    for row in &mut out {
        if row.category_id.is_none() && !row.split_balanced && row.review_state != "needs_look" {
            row.review_state = "needs_look".into();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn row(id: &str, name: &str) -> Row {
        Row { id: id.into(), name: name.into(), amount_cents: 450, date: "2026-11-10".into(), plaid_category: None, category_id: None,
            categorized_by: None, review_state: "confirmed".into(), ai_confidence: None, split_balanced: false }
    }
    fn ids() -> Vec<String> {
        ["dining", "shopping", "groceries", "transfers"].iter().map(|s| s.to_string()).collect()
    }
    struct Canned(RefCell<Vec<Vec<String>>>, BTreeMap<String, Guess>, bool);
    impl Ai for Canned {
        fn guess(&self, batch: &[AiInput], _: &[String]) -> Result<BTreeMap<String, Guess>, ()> {
            self.0.borrow_mut().push(batch.iter().map(|b| b.id.clone()).collect());
            if self.2 { Err(()) } else { Ok(self.1.clone()) }
        }
    }
    fn guess(category: &str, confidence: f64) -> Guess {
        Guess { category_id: category.into(), confidence }
    }
    fn run(rows: Vec<Row>, rules: &[(&str, &str)], policy: Policy, seen: &[&str], ai: Option<&dyn Ai>) -> Vec<Row> {
        let rules: BTreeMap<String, String> = rules.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let live = ids();
        let context = Context { rules: &rules, live_ids: &live, policy, seen: seen.iter().map(|s| s.to_string()).collect() };
        categorize(rows, &context, ai)
    }

    #[test]
    fn the_review_table_keeps_its_tiers() {
        use Source::*;
        use Tier::*;
        let p = |sorting, sorting_new| Policy { sorting, sorting_new };
        for tier in [AskEachTime, TrustedAuto, AlwaysConfirm] {
            assert_eq!(decide_review(Rule, true, None, &p(tier, tier)), "confirmed");
            assert_eq!(decide_review(Rule, false, None, &p(tier, tier)), "confirmed");
        }
        // A seen merchant follows the sorting tier and a new one the sorting_new tier.
        assert_eq!(decide_review(BankMap, true, None, &p(TrustedAuto, AskEachTime)), "confirmed");
        assert_eq!(decide_review(BankMap, false, None, &p(TrustedAuto, AskEachTime)), "needs_look");
        assert_eq!(decide_review(BankMap, false, None, &p(AskEachTime, TrustedAuto)), "confirmed");
        assert_eq!(decide_review(BankMap, true, None, &p(AskEachTime, TrustedAuto)), "needs_look");
        assert_eq!(decide_review(BankMap, true, None, &p(AlwaysConfirm, AlwaysConfirm)), "needs_look");
        assert_eq!(decide_review(Ai, true, Some(0.9), &p(TrustedAuto, TrustedAuto)), "confirmed");
        assert_eq!(decide_review(Ai, true, Some(0.9), &p(AskEachTime, TrustedAuto)), "needs_look");
        // The confidence floor is 0.6 and a missing confidence always needs a look.
        assert_eq!(decide_review(Ai, true, Some(0.6), &p(TrustedAuto, TrustedAuto)), "confirmed");
        assert_eq!(decide_review(Ai, true, Some(0.59), &p(TrustedAuto, TrustedAuto)), "needs_look");
        assert_eq!(decide_review(Ai, true, None, &p(TrustedAuto, TrustedAuto)), "needs_look");
        // A bank-map result ignores confidence.
        assert_eq!(decide_review(BankMap, true, Some(0.0), &p(TrustedAuto, TrustedAuto)), "confirmed");
    }

    #[test]
    fn install_defaults_trust_known_merchants_and_ask_about_new_ones() {
        let d = Policy::default();
        assert_eq!((d.sorting, d.sorting_new), (Tier::TrustedAuto, Tier::AskEachTime));
    }

    #[test]
    fn a_rule_wins_over_the_bank_map_and_confirms() {
        let mut r = row("a", "Blue Bottle #12");
        r.plaid_category = Some("FOOD_AND_DRINK".into());
        let out = run(vec![r], &[("blue bottle", "groceries")], Policy { sorting: Tier::AskEachTime, sorting_new: Tier::AskEachTime }, &[], None);
        assert_eq!(out[0].category_id.as_deref(), Some("groceries"));
        assert_eq!((out[0].categorized_by.as_deref(), out[0].review_state.as_str()), (Some("rule"), "confirmed"));
    }

    #[test]
    fn a_rule_to_an_archived_category_is_ignored() {
        let out = run(vec![row("a", "Zed")], &[("zed", "gone")], Policy::default(), &[], None);
        assert!(out[0].category_id.is_none());
        assert_eq!(out[0].review_state, "needs_look");
    }

    #[test]
    fn the_bank_map_confirms_only_under_a_trusted_tier() {
        let mut seen_row = row("a", "Taqueria");
        seen_row.plaid_category = Some("FOOD_AND_DRINK".into());
        let mut new_row = row("b", "Brand New Cafe");
        new_row.plaid_category = Some("FOOD_AND_DRINK".into());
        let out = run(vec![seen_row, new_row], &[], Policy::default(), &["taqueria"], None);
        assert_eq!((out[0].categorized_by.as_deref(), out[0].review_state.as_str()), (Some("plaid-map"), "confirmed"));
        assert_eq!((out[1].category_id.as_deref(), out[1].review_state.as_str()), (Some("dining"), "needs_look"));
    }

    #[test]
    fn a_merchant_just_confirmed_counts_as_seen_for_the_rest_of_the_run() {
        // New merchants are trusted, known ones are not. The first row confirms as new, so the
        // second row of that merchant is already known and follows the other tier.
        let policy = Policy { sorting: Tier::AskEachTime, sorting_new: Tier::TrustedAuto };
        let mut first = row("a", "Fresh Cafe 1");
        first.plaid_category = Some("FOOD_AND_DRINK".into());
        let mut second = row("b", "Fresh Cafe 2");
        second.plaid_category = Some("FOOD_AND_DRINK".into());
        let out = run(vec![first, second], &[], policy, &[], None);
        assert_eq!((out[0].review_state.as_str(), out[1].review_state.as_str()), ("confirmed", "needs_look"));
    }

    #[test]
    fn ai_sorts_what_is_left_and_only_sends_four_fields() {
        let ai = Canned(RefCell::new(vec![]), BTreeMap::from([("a".to_string(), guess("shopping", 0.9)), ("b".to_string(), guess("shopping", 0.5))]), false);
        let policy = Policy { sorting: Tier::TrustedAuto, sorting_new: Tier::TrustedAuto };
        let mut a = row("a", "Mystery Store");
        a.plaid_category = Some("UNMAPPED".into());
        let out = run(vec![a, row("b", "Other Store")], &[], policy, &[], Some(&ai));
        assert_eq!((out[0].categorized_by.as_deref(), out[0].review_state.as_str(), out[0].ai_confidence), (Some("ai"), "confirmed", Some(0.9)));
        assert_eq!((out[1].review_state.as_str(), out[1].ai_confidence), ("needs_look", Some(0.5)));
        assert_eq!(ai.0.borrow().len(), 1);
    }

    #[test]
    fn ai_ids_that_are_unknown_are_dropped_and_a_failed_batch_leaves_rows_open() {
        let ai = Canned(RefCell::new(vec![]), BTreeMap::from([("a".to_string(), guess("not-a-category", 0.99))]), false);
        let out = run(vec![row("a", "Zed")], &[], Policy::default(), &[], Some(&ai));
        assert!(out[0].category_id.is_none() && out[0].review_state == "needs_look");
        let failing = Canned(RefCell::new(vec![]), BTreeMap::new(), true);
        let out = run(vec![row("a", "Zed")], &[], Policy::default(), &[], Some(&failing));
        assert!(out[0].category_id.is_none() && out[0].review_state == "needs_look");
    }

    #[test]
    fn ai_runs_in_batches_of_forty() {
        let rows: Vec<Row> = (0..85).map(|i| row(&format!("r{i:02}"), "Zed")).collect();
        let ai = Canned(RefCell::new(vec![]), BTreeMap::new(), false);
        run(rows, &[], Policy::default(), &[], Some(&ai));
        let sizes: Vec<usize> = ai.0.borrow().iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![40, 40, 5]);
    }

    #[test]
    fn placed_rows_are_left_alone_and_a_second_run_changes_nothing() {
        let mut placed = row("p", "Zed");
        placed.category_id = Some("dining".into());
        placed.categorized_by = Some("user".into());
        let mut by_user_open = row("q", "Zed");
        by_user_open.categorized_by = Some("user".into());
        let mut balanced = row("s", "Zed");
        balanced.split_balanced = true;
        let rules = [("zed", "groceries")];
        let once = run(vec![placed.clone(), by_user_open.clone(), balanced.clone(), row("n", "Zed")], &rules, Policy::default(), &[], None);
        assert_eq!(once[0], placed);
        assert_eq!((once[1].category_id.clone(), once[1].review_state.as_str()), (None, "needs_look"));
        assert_eq!(once[2], balanced);
        assert_eq!(once[3].category_id.as_deref(), Some("groceries"));
        let twice = run(once.clone(), &rules, Policy::default(), &[], None);
        assert_eq!(once, twice);
    }
}
