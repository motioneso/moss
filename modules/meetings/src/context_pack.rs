//! Background about the owner that helps the model read names and topics in a recording.
//! It comes from Calendar and People through their public APIs, never from their tables.
//! A source that fails counts as empty, so the pack can never fail a summary.
use chrono::{DateTime, Duration};
use moss_module_sdk::{Client, Host};
use serde::Serialize;
use serde_json::{json, Value};

const MAX_NAMES: usize = 30;
const MAX_NAME: usize = 80;
const MAX_TITLE: usize = 240;
const CAP_OWNER: usize = 1024;
const CAP_CALENDAR: usize = 4096;
const CAP_PEOPLE: usize = 6144;
const CAP_MEMORY: usize = 6144;
/// How far an event may sit outside the recording and still count as the same meeting.
const TOLERANCE_MINUTES: i64 = 15;

const STOPWORDS: &str = "I,The,A,An,And,But,So,Or,If,It,We,You,They,He,She,This,That,Then,Yeah,Yes,No,Okay,Ok,Well,Right,Also,Just,Now,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday,January,February,March,April,May,June,July,August,September,October,November,December";

fn stopword(word: &str) -> bool {
    STOPWORDS.split(',').any(|w| w == word)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub display_name: String,
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub attendee_names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub role: Option<String>,
    pub note: Option<String>,
    pub matched_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Fact {
    pub query: String,
    pub text: String,
}

/// Field order is the order the model sees.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Pack {
    pub owner: Owner,
    pub event: Option<Event>,
    pub people: Vec<Person>,
    pub facts: Vec<Fact>,
}

fn bytes<T: Serialize>(value: &T) -> usize {
    serde_json::to_string(value).map_or(0, |s| s.len())
}

fn cut(text: &str, max: usize) -> String {
    // JavaScript counts UTF-16 units, so a cut keeps whole characters up to that count.
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

/// Capitalised names heard in the talk, in first-seen order. Plain string work, no model call.
pub fn extract_names(texts: &[&str]) -> Vec<String> {
    let mut seen: Vec<String> = vec![];
    let mut names: Vec<String> = vec![];
    for text in texts {
        let chars: Vec<char> = text.chars().collect();
        let mut at = 0;
        while at < chars.len() {
            let Some((end, words)) = name_at(&chars, at) else {
                at += 1;
                continue;
            };
            let count = words.len();
            let mut words = words;
            while !words.is_empty() && stopword(&words[0]) {
                words.remove(0);
            }
            let start = at;
            at = end;
            if words.is_empty() {
                continue;
            }
            let name = words.join(" ");
            let single = words.len() == 1;
            if single && stopword(&name) {
                continue;
            }
            let before: String = chars[..start].iter().collect();
            let before = before.trim_end();
            let sentence_start = before.is_empty() || before.ends_with(['.', '!', '?']);
            if single && sentence_start && words.len() == count {
                continue;
            }
            let key = name.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            names.push(name);
            if names.len() >= MAX_NAMES {
                return names;
            }
        }
    }
    names
}

/// One match of `[A-Z][a-z]+(?:[ \t][A-Z][a-z]+){0,2}` starting exactly at `at`.
fn name_at(chars: &[char], at: usize) -> Option<(usize, Vec<String>)> {
    let word = |from: usize| -> Option<usize> {
        if !chars.get(from)?.is_ascii_uppercase() {
            return None;
        }
        let mut end = from + 1;
        while chars.get(end).is_some_and(char::is_ascii_lowercase) {
            end += 1;
        }
        (end > from + 1).then_some(end)
    };
    let mut end = word(at)?;
    let mut words = vec![chars[at..end].iter().collect::<String>()];
    while words.len() < 3 {
        if !chars.get(end).is_some_and(|c| *c == ' ' || *c == '\t') {
            break;
        }
        let Some(next) = word(end + 1) else { break };
        words.push(chars[end + 1..next].iter().collect());
        end = next;
    }
    Some((end, words))
}

fn drop_last_until<T: Serialize>(mut items: Vec<T>, cap: usize) -> Vec<T> {
    while !items.is_empty() && bytes(&items) > cap {
        items.pop();
    }
    items
}

/// Applies each source's own size cap. Reports whether anything was dropped.
fn cap_sources(pack: Pack) -> (Pack, bool) {
    let before = (pack.event.as_ref().map(|e| e.attendee_names.len()), pack.people.len(), pack.facts.len());
    let had_event = pack.event.is_some();
    let event = pack.event.and_then(|mut e| {
        e.attendee_names = drop_last_until(e.attendee_names, CAP_CALENDAR - 512);
        e.title = cut(&e.title, MAX_TITLE);
        (bytes(&e) <= CAP_CALENDAR).then_some(e)
    });
    let people = drop_last_until(pack.people, CAP_PEOPLE);
    let facts = drop_last_until(pack.facts, CAP_MEMORY);
    let trimmed = event.as_ref().map(|e| e.attendee_names.len()) != before.0
        || (had_event && event.is_none())
        || people.len() != before.1
        || facts.len() != before.2;
    (Pack { owner: pack.owner, event, people, facts }, trimmed)
}

/// Drops items until the pack fits: facts first, then people, then the event, last item first.
/// `None` means even the owner entry does not fit.
pub fn fit(pack: Pack, budget: usize) -> (Option<Pack>, bool) {
    if bytes(&pack) <= budget {
        return (Some(pack), false);
    }
    let mut pack = pack;
    while bytes(&pack) > budget && !pack.facts.is_empty() {
        pack.facts.pop();
    }
    while bytes(&pack) > budget && !pack.people.is_empty() {
        pack.people.pop();
    }
    if bytes(&pack) > budget {
        pack.event = None;
    }
    if bytes(&pack) > budget {
        return (None, true);
    }
    (Some(pack), true)
}

/// Where the pack reads from. Tests script it. In the package it is the public API of each module.
pub trait Sources {
    fn owner(&self) -> Option<Owner>;
    fn events(&self) -> Vec<Value>;
    fn people(&self, names: &[String]) -> Vec<Value>;
    fn memory(&self, queries: &[String]) -> Vec<Fact>;
}

/// Reads through Calendar's and People's public APIs. Memory has no lookup API yet, so it adds
/// no facts, and the host gives no owner name, so the owner entry stays blank.
pub struct HostSources<'a, H: Host + ?Sized>(pub &'a H);
impl<H: Host + ?Sized> Sources for HostSources<'_, H> {
    fn owner(&self) -> Option<Owner> {
        None
    }
    fn events(&self) -> Vec<Value> {
        let reply = Client(self.0).api("calendar", "listEvents", json!({}));
        reply.ok().and_then(|r| r["events"].as_array().cloned()).unwrap_or_default()
    }
    fn people(&self, names: &[String]) -> Vec<Value> {
        let reply = Client(self.0).api("people", "findPeopleByNames", json!({"names": names}));
        reply.ok().and_then(|r| r.as_array().cloned()).unwrap_or_default()
    }
    fn memory(&self, _: &[String]) -> Vec<Fact> {
        vec![]
    }
}

fn event_of(row: &Value) -> Option<Event> {
    let names = row["attendeeNames"]
        .as_array()
        .map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    Some(Event {
        event_id: row["id"].as_str()?.to_owned(),
        title: row["title"].as_str()?.to_owned(),
        starts_at: row["startsAt"].as_str()?.to_owned(),
        ends_at: row["endsAt"].as_str()?.to_owned(),
        attendee_names: names,
    })
}

/// Events that overlap the recording start, give or take the tolerance.
fn overlapping(rows: &[Value], at: &str) -> Vec<Event> {
    let Ok(at) = DateTime::parse_from_rfc3339(at) else { return vec![] };
    let tolerance = Duration::minutes(TOLERANCE_MINUTES);
    rows.iter()
        .filter_map(event_of)
        .filter(|e| {
            let (Ok(start), Ok(end)) = (DateTime::parse_from_rfc3339(&e.starts_at), DateTime::parse_from_rfc3339(&e.ends_at)) else {
                return false;
            };
            end > at - tolerance && start < at + tolerance
        })
        .collect()
}

/// The owner context for one recording, or `None` when every source came back empty.
pub fn build(sources: &dyn Sources, transcript_names: &[String], recorded_at: Option<&str>) -> Option<Pack> {
    let profile = sources.owner().unwrap_or(Owner { display_name: String::new(), aliases: vec![] });
    let full: Vec<String> = profile.aliases.iter().take(5).map(|a| cut(a, MAX_NAME)).collect();
    let display_name = cut(&profile.display_name, MAX_NAME);
    let aliases = drop_last_until(full, CAP_OWNER.saturating_sub(bytes(&display_name)).saturating_sub(64));
    let owner = Owner { display_name, aliases };
    let found = recorded_at.map(|at| overlapping(&sources.events(), at)).unwrap_or_default();
    let event = if found.len() == 1 { found.into_iter().next() } else { None };
    let event = event.map(|mut e| {
        e.title = cut(&e.title, MAX_TITLE);
        e
    });
    let mut names: Vec<String> = vec![];
    let attendees = event.iter().flat_map(|e| e.attendee_names.iter());
    for name in attendees.chain(transcript_names.iter()) {
        let clean = cut(name.trim(), MAX_NAME);
        if clean.is_empty() || names.iter().any(|n| n.to_lowercase() == clean.to_lowercase()) {
            continue;
        }
        names.push(clean);
        if names.len() >= MAX_NAMES {
            break;
        }
    }
    let people: Vec<Person> = if names.is_empty() {
        vec![]
    } else {
        sources
            .people(&names)
            .iter()
            .filter_map(|p| {
                Some(Person {
                    name: p["name"].as_str()?.to_owned(),
                    role: p["role"].as_str().map(str::to_owned),
                    note: p["note"].as_str().map(str::to_owned),
                    matched_name: p["matchedName"].as_str()?.to_owned(),
                })
            })
            .collect()
    };
    let queries: Vec<String> = event.iter().map(|e| e.title.clone()).chain(names.iter().cloned()).collect();
    let facts = if queries.is_empty() { vec![] } else { sources.memory(&queries) };
    let (pack, _) = cap_sources(Pack { owner, event, people, facts });
    let empty = pack.owner.display_name.is_empty() && pack.event.is_none() && pack.people.is_empty() && pack.facts.is_empty();
    (!empty).then_some(pack)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_names_and_skips_sentence_starters_and_stopwords() {
        let names = extract_names(&["Yesterday I met Jamie Lee and Priya. Monday works. Then Sam Okafor agreed."]);
        assert_eq!(names, vec!["Jamie Lee", "Priya", "Sam Okafor"]);
        assert_eq!(extract_names(&["Alice spoke."]), Vec::<String>::new());
        assert_eq!(extract_names(&["we saw alice"]), Vec::<String>::new());
    }

    #[test]
    fn caps_the_name_list_at_thirty() {
        let text: String = (0..40u8).map(|i| format!("and Xx{} ", (b'a' + i % 26) as char)).collect();
        assert!(extract_names(&[&text]).len() <= MAX_NAMES);
    }

    fn pack(facts: usize) -> Pack {
        Pack {
            owner: Owner { display_name: "Me".into(), aliases: vec![] },
            event: Some(Event {
                event_id: "e".into(),
                title: "Standup".into(),
                starts_at: "2026-01-01T10:00:00Z".into(),
                ends_at: "2026-01-01T11:00:00Z".into(),
                attendee_names: vec![],
            }),
            people: vec![Person { name: "Jo".into(), role: None, note: None, matched_name: "Jo".into() }],
            facts: (0..facts).map(|i| Fact { query: "q".into(), text: format!("fact {i}") }).collect(),
        }
    }

    #[test]
    fn fit_drops_facts_then_people_then_the_event() {
        let full = bytes(&pack(5));
        assert!(fit(pack(5), full).1 == false);
        let (kept, trimmed) = fit(pack(5), bytes(&pack(0)) );
        let kept = kept.unwrap();
        assert!(trimmed && kept.facts.is_empty() && !kept.people.is_empty());
        let mut owner_only = pack(0);
        owner_only.people.clear();
        owner_only.event = None;
        let (kept, _) = fit(pack(5), bytes(&owner_only));
        let kept = kept.unwrap();
        assert!(kept.facts.is_empty() && kept.people.is_empty() && kept.event.is_none());
        assert!(fit(pack(5), 3).0.is_none());
    }

    struct Fixed(Vec<Value>, Vec<Value>);
    impl Sources for Fixed {
        fn owner(&self) -> Option<Owner> {
            Some(Owner { display_name: "Ben Love".into(), aliases: vec!["Ben".into()] })
        }
        fn events(&self) -> Vec<Value> {
            self.0.clone()
        }
        fn people(&self, _: &[String]) -> Vec<Value> {
            self.1.clone()
        }
        fn memory(&self, queries: &[String]) -> Vec<Fact> {
            queries.iter().take(1).map(|q| Fact { query: q.clone(), text: "Saved fact".into() }).collect()
        }
    }

    fn event(id: &str, start: &str, end: &str) -> Value {
        json!({"id": id, "title": "Budget review", "startsAt": start, "endsAt": end})
    }

    #[test]
    fn one_matching_event_is_used_and_two_are_not() {
        let near = event("a", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z");
        let far = event("b", "2026-01-02T10:00:00Z", "2026-01-02T11:00:00Z");
        let people = vec![json!({"name":"Priya Rao","role":"Finance","note":null,"matchedName":"Priya"})];
        let sources = Fixed(vec![near.clone(), far], people.clone());
        let built = build(&sources, &["Priya".into()], Some("2026-01-01T10:05:00Z")).unwrap();
        assert_eq!(built.event.as_ref().map(|e| e.event_id.as_str()), Some("a"));
        assert_eq!(built.people[0].name, "Priya Rao");
        assert_eq!(built.facts.len(), 1);
        let twice = Fixed(vec![near.clone(), event("c", "2026-01-01T10:30:00Z", "2026-01-01T11:30:00Z")], people);
        assert!(build(&twice, &[], Some("2026-01-01T10:35:00Z")).unwrap().event.is_none());
        let outside = Fixed(vec![near], vec![]);
        assert!(build(&outside, &[], Some("2026-01-01T11:16:00Z")).unwrap().event.is_none());
    }
}
