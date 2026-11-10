//! Preserve legacy millisecond UTC timestamps without parsing/formatting the
//! common PostgreSQL UTC representation through the general RFC3339 machinery.

pub(crate) fn normalize(text: &str) -> Option<String> {
    utc_millis(text).or_else(|| {
        chrono::DateTime::parse_from_rfc3339(text).ok().map(|time| {
            time.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
    })
}

fn utc_millis(text: &str) -> Option<String> {
    let body = text
        .strip_suffix("+00:00")
        .or_else(|| text.strip_suffix('Z'))?;
    let bytes = body.as_bytes();
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |start: usize, end: usize| {
        bytes[start..end].iter().try_fold(0u32, |n, digit| {
            digit
                .is_ascii_digit()
                .then(|| n * 10 + u32::from(digit - b'0'))
        })
    };
    // Validate dates and clock fields too: malformed input must retain the old
    // parser's refusal, rather than gaining a plausible-looking timestamp.
    chrono::NaiveDate::from_ymd_opt(number(0, 4)? as i32, number(5, 7)?, number(8, 10)?)?;
    if number(11, 13)? > 23 || number(14, 16)? > 59 || number(17, 19)? > 59 {
        return None;
    }
    let fraction = if bytes.len() == 19 {
        ""
    } else {
        if bytes[19] != b'.' || !(21..=29).contains(&bytes.len()) {
            return None;
        }
        let digits = &bytes[20..];
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        // Every byte is now known to be ASCII; these are UTF-8 boundaries.
        &body[20..body.len().min(23)]
    };
    let mut result = String::with_capacity(24);
    result.push_str(&body[..19]);
    result.push('.');
    result.push_str(fraction);
    for _ in fraction.len()..3 {
        result.push('0');
    }
    result.push('Z');
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn previous(text: &str) -> Option<String> {
        chrono::DateTime::parse_from_rfc3339(text).ok().map(|time| {
            time.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
    }

    #[test]
    fn utc_conversion_matches_previous_parser_at_calendar_and_fraction_boundaries() {
        for year in [0, 1, 1900, 2000, 2020, 9999] {
            for month in 0..=13 {
                for day in [0, 1, 28, 29, 30, 31, 32] {
                    for fraction in ["", ".1", ".12", ".123", ".123456", ".999999999"] {
                        for suffix in ["Z", "+00:00"] {
                            let text =
                                format!("{year:04}-{month:02}-{day:02}T23:59:59{fraction}{suffix}");
                            assert_eq!(normalize(&text), previous(&text), "{text}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn other_forms_keep_previous_parser_behavior() {
        for text in [
            "2020-01-01T00:00:00+05:30",
            "2020-01-01T00:00:00-07:00",
            "2020-01-01t00:00:00z",
            "2020-01-01 00:00:00+00:00",
            "+10000-01-01T00:00:00Z",
            "2016-12-31T23:59:60Z",
            "2020-01-01T24:00:00Z",
            "2020-01-01T00:60:00Z",
            "2020-01-01T00:00:00.Z",
            "2020-01-01T00:00:00.1234567891Z",
            "2020-01-01T00:00:00.éZ",
            "２０２０-01-01T00:00:00Z",
            "2020-01-01T00:00:00-00:00",
            "infinity",
            "",
            "Z",
        ] {
            assert_eq!(normalize(text), previous(text), "{text}");
        }
    }
}
