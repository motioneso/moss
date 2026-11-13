//! Tidy of the written morning text. Models often ignore the clock-order and no-filler rules, so
//! this step puts timed sections in clock order, leaves News and Sports last and drops a section
//! that only restates an event title. It acts only when sure. Text with no `##` section is
//! returned as written.
use regex::Regex;

const FILLER: [&str; 29] = [
    "a", "an", "the", "is", "are", "has", "have", "been", "scheduled", "planned", "booked", "today", "this",
    "morning", "afternoon", "evening", "at", "on", "for", "you", "your", "there", "s", "and", "to", "from",
    "until", "am", "pm",
];

struct Patterns {
    time: Regex,
    range: Regex,
    time24: Regex,
    tail: Regex,
    digits: Regex,
    sentence_end: Regex,
    list_start: Regex,
}

fn patterns() -> Patterns {
    let re = |p: &str| Regex::new(p).expect("fixed pattern");
    Patterns {
        time: re(r"(?i)\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b"),
        range: re(r"(?i)\b(\d{1,2})(?::(\d{2}))?\s*[-\u{2013}\u{2014}]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b"),
        time24: re(r"\b([01]?\d|2[0-3]):([0-5]\d)\b"),
        tail: re(r"(?i)\b(news|sports?)\b"),
        digits: re(r"\d{1,2}(:\d{2})?"),
        sentence_end: re(r"[.!?](\s|$)"),
        list_start: re(r"^[-*]\s"),
    }
}

struct Part {
    heading: String,
    body: String,
    raw: String,
}

fn to_minutes(hour: u32, minute: u32, pm: bool) -> Option<u32> {
    if !(1..=12).contains(&hour) || minute > 59 {
        return None;
    }
    Some(((hour % 12) + if pm { 12 } else { 0 }) * 60 + minute)
}

fn num(text: Option<regex::Match<'_>>) -> u32 {
    text.and_then(|m| m.as_str().parse().ok()).unwrap_or(0)
}

fn minutes_of(p: &Patterns, part: &Part, clock24: bool) -> Option<u32> {
    let text = format!("{}\n{}", part.heading, part.body);
    let single = p.time.captures(&text);
    let range = p.range.captures(&text);
    if let Some(range) = &range {
        let start = range.get(0).map_or(0, |m| m.start());
        if single.as_ref().map_or(true, |s| start <= s.get(0).map_or(0, |m| m.start())) {
            let (start_hour, end_hour) = (num(range.get(1)), num(range.get(3)));
            let end_pm = range[5].eq_ignore_ascii_case("pm");
            let crosses = start_hour != 12 && (start_hour > end_hour || (end_hour == 12 && end_pm));
            let start_pm = if crosses { !end_pm } else { end_pm };
            return to_minutes(start_hour, num(range.get(2)), start_pm);
        }
    }
    match single {
        None => {
            if !clock24 {
                return None;
            }
            p.time24.captures(&text).map(|h| num(h.get(1)) * 60 + num(h.get(2)))
        }
        Some(single) => to_minutes(num(single.get(1)), num(single.get(2)), single[3].eq_ignore_ascii_case("pm")),
    }
}

fn only_restates_title(p: &Patterns, part: &Part, titles: &[String]) -> bool {
    let body = part.body.trim();
    if body.is_empty() || body.contains('\n') || p.list_start.is_match(body) {
        return false;
    }
    if p.sentence_end.find_iter(body).count() > 1 {
        return false;
    }
    let mut rest = body.to_lowercase();
    let mut matched = false;
    for title in titles {
        let needle = title.trim().to_lowercase();
        if !needle.is_empty() && rest.contains(&needle) {
            rest = rest.replace(&needle, " ");
            matched = true;
        }
    }
    if !matched {
        return false;
    }
    let rest = p.time.replace_all(&rest, " ");
    let rest = p.digits.replace_all(&rest, " ");
    rest.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).all(|w| FILLER.contains(&w))
}

pub fn tidy_morning_sections(text: &str, event_titles: &[String], clock24: bool) -> String {
    let p = patterns();
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(first) = lines.iter().position(|l| l.starts_with("## ")) else {
        return text.to_owned();
    };
    let preamble = lines[..first].join("\n");
    let mut parts: Vec<Part> = vec![];
    let mut current: Vec<&str> = vec![];
    let flush = |current: &mut Vec<&str>, parts: &mut Vec<Part>| {
        if current.is_empty() {
            return;
        }
        parts.push(Part {
            heading: current[0].to_owned(),
            body: current[1..].join("\n"),
            raw: current.join("\n").trim_end().to_owned(),
        });
        current.clear();
    };
    for line in &lines[first..] {
        if line.starts_with("## ") {
            flush(&mut current, &mut parts);
        }
        current.push(line);
    }
    flush(&mut current, &mut parts);

    let kept: Vec<Part> = parts.into_iter().filter(|s| !only_restates_title(&p, s, event_titles)).collect();
    let (tail, main): (Vec<Part>, Vec<Part>) = kept.into_iter().partition(|s| p.tail.is_match(&s.heading));
    let mut timed: Vec<(u32, usize)> = vec![];
    let mut untimed: Vec<usize> = vec![];
    for (i, s) in main.iter().enumerate() {
        match minutes_of(&p, s, clock24) {
            Some(at) => timed.push((at, i)),
            None => untimed.push(i),
        }
    }
    timed.sort();
    let order = timed.into_iter().map(|(_, i)| &main[i]).chain(untimed.into_iter().map(|i| &main[i])).chain(tail.iter());
    let ordered = order.map(|s| s.raw.as_str()).collect::<Vec<_>>().join("\n\n");
    if preamble.is_empty() {
        ordered
    } else {
        format!("{}\n\n{ordered}", preamble.trim_end())
    }
}
