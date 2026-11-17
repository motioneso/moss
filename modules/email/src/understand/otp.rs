//! Recognizing mail that hands over a sign-in code. Deterministic and run before any
//! model call. All three signals must hold: the subject delivers a sign-in code, the
//! start of the text hands a short code over, and nothing points at a door, stay,
//! order, delivery, booking or money-off code. The sender is never read.
use super::text::{has_any_word, has_phrase, is_alnum, words};
use std::collections::HashSet;

const PHRASES: &[&str] = &[
    "verification code", "verification passcode", "one-time code", "one time code",
    "onetime code", "one-time passcode", "one time passcode", "onetime passcode",
    "one-time password", "one time password", "onetime password", "single-use code",
    "single use code", "single-use passcode", "single use passcode", "login code",
    "log-in code", "log in code", "signin code", "sign-in code", "sign in code",
    "login passcode", "sign-in passcode", "sign in passcode", "authentication code",
    "authentication passcode", "security code", "two-factor code", "two factor code",
    "two-step code", "two step code", "2fa code",
];

const NOT_A_SIGN_IN: &[&str] = &[
    "door", "doors", "apartment", "apartments", "apt", "flat", "room", "rooms", "gate",
    "gates", "lock", "locks", "keypad", "garage", "entry", "entrance", "building", "locker",
    "stay", "stays", "checkin", "checkout", "order", "orders", "tracking", "parcel",
    "package", "delivery", "deliveries", "shipment", "shipping", "courier", "booking",
    "bookings", "reservation", "reservations", "voucher", "vouchers", "coupon", "coupons",
    "discount", "discounts", "promo", "promotion", "promotions",
];

const ABOUT_CODES: &[&str] = &[
    "policy", "policies", "update", "updates", "updated", "updating", "change", "changes",
    "changed", "changing", "deliver", "delivers", "delivered", "delivering", "announcement",
    "announcing", "notice", "reminder", "terms",
];

const DISCUSSES: &[&str] = &[
    "about", "regarding", "question", "questions", "query", "queries", "help", "problem",
    "problems", "issue", "issues", "trouble", "advice",
];

const CODE_WORDS: &[&str] = &["code", "passcode", "password", "otp"];
const ELSEWHERE: &[&str] = &[
    "reject", "rejects", "rejected", "rejecting", "refuse", "refuses", "refused", "error",
    "errors", "case", "ticket", "tickets", "reference", "ref", "order", "orders", "call",
    "calls", "calling", "phone", "dial", "desk", "extension", "invoice", "statement",
];

const CHECK_BODY_CHARS: usize = 500;
const CONTEXT_CHARS: usize = 64;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum SignInCode {
    HandsOver,
    Unclear,
    Ordinary,
}

fn names_a_sign_in_code(text: &str) -> bool {
    PHRASES.iter().any(|p| text.contains(p)) || has_any_word(text, &["otp"])
}

fn not_a_sign_in_message(text: &str) -> bool {
    if has_any_word(text, NOT_A_SIGN_IN) {
        return true;
    }
    // "check in" and "check-out" written as two words.
    let chars: Vec<char> = text.chars().collect();
    let found = words(&chars);
    found.windows(2).any(|pair| {
        let gap = pair[1].start - pair[0].end;
        let first: String = chars[pair[0].start..pair[0].end].iter().collect();
        let second: String = chars[pair[1].start..pair[1].end].iter().collect();
        first == "check"
            && (second == "in" || second == "out")
            && gap == 1
            && (chars[pair[0].end].is_whitespace() || chars[pair[0].end] == '-')
    })
}

/// Blanks telephone-shaped digit runs while keeping the text length.
fn without_telephone_numbers(text: &str) -> Vec<char> {
    let mut chars: Vec<char> = text.chars().collect();
    blank_matches(&mut chars, bracketed_phone);
    blank_matches(&mut chars, plain_phone);
    chars
}

fn blank_matches(chars: &mut Vec<char>, matcher: fn(&[char], usize) -> Option<usize>) {
    let mut i = 0;
    while i < chars.len() {
        match matcher(chars, i) {
            Some(end) if end > i => {
                for c in &mut chars[i..end] {
                    *c = ' ';
                }
                i = end;
            }
            _ => i += 1,
        }
    }
}

fn digit(chars: &[char], i: usize) -> bool {
    chars.get(i).is_some_and(|c| c.is_ascii_digit())
}

fn not_alnum_at(chars: &[char], i: usize) -> bool {
    !chars.get(i).is_some_and(|c| is_alnum(*c))
}

/// `(415) 555-4829` and `(+44) 20 7946 0958`.
fn bracketed_phone(chars: &[char], i: usize) -> Option<usize> {
    if i > 0 && is_alnum(chars[i - 1]) || chars.get(i) != Some(&'(') {
        return None;
    }
    let mut p = i + 1;
    while chars.get(p).is_some_and(|c| c.is_whitespace()) {
        p += 1;
    }
    if chars.get(p) == Some(&'+') {
        p += 1;
    }
    let digits = (p..).take_while(|q| digit(chars, *q)).count();
    if !(1..=5).contains(&digits) {
        return None;
    }
    p += digits;
    while chars.get(p).is_some_and(|c| c.is_whitespace()) {
        p += 1;
    }
    if chars.get(p) != Some(&')') {
        return None;
    }
    p += 1;
    while chars.get(p).is_some_and(|c| c.is_whitespace() || *c == '.' || *c == '-') {
        p += 1;
    }
    if !digit(chars, p) {
        return None;
    }
    p += 1;
    let run_end = (p..)
        .take_while(|q| chars.get(*q).is_some_and(|c| c.is_ascii_digit() || c.is_whitespace() || *c == '.' || *c == '-'))
        .last()
        .map_or(p, |q| q + 1);
    (p..run_end).rev().find(|j| digit(chars, *j) && not_alnum_at(chars, j + 1)).map(|j| j + 1)
}

/// Digit groups split by spaces, dots or hyphens, three or more groups.
fn plain_phone(chars: &[char], i: usize) -> Option<usize> {
    if i > 0 && is_alnum(chars[i - 1]) {
        return None;
    }
    let mut p = i;
    if chars.get(p) == Some(&'+') {
        p += 1;
    }
    if !digit(chars, p) {
        return None;
    }
    let mut failed = HashSet::new();
    groups(chars, p + 1, 0, &mut failed)
}

fn digit_run(chars: &[char], from: usize) -> usize {
    (from..).take_while(|q| chars.get(*q).is_some_and(|c| c.is_ascii_digit() || *c == '.' || *c == '-')).count()
}

/// Matches `[\d.-]*` then groups of `[\s.-]\d[\d.-]*`, longest first with backtracking.
fn groups(chars: &[char], from: usize, count: u8, failed: &mut HashSet<(usize, u8)>) -> Option<usize> {
    let state = (from, count.min(2));
    if failed.contains(&state) {
        return None;
    }
    for take in (0..=digit_run(chars, from)).rev() {
        let q = from + take;
        let separator = chars.get(q).is_some_and(|c| c.is_whitespace() || *c == '.' || *c == '-');
        if separator && digit(chars, q + 1) {
            if let Some(end) = groups(chars, q + 2, count.saturating_add(1), failed) {
                return Some(end);
            }
        }
        if count >= 2 && not_alnum_at(chars, q) {
            return Some(q);
        }
    }
    failed.insert(state);
    None
}

fn year(candidate: &str) -> bool {
    candidate.len() == 4
        && candidate.chars().all(|c| c.is_ascii_digit())
        && (candidate.starts_with("19") || candidate.starts_with("20"))
}

/// Standalone short codes: four to eight digits, or six to eight letters and digits
/// mixed, not glued to other letters or digits. Returns (start, text).
fn candidates(chars: &[char]) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !is_alnum(chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_alnum(chars[i]) {
            i += 1;
        }
        let run: String = chars[start..i].iter().collect();
        let len = run.len();
        let digits = run.chars().filter(char::is_ascii_digit).count();
        let all_digits = digits == len;
        let mixed = digits > 0 && digits < len;
        if (all_digits && (4..=8).contains(&len)) || (mixed && (6..=8).contains(&len)) {
            out.push((start, run));
        }
    }
    out
}

fn has_deliverable_code(text: &str) -> bool {
    candidates(&without_telephone_numbers(text)).iter().any(|(_, c)| !year(c))
}

fn line_start(chars: &[char], start: usize) -> usize {
    chars[..start].iter().rposition(|c| *c == '\n').map_or(0, |p| p + 1)
}

fn trailing_space_or_colon(before: &[char]) -> usize {
    before.iter().rposition(|c| !(c.is_whitespace() || *c == ':')).map_or(0, |p| p + 1)
}

fn word_texts(chars: &[char]) -> Vec<(usize, usize, String)> {
    words(chars).into_iter().map(|w| (w.start, w.end, chars[w.start..w.end].iter().collect())).collect()
}

/// "code is", "code:" and similar, closing the text before the number.
fn hands_over_before_first(before: &[char]) -> bool {
    let tail = trailing_space_or_colon(before);
    let found = word_texts(before);
    let via_colon = before[tail..].iter().position(|c| *c == ':').map(|p| tail + p);
    let via_is = found.last().filter(|(_, end, w)| *end == tail && w == "is").map(|(s, _, _)| *s);
    found.iter().any(|(_, end, w)| {
        CODE_WORDS.contains(&w.as_str())
            && (via_colon.is_some_and(|c| *end <= c && c - end <= 16)
                || via_is.is_some_and(|s| *end <= s && s - end <= 16))
    })
}

/// "Enter 482910", "Please use ...", opening its sentence.
fn hands_over_before_second(before: &[char]) -> bool {
    let mut starts = vec![0];
    let mut i = 0;
    while i < before.len() {
        if matches!(before[i], '.' | '!' | '?') {
            let mut j = i + 1;
            while j < before.len() && before[j].is_whitespace() {
                j += 1;
            }
            if j > i + 1 {
                starts.push(j);
            }
        }
        i += 1;
    }
    let at = |s: usize, lit: &str| {
        let n = lit.chars().count();
        s + n <= before.len() && before[s..s + n].iter().collect::<String>() == lit
    };
    for s in starts {
        let mut options = vec![s];
        if at(s, "please") {
            let mut j = s + 6;
            while j < before.len() && before[j].is_whitespace() {
                j += 1;
            }
            if j > s + 6 {
                options.push(j);
            }
        }
        for o in options {
            for verb in ["enter", "use", "using", "type"] {
                let end = o + verb.len();
                if at(o, verb) && (end == before.len() || !super::text::is_word(before[end])) && before.len() - end <= 32 {
                    return true;
                }
            }
        }
    }
    false
}

/// "482910 is your Google code".
fn hands_over_after(after: &[char]) -> bool {
    let line_end = after.iter().position(|c| *c == '\n').unwrap_or(after.len());
    let line = &after[..line_end];
    let found = word_texts(line);
    found.iter().any(|(start, end, w)| {
        w == "is"
            && *start <= 4
            && found.iter().any(|(s2, _, w2)| *s2 >= *end && s2 - end <= 40 && CODE_WORDS.contains(&w2.as_str()))
    })
}

fn belongs_to_something_else(before: &[char]) -> bool {
    word_texts(before).iter().any(|(_, end, w)| {
        ELSEWHERE.contains(&w.as_str()) && before.len() - end <= 16
    })
}

fn stands_alone_under_naming_line(chars: &[char], start: usize, candidate: &str) -> bool {
    let line_from = line_start(chars, start);
    let line_to = chars[start..].iter().position(|c| *c == '\n').map_or(chars.len(), |p| start + p);
    let line: String = chars[line_from..line_to].iter().collect();
    if line.trim() != candidate {
        return false;
    }
    let before: String = chars[..line_from].iter().collect();
    let above = before.split('\n').map(str::trim).filter(|l| !l.is_empty()).last();
    above.is_some_and(|l| has_any_word(l, CODE_WORDS) && names_a_sign_in_code(l))
}

fn hands_over_a_code(text: &str) -> bool {
    let chars = without_telephone_numbers(text);
    for (start, candidate) in candidates(&chars) {
        if year(&candidate) {
            continue;
        }
        let from = line_start(&chars, start).max(start.saturating_sub(CONTEXT_CHARS));
        let before = &chars[from..start];
        if belongs_to_something_else(before) {
            continue;
        }
        let after_from = start + candidate.chars().count();
        let after = &chars[after_from..(after_from + CONTEXT_CHARS).min(chars.len())];
        if hands_over_before_first(before)
            || hands_over_before_second(before)
            || hands_over_after(after)
            || stands_alone_under_naming_line(&chars, start, &candidate)
        {
            return true;
        }
    }
    false
}

fn is_reply_or_forward(subject: &str) -> bool {
    let chars: Vec<char> = subject.chars().collect();
    let skip_space = |mut i: usize| {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        i
    };
    let mut positions = vec![skip_space(0)];
    loop {
        let at = *positions.last().unwrap_or(&0);
        if chars.get(at) != Some(&'[') {
            break;
        }
        let close = (at + 1..chars.len().min(at + 34)).find(|i| chars[*i] == ']' || chars[*i] == '\n');
        match close {
            Some(i) if chars[i] == ']' => positions.push(skip_space(i + 1)),
            _ => break,
        }
    }
    positions.into_iter().any(|p| {
        ["re", "fwd", "fw", "rv", "aw", "tr"].iter().any(|kw| {
            let end = p + kw.len();
            if end > chars.len() || chars[p..end].iter().collect::<String>() != *kw {
                return false;
            }
            let mut q = skip_space(end);
            if chars.get(q) == Some(&'[') {
                let digits = (q + 1..).take_while(|i| digit(&chars, *i)).count();
                if (1..=3).contains(&digits) && chars.get(q + 1 + digits) == Some(&']') {
                    q = skip_space(q + 2 + digits);
                }
            }
            chars.get(q) == Some(&':')
        })
    })
}

fn subject_delivers_a_code(subject: &str) -> bool {
    let chars: Vec<char> = subject.chars().collect();
    let found = word_texts(&chars);
    let your = found.iter().any(|(_, end, w)| {
        w == "your"
            && found.iter().any(|(s2, _, w2)| {
                *s2 > *end && CODE_WORDS.contains(&w2.as_str()) && s2 - end <= 24
                    && !chars[*end..*s2].contains(&'\n')
            })
    });
    let code_is = found.iter().any(|(_, end, w)| {
        matches!(w.as_str(), "code" | "passcode" | "password") && {
            let mut p = *end;
            while chars.get(p).is_some_and(|c| c.is_whitespace()) {
                p += 1;
            }
            chars.get(p) == Some(&':')
                || (chars.get(p) == Some(&'i') && chars.get(p + 1) == Some(&'s') && not_word_at(&chars, p + 2))
        }
    });
    your || code_is || has_phrase(subject, "is your") || has_phrase(subject, "use code") || has_phrase(subject, "use this code")
}

fn not_word_at(chars: &[char], i: usize) -> bool {
    !chars.get(i).is_some_and(|c| super::text::is_word(*c))
}

fn subject_names_a_sign_in_code(subject: &str) -> bool {
    if !names_a_sign_in_code(subject) {
        return false;
    }
    if has_any_word(subject, ABOUT_CODES)
        || is_reply_or_forward(subject)
        || has_any_word(subject, DISCUSSES)
    {
        return false;
    }
    subject_delivers_a_code(subject) || has_deliverable_code(subject)
}

pub fn looks_like_one_time_code(subject: &str, body: &str) -> bool {
    let subject = subject.to_lowercase();
    if !subject_names_a_sign_in_code(&subject) {
        return false;
    }
    let body = body.to_lowercase();
    if not_a_sign_in_message(&format!("{subject}\n{body}")) {
        return false;
    }
    let head: String = body.chars().take(CHECK_BODY_CHARS).collect();
    hands_over_a_code(&format!("{subject}\n{head}"))
}

pub fn sign_in_code_decision(subject: &str, body: &str) -> SignInCode {
    if looks_like_one_time_code(subject, body) {
        return SignInCode::HandsOver;
    }
    if names_a_sign_in_code(&subject.to_lowercase()) {
        SignInCode::Unclear
    } else {
        SignInCode::Ordinary
    }
}
