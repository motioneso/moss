//! Helpers that reproduce JavaScript string behaviour the old code relied on.

/// `String.prototype.length`: UTF-16 code units.
pub fn len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `String.prototype.trim`: white space plus line terminators plus the byte order mark.
pub fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `slice(0, max)` that never splits a character.
pub fn slice(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

/// Code-unit ordering, as `Array.prototype.sort` compares keys.
pub fn cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `encodeURIComponent` (`all` true) or `encodeURI` (`all` false).
pub fn encode_uri(text: &str, component: bool) -> String {
    let keep = |b: u8| {
        b.is_ascii_alphanumeric()
            || b"-_.!~*'()".contains(&b)
            || (!component && b";,/?:@&=+$#".contains(&b))
    };
    let mut out = String::new();
    for b in text.bytes() {
        if keep(b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `Date.parse` for the UTC ISO timestamps this module writes. Milliseconds since the epoch.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |s: usize, e: usize| text.get(s..e)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut ms = 0;
    let mut rest = 19;
    if b[19] == b'.' {
        let end = (20..b.len()).find(|&i| !b[i].is_ascii_digit())?;
        let digits = &text[20..end];
        ms = format!("{:0<3}", &digits[..digits.len().min(3)]).parse::<i64>().ok()?;
        rest = end;
    }
    if &text[rest..] != "Z" || !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}
