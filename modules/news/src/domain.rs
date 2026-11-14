//! Publisher domain rules. They follow the old normalizer, which read the input with the
//! browser URL parser. This reads the same forms without that parser, and answers
//! `invalid_label` for any host name with a non-ASCII character, where the old code turned it
//! into punycode and accepted it.

const MAX_INPUT: usize = 2048;
const MAX_HOST: usize = 253;

/// The domain, or the reason the input was refused.
pub fn normalize(input: &str) -> Result<String, &'static str> {
    let trimmed = crate::util::js_trim(input);
    if trimmed.is_empty() {
        return Err("empty");
    }
    // The old check counted UTF-16 units.
    if trimmed.encode_utf16().count() > MAX_INPUT {
        return Err("input_too_long");
    }
    // The URL parser drops tabs and line breaks anywhere in the input.
    let cleaned: String = trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let (scheme, rest) = match split_scheme(&cleaned) {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest.to_owned()),
        None => ("https".to_owned(), cleaned.clone()),
    };
    let special = ["http", "https", "ftp", "ws", "wss", "file"].contains(&scheme.as_str());
    if scheme != "https" {
        // A special scheme with no host does not parse at all.
        if special && scheme != "file" && authority(&rest).is_none_or(|a| a.is_empty()) {
            return Err("unparseable");
        }
        return Err("non_https_scheme");
    }
    let authority = authority(&rest).ok_or("unparseable")?;
    let (userinfo, hostport) = match authority.rfind('@') {
        Some(at) => (&authority[..at], &authority[at + 1..]),
        None => ("", authority),
    };
    let (host, port) = split_port(hostport)?;
    if host.is_empty() {
        return Err("unparseable");
    }
    let mut port_number = None;
    if let Some(port) = port.filter(|p| !p.is_empty()) {
        if !port.bytes().all(|b| b.is_ascii_digit()) {
            return Err("unparseable");
        }
        match port.trim_start_matches('0').parse::<u32>().unwrap_or(0) {
            p if p > 65535 => return Err("unparseable"),
            p => port_number = Some(p),
        }
    }
    // Everything above is what the old URL parser refused outright. The checks below are the
    // old normalizer's own, in its order.
    let address = if host.starts_with('[') {
        if !host.ends_with(']') {
            return Err("unparseable");
        }
        true
    } else {
        false
    };
    let host = if address {
        host.to_owned()
    } else {
        let decoded = percent_decode(host).ok_or("unparseable")?.to_ascii_lowercase();
        if decoded.chars().any(|c| " #%/:<>?@[\\]^|".contains(c) || c.is_control()) {
            return Err("unparseable");
        }
        if ends_in_number(&decoded) && !ipv4(&decoded) {
            return Err("unparseable");
        }
        decoded
    };
    if !userinfo.is_empty() {
        return Err("credentials");
    }
    if port_number.is_some_and(|p| p != 443) {
        return Err("explicit_port");
    }
    if address || ends_in_number(&host) {
        return Err("ip_literal");
    }
    let host = host.strip_suffix('.').unwrap_or(&host).to_owned();
    if host.len() > MAX_HOST {
        return Err("hostname_too_long");
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return Err("single_label");
    }
    if !labels.iter().all(|l| dns_label(l)) {
        return Err("invalid_label");
    }
    Ok(host)
}

/// `^[a-zA-Z][a-zA-Z0-9+.-]*:` and what follows it.
fn split_scheme(text: &str) -> Option<(&str, &str)> {
    let bytes = text.as_bytes();
    if !bytes.first()?.is_ascii_alphabetic() {
        return None;
    }
    let end = bytes.iter().position(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')))?;
    (bytes[end] == b':').then(|| (&text[..end], &text[end + 1..]))
}

/// The authority of a special URL: leading slashes are skipped, and it ends at a path, query or
/// fragment mark. A bare `scheme:host` with no slashes still reads as a host.
fn authority(rest: &str) -> Option<&str> {
    let rest = rest.trim_start_matches(['/', '\\']);
    let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    Some(&rest[..end])
}

fn split_port(hostport: &str) -> Result<(&str, Option<&str>), &'static str> {
    if hostport.starts_with('[') {
        return match hostport.find(']') {
            Some(close) => {
                let after = &hostport[close + 1..];
                match after.strip_prefix(':') {
                    Some(port) => Ok((&hostport[..=close], Some(port))),
                    None if after.is_empty() => Ok((hostport, None)),
                    None => Err("unparseable"),
                }
            }
            None => Ok((hostport, None)),
        };
    }
    Ok(match hostport.rfind(':') {
        Some(colon) => (&hostport[..colon], Some(&hostport[colon + 1..])),
        None => (hostport, None),
    })
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The URL parser reads a host whose last label is a number as an IPv4 address.
fn ends_in_number(host: &str) -> bool {
    let trimmed = host.strip_suffix('.').unwrap_or(host);
    let last = trimmed.rsplit('.').next().unwrap_or("");
    !last.is_empty() && (last.bytes().all(|b| b.is_ascii_digit()) || hex_number(last).is_some())
}

fn hex_number(part: &str) -> Option<&str> {
    let digits = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X"))?;
    digits.bytes().all(|b| b.is_ascii_hexdigit()).then_some(digits)
}

fn ipv4_part(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    if let Some(digits) = hex_number(part) {
        return if digits.is_empty() { Some(0) } else { u64::from_str_radix(digits, 16).ok() };
    }
    if part.len() > 1 && part.starts_with('0') {
        return u64::from_str_radix(&part[1..], 8).ok();
    }
    part.parse().ok()
}

fn ipv4(host: &str) -> bool {
    let trimmed = host.strip_suffix('.').unwrap_or(host);
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.len() > 4 {
        return false;
    }
    let Some(numbers) = parts.iter().map(|p| ipv4_part(p)).collect::<Option<Vec<u64>>>() else {
        return false;
    };
    let (last, head) = numbers.split_last().unwrap();
    head.iter().all(|n| *n <= 255) && *last < 256u64.pow(5 - parts.len() as u32)
}

/// `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`
fn dns_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    let plain = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes.first().is_some_and(plain)
        && bytes.last().is_some_and(plain)
        && bytes.iter().all(|b| plain(b) || *b == b'-')
}

/// A domain equals the other, or is a sub-domain of it.
pub fn matches(excluded: &str, candidate: &str) -> bool {
    candidate == excluded || candidate.ends_with(&format!(".{excluded}"))
}

/// The lowercase host of an https address, or none.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#', '\\']).next()?;
    let hostport = authority.rsplit('@').next()?;
    let host = match hostport.rfind(':') {
        Some(colon) if !hostport.ends_with(']') => &hostport[..colon],
        _ => hostport,
    };
    let host = host.to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// A feed served from a host that is not the publisher itself (a mirror or a bridge).
pub fn is_workaround(canonical_domain: &str, feed_url: Option<&str>) -> bool {
    let Some(feed_host) = feed_url.and_then(host_of) else {
        return false;
    };
    let publisher = canonical_domain.to_ascii_lowercase();
    !(matches(&publisher, &feed_host) || matches(&feed_host, &publisher))
}
