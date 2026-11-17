//! Publisher identity: the registrable domain of a host, using the compiled-in public suffix
//! list (private suffixes included). Two hosts of one publisher share an identity.

fn is_ip_literal(host: &str) -> bool {
    if host.starts_with('[') || host.contains(':') {
        return true;
    }
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

/// The registrable domain of `hostname`, or `None` for an address, a bare suffix or a single label.
pub fn publisher_identity(hostname: &str) -> Option<String> {
    let host = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || is_ip_literal(&host) {
        return None;
    }
    let domain = psl::domain(host.as_bytes())?;
    std::str::from_utf8(domain.as_bytes()).ok().map(str::to_string)
}

pub fn same_publisher(left: &str, right: &str) -> bool {
    match publisher_identity(left) {
        Some(identity) => Some(identity) == publisher_identity(right),
        None => false,
    }
}
