//! Which web pages may sign up, sign in and sign out.
//!
//! This is better-auth's origin check and sign-in CSRF check, over the trusted list that
//! `resolveAuthOriginConfig` builds. A browser on a phone or another computer signs in only
//! from an address on that list, so remote access needs `JARVIS_AUTH_TRUSTED_ORIGINS` or
//! `JARVIS_AUTH_BASE_URL`. A client that sends neither a cookie nor fetch metadata, such as a
//! script, is not a browser page and goes through. Test mode turns both checks off, as
//! better-auth does.

use axum::http::header::{COOKIE, ORIGIN, REFERER};
use axum::http::HeaderMap;
use portability::secrets::{resolve_moss_env, Env};
use serde_json::json;
use url::Url;

use crate::auth::{fail, Failure};
use crate::http::log;

/// The origins sign-in trusts, and whether the checks run at all.
pub struct TrustedOrigins {
    patterns: Vec<String>,
    enforced: bool,
}

impl TrustedOrigins {
    /// `getTrustedOrigins` over `createBetterAuthOptions`: the base URL's origin, then
    /// `JARVIS_AUTH_TRUSTED_ORIGINS` or its defaults, then `BETTER_AUTH_TRUSTED_ORIGINS`.
    /// The defaults name the port this server listens on, where TypeScript reads `PORT`.
    pub fn from_env(env: &Env, listen_port: u16) -> Result<Self, String> {
        let configured = resolve_moss_env(env, "JARVIS_AUTH_BASE_URL")
            .or_else(|| env.get("BETTER_AUTH_URL").map(String::as_str))
            .filter(|url| !url.is_empty());
        let local = format!("http://localhost:{listen_port}");
        let base = Url::parse(configured.unwrap_or(&local)).map_err(|_| {
            "JARVIS_AUTH_BASE_URL or BETTER_AUTH_URL must be an absolute URL".to_owned()
        })?;

        let mut patterns = vec![base.origin().ascii_serialization()];
        match resolve_moss_env(env, "JARVIS_AUTH_TRUSTED_ORIGINS") {
            Some(list) => patterns.extend(
                list.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_owned),
            ),
            None => match configured {
                Some(url) => patterns.push(url.to_owned()),
                None => patterns.extend([local, format!("http://127.0.0.1:{listen_port}")]),
            },
        }
        if let Some(list) = env.get("BETTER_AUTH_TRUSTED_ORIGINS") {
            patterns.extend(list.split(',').filter(|item| !item.is_empty()).map(str::to_owned));
        }
        Ok(Self { patterns, enforced: !is_test(env) })
    }

    /// `originCheckMiddleware`: an auth POST that carries a cookie must come from a trusted page.
    pub fn check_auth_post(&self, headers: &HeaderMap) -> Result<(), Failure> {
        if !self.enforced || !headers.contains_key(COOKIE) {
            return Ok(());
        }
        self.check_origin(headers)
    }

    /// `formCsrfMiddleware`, for sign-up and sign-in. A browser sends fetch metadata, so its
    /// sign-in is checked even without a cookie, and a cross-site page load is refused.
    pub fn check_sign_in_form(&self, headers: &HeaderMap) -> Result<(), Failure> {
        if !self.enforced {
            return Ok(());
        }
        if headers.contains_key(COOKIE) {
            return self.check_origin(headers);
        }
        let site = fetch_header(headers, "sec-fetch-site");
        let mode = fetch_header(headers, "sec-fetch-mode");
        let dest = fetch_header(headers, "sec-fetch-dest");
        let browser = [&site, &mode, &dest]
            .iter()
            .any(|value| value.as_deref().is_some_and(|text| !text.trim().is_empty()));
        if !browser {
            return Ok(());
        }
        if site.as_deref() == Some("cross-site") && mode.as_deref() == Some("navigate") {
            log(json!({
                "level": "warn",
                "event": "auth.cross_site_sign_in_refused",
                "msg": "Blocked cross-site navigation login attempt (CSRF protection)",
            }));
            return Err(fail(
                403,
                "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
                "Cross-site navigation login blocked. This request appears to be a CSRF attack.",
            ));
        }
        self.check_origin(headers)
    }

    /// `validateOrigin`: `Origin`, else `Referer`, must match a trusted pattern.
    fn check_origin(&self, headers: &HeaderMap) -> Result<(), Failure> {
        let origin = [ORIGIN.as_str(), REFERER.as_str()]
            .into_iter()
            .filter_map(|name| fetch_header(headers, name))
            .find(|value| !value.is_empty())
            .unwrap_or_default();
        if origin.is_empty() || origin == "null" {
            return Err(fail(403, "MISSING_OR_NULL_ORIGIN", "Missing or null Origin"));
        }
        if self.patterns.iter().any(|pattern| matches_origin_pattern(&origin, pattern)) {
            return Ok(());
        }
        // A referer can carry a path and query, so only its origin is logged.
        let shown = Url::parse(&origin).ok().and_then(|url| origin_of(&url));
        log(json!({
            "level": "warn",
            "event": "auth.origin_refused",
            "origin": shown.as_deref().unwrap_or("not a URL"),
            "trustedOrigins": self.patterns,
            "msg": "Add the address to JARVIS_AUTH_TRUSTED_ORIGINS if it is this server",
        }));
        Err(fail(403, "INVALID_ORIGIN", "Invalid origin"))
    }
}

/// better-auth's `isTest()`: `NODE_ENV=test`, or `TEST` set to anything but "false".
fn is_test(env: &Env) -> bool {
    env.get("NODE_ENV").is_some_and(|name| name == "test")
        || env.get("TEST").is_some_and(|flag| !flag.is_empty() && flag != "false")
}

/// Fetch's `Headers.get`: every value of the header, joined with ", ".
fn fetch_header(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// `matchesOriginPattern` for an origin, which is never a relative path.
fn matches_origin_pattern(url: &str, pattern: &str) -> bool {
    if url.starts_with('/') {
        return false;
    }
    let parsed = Url::parse(url).ok();
    if pattern.contains('*') || pattern.contains('?') {
        if pattern.contains("://") {
            let origin = parsed.as_ref().and_then(origin_of);
            return wildcard_matches(pattern, origin.as_deref().unwrap_or(url));
        }
        return parsed.as_ref().and_then(host_of).is_some_and(|host| wildcard_matches(pattern, &host));
    }
    match &parsed {
        Some(parsed) if !matches!(parsed.scheme(), "http" | "https") => url.starts_with(pattern),
        _ => parsed.as_ref().and_then(origin_of).is_some_and(|origin| origin == pattern),
    }
}

/// `new URL(url).origin`, with the opaque origin "null" as none.
fn origin_of(url: &Url) -> Option<String> {
    let origin = url.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

/// `new URL(url).host`: the host, and the port unless it is the scheme's default.
fn host_of(url: &Url) -> Option<String> {
    let host = url.host_str().filter(|host| !host.is_empty())?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

/// One piece of a `wildcardMatch` pattern, which uses `/` as its separator.
enum Piece {
    Char(char),
    /// `?`: one character that is not a separator.
    One,
    /// `*`: any run of characters that are not separators.
    Run,
    /// The `/` after a segment: one or more separators, or any number after the last.
    Separator { at_least_one: bool },
    /// A `**` segment: any whole segments.
    Segments { at_least_one: bool },
}

fn is_separator(char: char) -> bool {
    char == '/' || char == '\\'
}

/// better-auth's `transform(pattern, true)`. The pattern splits at `/`, empty segments after
/// the first are dropped, and `\` makes the next character literal.
fn compile(pattern: &str) -> Vec<Piece> {
    let segments: Vec<&str> = pattern.split('/').collect();
    let mut pieces = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        if segment.is_empty() && index > 0 {
            continue;
        }
        let separator = match segments.get(index + 1) {
            None => Some(false),
            Some(&"**") => None,
            Some(_) => Some(true),
        };
        if *segment == "**" {
            if let Some(at_least_one) = separator {
                if index > 0 {
                    pieces.push(Piece::Separator { at_least_one });
                }
                pieces.push(Piece::Segments { at_least_one });
            }
            continue;
        }
        let mut chars = segment.chars();
        while let Some(char) = chars.next() {
            pieces.push(match char {
                '\\' => match chars.next() {
                    Some(next) => Piece::Char(next),
                    None => break,
                },
                '?' => Piece::One,
                '*' => Piece::Run,
                other => Piece::Char(other),
            });
        }
        if let Some(at_least_one) = separator {
            pieces.push(Piece::Separator { at_least_one });
        }
    }
    pieces
}

/// `wildcardMatch(pattern)(text)`: the whole text must match.
fn wildcard_matches(pattern: &str, text: &str) -> bool {
    let pieces = compile(pattern);
    let text: Vec<char> = text.chars().collect();
    let end = text.len();

    // matched[i][j] says whether pieces[i..] match text[j..].
    let mut matched = vec![vec![false; end + 1]; pieces.len() + 1];
    matched[pieces.len()][end] = true;
    for (i, piece) in pieces.iter().enumerate().rev() {
        let (head, tail) = matched.split_at_mut(i + 1);
        let (row, rest) = (&mut head[i], &tail[0]);
        for j in (0..=end).rev() {
            let here = text.get(j).copied();
            let plain = here.is_some_and(|char| !is_separator(char));
            let slash = here.is_some_and(is_separator);
            row[j] = match piece {
                Piece::Char(char) => here == Some(*char) && rest[j + 1],
                Piece::One => plain && rest[j + 1],
                Piece::Run => rest[j] || (plain && row[j + 1]),
                Piece::Separator { at_least_one: true } => slash && (rest[j + 1] || row[j + 1]),
                Piece::Separator { at_least_one: false } => rest[j] || (slash && row[j + 1]),
                Piece::Segments { at_least_one: false } => (j..=end).any(|k| rest[k]),
                Piece::Segments { at_least_one: true } => {
                    rest[j] || (j + 1..=end).any(|k| is_separator(text[k - 1]) && rest[k])
                }
            };
        }
    }
    matched[0][0]
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::{to_bytes, Body};
    use axum::http::{HeaderValue, Request};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;
    use crate::auth::SessionCookies;
    use crate::db::{Database, RuntimeRole};
    use crate::http::{app, Platform};
    use crate::secret::SecretCipher;

    const LOCAL: &str = "http://localhost:3000";

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    fn enforced() -> TrustedOrigins {
        TrustedOrigins::from_env(&Env::new(), 3000).unwrap()
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    fn refusal(result: Result<(), Failure>) -> Option<&'static str> {
        match result {
            Ok(()) => None,
            Err(Failure::Reply { status: 403, code, .. }) => Some(code),
            Err(_) => Some("not a 403 reply"),
        }
    }

    #[test]
    fn builds_the_trusted_list_like_typescript() {
        let list = |pairs: &[(&str, &str)]| TrustedOrigins::from_env(&env(pairs), 4000).unwrap();
        assert_eq!(
            list(&[]).patterns,
            ["http://localhost:4000", "http://localhost:4000", "http://127.0.0.1:4000"]
        );
        assert_eq!(
            list(&[("JARVIS_AUTH_BASE_URL", "https://moss.example.com:443/app/")]).patterns,
            ["https://moss.example.com", "https://moss.example.com:443/app/"]
        );
        assert_eq!(
            list(&[
                ("BETTER_AUTH_URL", "https://auth.example.com"),
                ("JARVIS_AUTH_TRUSTED_ORIGINS", " http://192.168.1.20:3000 , ,http://moss:81 "),
            ])
            .patterns,
            ["https://auth.example.com", "http://192.168.1.20:3000", "http://moss:81"]
        );
        // The MOSS_ name wins even when empty; better-auth's own list is not trimmed.
        assert_eq!(
            list(&[
                ("JARVIS_AUTH_TRUSTED_ORIGINS", "http://old.example"),
                ("MOSS_AUTH_TRUSTED_ORIGINS", ""),
                ("BETTER_AUTH_TRUSTED_ORIGINS", "http://a.example, http://b.example,"),
            ])
            .patterns,
            ["http://localhost:4000", "http://a.example", " http://b.example"]
        );
        assert!(TrustedOrigins::from_env(&env(&[("JARVIS_AUTH_BASE_URL", "moss")]), 1).is_err());
    }

    #[test]
    fn test_mode_turns_both_checks_off() {
        let hostile = headers(&[
            ("cookie", "a=b"),
            ("origin", "https://evil.example"),
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-mode", "navigate"),
        ]);
        for pairs in [[("NODE_ENV", "test")], [("TEST", "1")], [("TEST", "0")]] {
            let origins = TrustedOrigins::from_env(&env(&pairs), 3000).unwrap();
            assert!(!origins.enforced, "{pairs:?}");
            assert_eq!(refusal(origins.check_auth_post(&hostile)), None);
            assert_eq!(refusal(origins.check_sign_in_form(&hostile)), None);
        }
        for pairs in [[("NODE_ENV", "production")], [("TEST", "false")], [("TEST", "")]] {
            assert!(TrustedOrigins::from_env(&env(&pairs), 3000).unwrap().enforced, "{pairs:?}");
        }
    }

    #[test]
    fn auth_posts_with_a_cookie_need_a_trusted_origin() {
        let origins = enforced();
        let check = |pairs: &[(&'static str, &str)]| refusal(origins.check_auth_post(&headers(pairs)));
        let cookie = ("cookie", "a=b");
        assert_eq!(check(&[]), None);
        assert_eq!(check(&[("origin", "https://evil.example")]), None);
        assert_eq!(check(&[cookie]), Some("MISSING_OR_NULL_ORIGIN"));
        assert_eq!(check(&[cookie, ("origin", "null")]), Some("MISSING_OR_NULL_ORIGIN"));
        assert_eq!(check(&[cookie, ("origin", LOCAL)]), None);
        assert_eq!(check(&[cookie, ("origin", "http://127.0.0.1:3000")]), None);
        assert_eq!(check(&[cookie, ("origin", "https://evil.example")]), Some("INVALID_ORIGIN"));
        assert_eq!(check(&[cookie, ("referer", "http://localhost:3000/login?next=/")]), None);
        assert_eq!(check(&[cookie, ("origin", ""), ("referer", "http://localhost:3000/x")]), None);
        assert_eq!(
            check(&[cookie, ("origin", "https://evil.example"), ("referer", LOCAL)]),
            Some("INVALID_ORIGIN")
        );
        // Two Origin headers read as one joined value, which matches nothing.
        assert_eq!(check(&[cookie, ("origin", LOCAL), ("origin", LOCAL)]), Some("INVALID_ORIGIN"));
    }

    #[test]
    fn sign_in_forms_refuse_cross_site_browsers() {
        let origins = enforced();
        let check =
            |pairs: &[(&'static str, &str)]| refusal(origins.check_sign_in_form(&headers(pairs)));
        // A script or app sends neither a cookie nor fetch metadata.
        assert_eq!(check(&[]), None);
        assert_eq!(check(&[("sec-fetch-site", " ")]), None);
        assert_eq!(
            check(&[("sec-fetch-site", "cross-site"), ("sec-fetch-mode", "navigate")]),
            Some("CROSS_SITE_NAVIGATION_LOGIN_BLOCKED")
        );
        assert_eq!(
            check(&[("sec-fetch-site", "same-origin"), ("sec-fetch-mode", "cors"), ("origin", LOCAL)]),
            None
        );
        assert_eq!(
            check(&[("sec-fetch-site", "cross-site"), ("sec-fetch-mode", "cors"), ("origin", LOCAL)]),
            None
        );
        assert_eq!(check(&[("sec-fetch-dest", "empty")]), Some("MISSING_OR_NULL_ORIGIN"));
        assert_eq!(
            check(&[("sec-fetch-site", "same-origin"), ("origin", "http://192.168.1.20:3000")]),
            Some("INVALID_ORIGIN")
        );
        assert_eq!(check(&[("cookie", "a=b")]), Some("MISSING_OR_NULL_ORIGIN"));
        assert_eq!(check(&[("cookie", "a=b"), ("origin", LOCAL)]), None);
    }

    #[test]
    fn a_phone_signs_in_once_its_address_is_trusted() {
        let phone = headers(&[
            ("sec-fetch-site", "same-origin"),
            ("sec-fetch-mode", "cors"),
            ("origin", "http://192.168.1.20:3000"),
        ]);
        assert_eq!(refusal(enforced().check_sign_in_form(&phone)), Some("INVALID_ORIGIN"));
        let trusted = env(&[("JARVIS_AUTH_TRUSTED_ORIGINS", "http://192.168.1.20:3000")]);
        let origins = TrustedOrigins::from_env(&trusted, 3000).unwrap();
        assert_eq!(refusal(origins.check_sign_in_form(&phone)), None);
    }

    #[test]
    fn matches_origin_patterns_like_better_auth() {
        let cases = [
            ("http://localhost:3000", LOCAL, true),
            ("http://LOCALHOST:3000", LOCAL, true),
            ("http://localhost:3000/login?next=/", LOCAL, true),
            ("http://localhost:3001", LOCAL, false),
            ("https://moss.example.com:443", "https://moss.example.com", true),
            ("https://moss.example.com", "https://moss.example.com/", false),
            ("http://192.168.1.20:3000", "http://192.168.1.*:3000", true),
            ("http://192.168.2.20:3000", "http://192.168.1.*:3000", false),
            ("https://app.example.com", "*.example.com", true),
            ("https://a.b.example.com", "*.example.com", true),
            ("https://example.com", "*.example.com", false),
            ("http://app.example.com", "https://*.example.com", false),
            ("https://app.example.com:8443", "*.example.com:84?3", true),
            ("https://a.example.com", "https://?.example.com", true),
            ("https://ab.example.com", "https://?.example.com", false),
            ("moss-app://callback/done", "moss-app://callback", true),
            ("moss-app://other", "moss-app://callback", false),
            ("moss-app://anything", "moss-app://*", true),
            ("moss-app://any/thing", "moss-app://*", false),
            ("/settings", "/settings", false),
            ("not a url", "not a url", false),
            ("null", "null", false),
        ];
        for (url, pattern, want) in cases {
            assert_eq!(matches_origin_pattern(url, pattern), want, "{url} against {pattern}");
        }
    }

    #[test]
    fn wildcards_stop_at_separators_like_better_auth() {
        let cases = [
            ("*", "", true),
            ("*", "a/b", false),
            ("a*b*c", "aXbYbZc", true),
            ("a*b*c", "aXbYbZ", false),
            ("a\\*b", "a*b", true),
            ("a\\*b", "axb", false),
            ("a/b", "a//b", true),
            ("a/b", "a\\b", true),
            ("a/b", "ab", false),
            ("a/b", "a/b/", true),
            ("a/", "a", false),
            ("a/**/b", "a/b", true),
            ("a/**/b", "a/x/y/b", true),
            ("a/**/b", "ab", false),
            ("a/**", "a/x/y", true),
            ("**", "", true),
        ];
        for (pattern, text, want) in cases {
            assert_eq!(wildcard_matches(pattern, text), want, "{text} against {pattern}");
        }
    }

    /// The whole server, with pools that never connect: every request below is answered
    /// before its handler reaches the database.
    fn server() -> Router {
        let pool = |role| Database::unconnected("postgres://nobody@127.0.0.1:1/none", role);
        let platform = Platform {
            app: pool(RuntimeRole::App),
            auth: pool(RuntimeRole::Auth),
            sessions: SessionCookies::from_env(&env(&[("NODE_ENV", "test")])).unwrap(),
            connectors: SecretCipher::connectors(&Env::new()).unwrap(),
            origins: enforced(),
        };
        app(Arc::new(platform), Router::new())
    }

    async fn post(path: &str, pairs: &[(&'static str, &str)], body: &str) -> (u16, Value) {
        let mut request = Request::post(path).header("content-type", "application/json");
        for (name, value) in pairs {
            request = request.header(*name, *value);
        }
        let response =
            server().oneshot(request.body(Body::from(body.to_owned())).unwrap()).await.unwrap();
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 1 << 16).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn the_sign_in_routes_run_both_checks() {
        let cross_site = [("sec-fetch-site", "cross-site"), ("sec-fetch-mode", "navigate")];
        let foreign = [("sec-fetch-site", "same-site"), ("origin", "https://evil.example")];
        let same_origin = [("sec-fetch-site", "same-origin"), ("origin", LOCAL)];
        let routes = [
            (
                "/api/auth/sign-in/email",
                r#"{"email":"not-an-email","password":"long-enough"}"#,
                "INVALID_EMAIL",
            ),
            (
                "/api/auth/sign-up/email",
                r#"{"email":"someone@example.com","password":"short","name":"N"}"#,
                "PASSWORD_TOO_SHORT",
            ),
        ];
        for (path, body, past_the_checks) in routes {
            let (status, reply) = post(path, &cross_site, body).await;
            assert_eq!((status, &reply["code"]), (403, &json!("CROSS_SITE_NAVIGATION_LOGIN_BLOCKED")));
            let (status, reply) = post(path, &foreign, body).await;
            assert_eq!((status, &reply["code"]), (403, &json!("INVALID_ORIGIN")));
            // A trusted page gets as far as the handler's own checks, which need no database.
            let (status, reply) = post(path, &same_origin, body).await;
            assert_eq!((status, &reply["code"]), (400, &json!(past_the_checks)));
            // A cookie is checked before the body is read.
            let (status, reply) = post(path, &[("cookie", "a=b")], "{}").await;
            assert_eq!((status, &reply["code"]), (403, &json!("MISSING_OR_NULL_ORIGIN")));
        }

        let (status, reply) = post("/api/auth/sign-out", &[("cookie", "a=b")], "").await;
        assert_eq!((status, &reply["code"]), (403, &json!("MISSING_OR_NULL_ORIGIN")));
        let trusted = [("cookie", "a=b"), ("origin", LOCAL)];
        let (status, reply) = post("/api/auth/sign-out", &trusted, "").await;
        assert_eq!((status, &reply["code"]), (400, &json!("FAILED_TO_GET_SESSION")));
    }
}
