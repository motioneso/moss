//! Certificate pin helpers shared by every platform's web view.

const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encodes one DER certificate as PEM.
pub fn pem(der: &[u8]) -> String {
    let mut encoded = String::new();
    for chunk in der.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                encoded.push(CHARS[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                encoded.push('=');
            }
        }
    }
    let body: Vec<&str> = encoded
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).expect("base64 is ascii"))
        .collect();
    format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        body.join("\n")
    )
}

/// Decodes the first certificate in a PEM block. Returns `None` for anything malformed.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub fn der_from_pem(text: &str) -> Option<Vec<u8>> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let start = text.find(BEGIN)? + BEGIN.len();
    let end = start + text[start..].find(END)?;
    let mut out = Vec::new();
    let (mut bits, mut have) = (0u32, 0u32);
    let mut padding = 0;
    for byte in text[start..end]
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
    {
        if byte == b'=' {
            padding += 1;
            continue;
        }
        if padding > 0 {
            return None;
        }
        let value = CHARS.iter().position(|c| *c == byte)? as u32;
        bits = (bits << 6) | value;
        have += 6;
        if have >= 8 {
            have -= 8;
            out.push((bits >> have) as u8);
            bits &= (1 << have) - 1;
        }
    }
    (padding <= 2 && !out.is_empty()).then_some(out)
}

/// The host part of an origin, without IPv6 brackets.
#[cfg_attr(
    not(any(target_os = "linux", target_os = "macos", test)),
    allow(dead_code)
)]
pub fn host_of(origin: &str) -> Option<String> {
    url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_matches(['[', ']']).to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pem_round_trips_through_the_decoder() {
        for len in [1usize, 2, 3, 4, 31, 32, 33, 300] {
            let der: Vec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
            assert_eq!(
                der_from_pem(&pem(&der)).as_deref(),
                Some(der.as_slice()),
                "{len}"
            );
        }
    }

    #[test]
    fn malformed_pem_is_refused() {
        assert_eq!(der_from_pem(""), None);
        assert_eq!(
            der_from_pem("-----BEGIN CERTIFICATE-----\n!!\n-----END CERTIFICATE-----"),
            None
        );
        assert_eq!(
            der_from_pem("-----BEGIN CERTIFICATE-----\nAA==AA\n-----END CERTIFICATE-----"),
            None
        );
        assert_eq!(der_from_pem("-----BEGIN CERTIFICATE-----\nAAAA"), None);
    }

    #[test]
    fn hosts_lose_ipv6_brackets() {
        assert_eq!(host_of("https://[::1]:5201").as_deref(), Some("::1"));
        assert_eq!(
            host_of("https://192.168.1.20:5201").as_deref(),
            Some("192.168.1.20")
        );
    }
}
