//! Checks for one candidate photo address and the page rules that find one. Nothing here
//! touches the network. The photo pass fetches, and the host re-encodes.
use crate::source_web::{lean_html, resolve, sha256_hex};
use moss_news_reader::{publisher_identity, same_publisher, url::Url};
use scraper::{Html, Selector};
use serde_json::{json, Value};

pub const MAX_URL: usize = 2048;
const NON_PHOTO: [&str; 5] = ["favicon.ico", "logo", "default", "placeholder", "sprite"];
const PIXEL: [&str; 4] = ["1x1", "pixel", "beacon", "spacer"];
const ATTRIBUTES: [&str; 4] = ["src", "content", "data-src", "href"];

/// Names one copy: the source plus the photo address.
pub fn photo_key(source_id: &str, photo_url: &str) -> String {
    sha256_hex(format!("{source_id}\0{photo_url}").as_bytes())[..32].to_owned()
}

/// The address when it can be a photo for a story on `page_host`, else nothing. Only HTTPS
/// addresses on a public name pass, with no login in them, from the publisher's own site or
/// one of the source's confirmed hosts, and not an icon, logo, placeholder or tracking pixel.
pub fn usable_candidate(url: &str, page_host: &str, confirmed: &[String]) -> Option<String> {
    if url.len() > MAX_URL {
        return None;
    }
    let parsed = Url::parse(url)?;
    let host = parsed.hostname.to_lowercase();
    if !parsed.https || !parsed.username.is_empty() || !parsed.password.is_empty() || publisher_identity(&host).is_none() {
        return None;
    }
    if !(same_publisher(&host, page_host) || confirmed.contains(&host)) {
        return None;
    }
    let path = format!("{}{}", parsed.pathname, parsed.search).to_lowercase();
    if NON_PHOTO.iter().chain(PIXEL.iter()).any(|bad| path.contains(bad)) {
        return None;
    }
    Some(parsed.href)
}

/// A saved page rule: where on the page the story photo sits.
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub fetch_hosts: Vec<String>,
    pub selector: String,
    pub attribute: String,
    pub share_fallback: bool,
}

impl Rule {
    pub fn to_value(&self) -> Value {
        json!({
            "version": 1,
            "kind": "html",
            "fetchHosts": self.fetch_hosts,
            "photo": {"selector": self.selector, "source": "attribute", "attribute": self.attribute},
            "fallback": if self.share_fallback { "share_image" } else { "none" },
        })
    }
}

/// Checks a rule against the source's confirmed hosts. Hosts must be unique, one publisher, and
/// all confirmed. The selector must compile and may not reach a pseudo-element.
pub fn validate(value: &Value, confirmed: &[String]) -> Option<Rule> {
    let object = value.as_object()?;
    if object.len() != 5 || value["version"] != 1 || value["kind"] != "html" {
        return None;
    }
    let hosts: Vec<String> = value["fetchHosts"].as_array()?.iter().map(|h| h.as_str().map(str::to_lowercase)).collect::<Option<_>>()?;
    let first = hosts.first()?;
    let unique = hosts.iter().enumerate().all(|(i, h)| !hosts[..i].contains(h));
    if hosts.len() > 8 || !unique || !hosts.iter().all(|h| same_publisher(h, first) && confirmed.contains(h)) {
        return None;
    }
    let photo = value["photo"].as_object()?;
    let selector = photo.get("selector")?.as_str()?;
    let attribute = photo.get("attribute")?.as_str()?;
    if photo.len() != 3 || photo.get("source")? != "attribute" || !ATTRIBUTES.contains(&attribute) {
        return None;
    }
    if selector.is_empty() || selector.chars().count() > 120 || selector.contains("::") || Selector::parse(selector).is_err() {
        return None;
    }
    let share_fallback = match value["fallback"].as_str()? {
        "share_image" => true,
        "none" => false,
        _ => return None,
    };
    Some(Rule { fetch_hosts: hosts, selector: selector.to_owned(), attribute: attribute.to_owned(), share_fallback })
}

/// The address the rule points at, resolved against the page address.
pub fn apply(rule: &Rule, html: &str, page_url: &str) -> Option<String> {
    let base = Url::parse(page_url)?;
    let document = Html::parse_document(&lean_html(html));
    let selector = Selector::parse(&rule.selector).ok()?;
    let raw = document.select(&selector).next()?.value().attr(&rule.attribute)?;
    resolve(raw, &base).map(|u| u.href)
}

/// The page's share image: the secure address, then the plain one, then the Twitter card.
pub fn share_image(html: &str, page_url: &str) -> Option<String> {
    let base = Url::parse(page_url)?;
    let document = Html::parse_document(&lean_html(html));
    let meta = Selector::parse("meta").ok()?;
    let found = |name: &str| {
        document.select(&meta).find_map(|el| {
            let value = el.value();
            let key = value.attr("property").or_else(|| value.attr("name"))?.to_ascii_lowercase();
            (key == name).then(|| value.attr("content")).flatten().map(str::to_owned)
        })
    };
    ["og:image:secure_url", "og:image", "twitter:image"]
        .iter()
        .find_map(|name| found(name))
        .and_then(|raw| resolve(&raw, &base))
        .map(|u| u.href)
}
