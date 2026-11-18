use axum::http::{HeaderMap, Method};
use moss_network::policy::Policy;

fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("host", host.parse().unwrap());
    if let Some(o) = origin {
        h.insert("origin", o.parse().unwrap());
    }
    h
}

#[test]
fn wrong_host_is_refused_even_on_loopback() {
    let p = Policy::new(&["https://localhost:5180"], false).unwrap();
    assert_eq!(
        p.check(
            &headers("rebind.example:5180", None),
            &Method::GET,
            "127.0.0.1".parse().unwrap()
        ),
        Err(421)
    );
}

#[test]
fn wrong_and_missing_origins_are_refused() {
    let p = Policy::new(&["https://localhost:5180"], false).unwrap();
    for o in [Some("https://evil.example"), Some("null"), None] {
        assert_eq!(
            p.check(
                &headers("localhost:5180", o),
                &Method::POST,
                "127.0.0.1".parse().unwrap()
            ),
            Err(403)
        );
    }
}

#[test]
fn sharing_starts_off_for_remote_peers_and_authorities() {
    let p = Policy::new(
        &["https://localhost:5180", "https://moss.example:5180"],
        false,
    )
    .unwrap();
    assert_eq!(
        p.check(
            &headers("moss.example:5180", None),
            &Method::GET,
            "127.0.0.1".parse().unwrap()
        ),
        Err(403)
    );
    assert_eq!(
        p.check(
            &headers("localhost:5180", None),
            &Method::GET,
            "192.0.2.1".parse().unwrap()
        ),
        Err(403)
    );
}

#[test]
fn exact_origins_duplicate_headers_and_live_sharing_switch() {
    let p = Policy::new(
        &["https://localhost:5180", "https://moss.example:5180"],
        true,
    )
    .unwrap();
    let peer = "192.0.2.1".parse().unwrap();
    assert!(p
        .check(
            &headers("moss.example:5180", Some("https://moss.example:5180")),
            &Method::POST,
            peer
        )
        .is_ok());
    assert_eq!(
        p.check(
            &headers("moss.example:5180", Some("https://localhost:5180")),
            &Method::POST,
            peer
        ),
        Err(403)
    );
    let mut duplicate = headers("moss.example:5180", None);
    duplicate.append("host", "moss.example:5180".parse().unwrap());
    assert_eq!(p.check(&duplicate, &Method::GET, peer), Err(421));
    let mut duplicate = headers("moss.example:5180", Some("https://moss.example:5180"));
    duplicate.append("origin", "https://moss.example:5180".parse().unwrap());
    assert_eq!(p.check(&duplicate, &Method::POST, peer), Err(403));
    p.set_sharing(false);
    assert_eq!(
        p.check(&headers("moss.example:5180", None), &Method::GET, peer),
        Err(403)
    );
    assert!(p
        .check(
            &headers("localhost:5180", None),
            &Method::GET,
            "::ffff:127.0.0.1".parse().unwrap()
        )
        .is_ok());
}

#[test]
fn trust_list_cannot_use_wildcards_paths_credentials_or_plaintext() {
    for origin in [
        "http://localhost:5180",
        "https://*.example",
        "https://example.com/path",
        "https://user:password@example.com",
        "https://example.com?x=1",
        "https://example.com#fragment",
        "https://example.com./",
    ] {
        assert!(Policy::new(&[origin], false).is_err(), "accepted {origin}");
    }
}
