//! Which backups to keep: the newest of each of the last 7 days with a backup, the newest of
//! each of the last 4 weeks with a backup, every pinned backup, and the newest verified one.

use std::collections::BTreeSet;

pub const DAILY: usize = 7;
pub const WEEKLY: usize = 4;

pub struct Candidate<'a> {
    pub id: &'a str,
    pub created_at: u64,
    pub pinned: bool,
    pub verified: bool,
}

/// Monday-based week number. Day 0 (1970-01-01) was a Thursday.
fn week(created_at: u64) -> u64 {
    (created_at / 86_400 + 3) / 7
}

/// The ids to keep. Everything else may be deleted.
pub fn keep(candidates: &[Candidate]) -> BTreeSet<String> {
    let mut order: Vec<&Candidate> = candidates.iter().collect();
    order.sort_by(|a, b| (b.created_at, b.id).cmp(&(a.created_at, a.id)));
    let mut kept = BTreeSet::new();
    let mut days = Vec::new();
    let mut weeks = Vec::new();
    for candidate in &order {
        let day = candidate.created_at / 86_400;
        if !days.contains(&day) && days.len() < DAILY {
            days.push(day);
            kept.insert(candidate.id.to_owned());
        }
        let week = week(candidate.created_at);
        if !weeks.contains(&week) && weeks.len() < WEEKLY {
            weeks.push(week);
            kept.insert(candidate.id.to_owned());
        }
        if candidate.pinned {
            kept.insert(candidate.id.to_owned());
        }
    }
    if let Some(newest_verified) = order.iter().find(|c| c.verified) {
        kept.insert(newest_verified.id.to_owned());
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400;
    // A Monday.
    const START: u64 = 20_783 * DAY - 3 * DAY;

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("b{i:03}")).collect()
    }

    #[test]
    fn seven_daily_four_weekly_pinned_and_last_verified() {
        // One backup a day for 60 days, two on the newest day.
        let names = ids(62);
        let mut list: Vec<Candidate> = (0..61)
            .map(|i| Candidate {
                id: &names[i],
                created_at: START + i as u64 * DAY + 3600,
                pinned: false,
                verified: false,
            })
            .collect();
        list.push(Candidate {
            id: &names[61],
            created_at: START + 60 * DAY + 7200,
            pinned: false,
            verified: false,
        });
        list[3].pinned = true;
        list[10].verified = true;
        let kept = keep(&list);
        // Newest of the last 7 days: days 54..=60, with day 60 kept once (its later backup).
        for i in 54..60 {
            assert!(kept.contains(&names[i]), "day {i}");
        }
        assert!(kept.contains(&names[61]));
        assert!(
            !kept.contains(&names[60]),
            "the older of two on one day goes"
        );
        assert!(kept.contains(&names[3]), "pinned stays");
        assert!(kept.contains(&names[10]), "the only verified backup stays");
        // Weekly: the newest of each of the last 4 weeks. Day 60 is in week 8 (Monday start),
        // so the week ends at days 55, 48 and 41 are kept too.
        assert!(kept.contains(&names[48]));
        assert!(kept.contains(&names[41]));
        assert!(!kept.contains(&names[34]));
        assert!(!kept.contains(&names[20]));
        assert_eq!(kept.len(), 7 + 2 + 2);
    }

    #[test]
    fn newest_verified_survives_even_when_old() {
        let names = ids(20);
        let list: Vec<Candidate> = (0..20)
            .map(|i| Candidate {
                id: &names[i],
                created_at: START + i as u64 * 8 * DAY,
                pinned: false,
                verified: i == 0,
            })
            .collect();
        let kept = keep(&list);
        assert!(kept.contains(&names[0]));
        assert!(!kept.contains(&names[1]));
    }
}
