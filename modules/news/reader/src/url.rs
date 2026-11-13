//! A small http(s) address parser that normalises the way the old code's `new URL(..)` did.
//!
//! Only `http` and `https` are accepted. Hosts are lower-cased, dotted numbers are folded to
//! IPv4, non-ASCII labels become punycode, default ports are dropped, dot segments are removed
//! and each part is percent-encoded with the standard sets. No network or file access.

const FORBIDDEN_HOST: &[char] = &[
    '\0', '\t', '\n', '\r', ' ', '#', '/', ':', '<', '>', '?', '@', '[', '\\', ']', '^', '|', '%',
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    pub href: String,
    pub https: bool,
    pub username: String,
    pub password: String,
    pub hostname: String,
    pub port: Option<u16>,
    pub pathname: String,
    /// Includes the leading `?`, or empty when the address has no query.
    pub search: String,
    /// Includes the leading `#`, or empty.
    pub hash: String,
}

impl Url {
    pub fn protocol(&self) -> &'static str {
        if self.https {
            "https:"
        } else {
            "http:"
        }
    }

    /// Parses an absolute http or https address. Anything else answers `None`.
    pub fn parse(input: &str) -> Option<Url> {
        parse(input)
    }

    /// Query keys in order, percent-decoded, as `URLSearchParams.keys()` returns them.
    pub fn search_param_keys(&self) -> Vec<String> {
        let query = self.search.strip_prefix('?').unwrap_or("");
        query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| {
                let key = pair.split('=').next().unwrap_or("");
                form_decode(key)
            })
            .collect()
    }
}

fn form_decode(text: &str) -> String {
    let plus = text.replace('+', " ");
    String::from_utf8_lossy(&percent_decode(&plus)).into_owned()
}

fn percent_decode(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone, Copy)]
enum Set {
    Userinfo,
    Path,
    Query,
    Fragment,
}

fn must_encode(set: Set, c: char) -> bool {
    if c.is_ascii_control() || !c.is_ascii() || c == ' ' || c == '"' || c == '<' || c == '>' {
        return true;
    }
    match set {
        Set::Fragment => c == '`',
        Set::Query => c == '#' || c == '\'',
        Set::Path => matches!(c, '#' | '?' | '`' | '{' | '}'),
        Set::Userinfo => matches!(
            c,
            '#' | '?' | '`' | '{' | '}' | '/' | ':' | ';' | '=' | '@' | '[' | '\\' | ']' | '^' | '|'
        ),
    }
}

fn encode(set: Set, text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if must_encode(set, c) {
            let mut buf = [0u8; 4];
            for byte in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse(input: &str) -> Option<Url> {
    let trimmed = input.trim_matches(|c: char| c <= ' ');
    let cleaned: String = trimmed
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let colon = cleaned.find(':')?;
    let scheme = &cleaned[..colon];
    let mut scheme_chars = scheme.chars();
    let first = scheme_chars.next()?;
    if !first.is_ascii_alphabetic()
        || !scheme_chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let https = match scheme.to_ascii_lowercase().as_str() {
        "https" => true,
        "http" => false,
        _ => return None,
    };
    let rest = cleaned[colon + 1..].trim_start_matches(['/', '\\']);
    let authority_end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);

    let (userinfo, hostport) = match authority.rfind('@') {
        Some(at) => (Some(&authority[..at]), &authority[at + 1..]),
        None => (None, authority),
    };
    let (username, password) = match userinfo {
        Some(info) => match info.find(':') {
            Some(c) => (
                encode(Set::Userinfo, &info[..c]),
                encode(Set::Userinfo, &info[c + 1..]),
            ),
            None => (encode(Set::Userinfo, info), String::new()),
        },
        None => (String::new(), String::new()),
    };

    let (host_text, port_text) = split_port(hostport);
    let port = match port_text {
        Some("") | None => None,
        Some(digits) => {
            if !digits.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let value: u32 = digits.trim_start_matches('0').parse().unwrap_or(0);
            if value > 65535 {
                return None;
            }
            let default = if https { 443 } else { 80 };
            if value == default {
                None
            } else {
                Some(value as u16)
            }
        }
    };
    let hostname = parse_host(host_text)?;

    let mut remainder = tail;
    let mut hash = String::new();
    if let Some(h) = remainder.find('#') {
        hash = format!("#{}", encode(Set::Fragment, &remainder[h + 1..]));
        remainder = &remainder[..h];
    }
    let mut search = String::new();
    if let Some(q) = remainder.find('?') {
        search = format!("?{}", encode(Set::Query, &remainder[q + 1..]));
        remainder = &remainder[..q];
    }
    let pathname = normalise_path(remainder);

    let mut href = String::from(if https { "https://" } else { "http://" });
    if !username.is_empty() || !password.is_empty() {
        href.push_str(&username);
        if !password.is_empty() {
            href.push(':');
            href.push_str(&password);
        }
        href.push('@');
    }
    href.push_str(&hostname);
    if let Some(p) = port {
        href.push(':');
        href.push_str(&p.to_string());
    }
    href.push_str(&pathname);
    href.push_str(&search);
    href.push_str(&hash);
    Some(Url {
        href,
        https,
        username,
        password,
        hostname,
        port,
        pathname,
        search,
        hash,
    })
}

fn split_port(hostport: &str) -> (&str, Option<&str>) {
    if hostport.starts_with('[') {
        return match hostport.find(']') {
            Some(close) => {
                let after = &hostport[close + 1..];
                (&hostport[..=close], after.strip_prefix(':'))
            }
            None => (hostport, None),
        };
    }
    match hostport.rfind(':') {
        Some(c) => (&hostport[..c], Some(&hostport[c + 1..])),
        None => (hostport, None),
    }
}

fn normalise_path(raw: &str) -> String {
    let unified = raw.replace('\\', "/");
    let mut segments: Vec<String> = Vec::new();
    let parts: Vec<&str> = unified.split('/').collect();
    // A leading slash produces an empty first part. Absent path means "/".
    let body = if parts.first() == Some(&"") { &parts[1..] } else { &parts[..] };
    let last_index = body.len().saturating_sub(1);
    for (index, part) in body.iter().enumerate() {
        let lower = part.to_ascii_lowercase();
        let is_double = matches!(lower.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e");
        let is_single = matches!(lower.as_str(), "." | "%2e");
        if is_double {
            segments.pop();
            if index == last_index {
                segments.push(String::new());
            }
        } else if is_single {
            if index == last_index {
                segments.push(String::new());
            }
        } else {
            segments.push(encode(Set::Path, part));
        }
    }
    let mut out = String::new();
    if segments.is_empty() {
        out.push('/');
    }
    for segment in segments {
        out.push('/');
        out.push_str(&segment);
    }
    out
}

fn parse_host(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if text.starts_with('[') {
        let inner = text.strip_prefix('[')?.strip_suffix(']')?;
        if inner.is_empty()
            || !inner
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        {
            return None;
        }
        return Some(format!("[{}]", inner.to_ascii_lowercase()));
    }
    let decoded = String::from_utf8(percent_decode(text)).ok()?;
    let lowered = decoded.to_lowercase();
    let ascii = to_ascii_host(&lowered)?;
    if ascii.is_empty() || ascii.chars().any(|c| FORBIDDEN_HOST.contains(&c) || c.is_ascii_control() || c == '\u{7f}') {
        return None;
    }
    if ends_in_number(&ascii) {
        return ipv4(&ascii);
    }
    Some(ascii)
}

fn to_ascii_host(host: &str) -> Option<String> {
    if host.is_ascii() {
        return Some(host.to_string());
    }
    let mut labels = Vec::new();
    for label in host.split('.') {
        if label.is_ascii() {
            labels.push(label.to_string());
        } else {
            labels.push(format!("xn--{}", punycode(label)?));
        }
    }
    Some(labels.join("."))
}

fn punycode(label: &str) -> Option<String> {
    const BASE: u32 = 36;
    const T_MIN: u32 = 1;
    const T_MAX: u32 = 26;
    const SKEW: u32 = 38;
    const DAMP: u32 = 700;
    let input: Vec<u32> = label.chars().map(|c| c as u32).collect();
    let mut output: String = label.chars().filter(|c| c.is_ascii()).collect();
    let basic = output.len() as u32;
    let mut handled = basic;
    if basic > 0 {
        output.push('-');
    }
    let (mut n, mut delta, mut bias) = (128u32, 0u32, 72u32);
    let digit = |d: u32| (if d < 26 { b'a' + d as u8 } else { b'0' + (d - 26) as u8 }) as char;
    let adapt = |mut delta: u32, count: u32, first: bool| {
        delta = if first { delta / DAMP } else { delta / 2 };
        delta += delta / count;
        let mut k = 0;
        while delta > ((BASE - T_MIN) * T_MAX) / 2 {
            delta /= BASE - T_MIN;
            k += BASE;
        }
        k + (BASE - T_MIN + 1) * delta / (delta + SKEW)
    };
    while (handled as usize) < input.len() {
        let m = *input.iter().filter(|&&c| c >= n).min()?;
        delta = delta.checked_add((m - n).checked_mul(handled + 1)?)?;
        n = m;
        for &c in &input {
            if c < n {
                delta = delta.checked_add(1)?;
            }
            if c == n {
                let mut q = delta;
                let mut k = BASE;
                loop {
                    let t = if k <= bias { T_MIN } else if k >= bias + T_MAX { T_MAX } else { k - bias };
                    if q < t {
                        break;
                    }
                    output.push(digit(t + (q - t) % (BASE - t)));
                    q = (q - t) / (BASE - t);
                    k += BASE;
                }
                output.push(digit(q));
                bias = adapt(delta, handled + 1, handled == basic);
                delta = 0;
                handled += 1;
            }
        }
        delta += 1;
        n += 1;
    }
    Some(output)
}

fn ends_in_number(host: &str) -> bool {
    let mut labels: Vec<&str> = host.split('.').collect();
    if labels.last() == Some(&"") {
        if labels.len() == 1 {
            return false;
        }
        labels.pop();
    }
    let last = labels.last().copied().unwrap_or("");
    if !last.is_empty() && last.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    parse_ipv4_number(last).is_some()
}

fn parse_ipv4_number(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    let (digits, radix) = if let Some(h) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
        (h, 16)
    } else if part.len() > 1 && part.starts_with('0') {
        (&part[1..], 8)
    } else {
        (part, 10)
    };
    if digits.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(digits, radix).ok()
}

fn ipv4(host: &str) -> Option<String> {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.last() == Some(&"") && parts.len() > 1 {
        parts.pop();
    }
    if parts.len() > 4 {
        return None;
    }
    let mut numbers = Vec::new();
    for part in &parts {
        numbers.push(parse_ipv4_number(part)?);
    }
    let last = numbers.pop()?;
    if numbers.iter().any(|&n| n > 255) {
        return None;
    }
    if last >= 256u64.pow((5 - parts.len()) as u32) {
        return None;
    }
    let mut value = last;
    for (i, n) in numbers.iter().enumerate() {
        value += n * 256u64.pow((3 - i) as u32);
    }
    Some(format!(
        "{}.{}.{}.{}",
        (value >> 24) & 255,
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255
    ))
}
