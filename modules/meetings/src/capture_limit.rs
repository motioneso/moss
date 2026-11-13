//! Start budget for one account. At most 10 starts a minute and 60 an hour, counted over a
//! rolling window. Failed starts and replays still count.
use crate::capture_errors::Failure;
use chrono::{DateTime, Duration, Utc};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const PER_MINUTE: usize = 10;
const PER_HOUR: usize = 60;

/// The stored list of start times after adding `at`, or the delay until a start is allowed.
pub fn budget(previous: &[DateTime<Utc>], at: DateTime<Utc>) -> Result<Vec<DateTime<Utc>>, Failure> {
    let mut recent: Vec<DateTime<Utc>> =
        previous.iter().copied().filter(|t| *t > at - Duration::milliseconds(HOUR)).collect();
    recent.sort();
    let minute: Vec<&DateTime<Utc>> = recent.iter().filter(|t| **t > at - Duration::milliseconds(MINUTE)).collect();
    let mut blocked = 0i64;
    if minute.len() >= PER_MINUTE {
        blocked = blocked.max(minute[minute.len() - PER_MINUTE].timestamp_millis() + MINUTE);
    }
    if recent.len() >= PER_HOUR {
        blocked = blocked.max(recent[recent.len() - PER_HOUR].timestamp_millis() + HOUR);
    }
    let now = at.timestamp_millis();
    if blocked > now {
        return Err(Failure::rate_limited(((blocked - now + 999) / 1000).max(1) as u64));
    }
    recent.push(at);
    Ok(recent)
}
