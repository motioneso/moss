//! RSS 2.0 and Atom reading. A feed becomes at most 30 sanitised items.

use std::collections::HashSet;

use quick_xml::events::{BytesStart, Event};
use serde::Serialize;

use crate::body_image::feed_body_image_url;
use crate::sanitize::{
    sanitize_feed_text, sanitize_image_url, sanitize_item_url, sanitize_published_at,
    SUMMARY_CHAR_CAP, TITLE_CHAR_CAP,
};
use crate::xml::{attr, attributes, event_text, new_reader, tag_name};

pub const ITEMS_PER_FEED_CAP: usize = 30;
pub const PUBLIC_FEED_XML_CHAR_CAP: usize = 1_000_000;

/// Everything a feed contributes to a page, fully sanitised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    /// Stable hash of the article address, used to drop repeats.
    pub id: String,
    pub title: String,
    pub url: String,
    pub published_at: Option<String>,
    pub image_url: Option<String>,
    pub summary: String,
}

/// FNV-1a 32-bit over the address as UTF-16 units. Not a security boundary.
pub fn stable_id_for_url(url: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in url.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

#[derive(Debug, Default, Clone)]
pub struct RawFeedItem {
    pub title: String,
    pub link: String,
    pub summary: String,
    pub content_fallback: String,
    pub published_at: String,
    pub image_url: String,
    /// True once the item names its art in a media tag, even when the tag has no usable address.
    pub has_media_image: bool,
    image_is_thumbnail: bool,
    image_width: f64,
}

#[derive(Clone, Copy, PartialEq)]
enum Field {
    Title,
    Link,
    Summary,
    ContentFallback,
    PublishedAt,
}

struct ItemParser {
    items: Vec<RawFeedItem>,
    current: Option<RawFeedItem>,
    field: Option<Field>,
    depth: usize,
    item_depth: usize,
}

impl ItemParser {
    fn open(&mut self, e: &BytesStart<'_>) {
        self.depth += 1;
        let tag = tag_name(e);
        if (tag == "item" || tag == "entry") && self.current.is_none() {
            self.current = Some(RawFeedItem::default());
            self.item_depth = self.depth;
            return;
        }
        let depth = self.depth;
        let item_depth = self.item_depth;
        let Some(current) = self.current.as_mut() else { return };
        let attribs = attributes(e);
        if tag == "media:content" || tag == "media:thumbnail" {
            current.has_media_image = true;
            if let Some(url) = attr(&attribs, "url").filter(|u| !u.is_empty()) {
                let width = attr(&attribs, "width")
                    .and_then(|w| w.trim().parse::<f64>().ok())
                    .filter(|w| w.is_finite())
                    .unwrap_or(0.0);
                if tag == "media:content" {
                    if current.image_url.is_empty()
                        || current.image_is_thumbnail
                        || width > current.image_width
                    {
                        current.image_url = url.to_string();
                        current.image_is_thumbnail = false;
                        current.image_width = width;
                    }
                } else if current.image_url.is_empty() {
                    current.image_url = url.to_string();
                    current.image_is_thumbnail = true;
                    current.image_width = width;
                }
            }
            return;
        }
        if tag == "enclosure" {
            if !attr(&attribs, "type").unwrap_or("").starts_with("image/") {
                return;
            }
            current.has_media_image = true;
            if current.image_url.is_empty() {
                if let Some(url) = attr(&attribs, "url").filter(|u| !u.is_empty()) {
                    current.image_url = url.to_string();
                }
            }
            return;
        }
        if depth != item_depth + 1 {
            return;
        }
        match tag.as_str() {
            "title" => self.field = Some(Field::Title),
            "description" | "summary" => self.field = Some(Field::Summary),
            "content" | "content:encoded" => self.field = Some(Field::ContentFallback),
            "link" => match attr(&attribs, "href").filter(|h| !h.is_empty()) {
                Some(href) => {
                    let rel = attr(&attribs, "rel").filter(|r| !r.is_empty());
                    if (rel.is_none() || rel == Some("alternate")) && current.link.is_empty() {
                        current.link = href.to_string();
                    }
                }
                None => self.field = Some(Field::Link),
            },
            "pubdate" | "published" | "updated" | "dc:date" => {
                if current.published_at.is_empty() {
                    self.field = Some(Field::PublishedAt);
                }
            }
            _ => {}
        }
    }

    fn text(&mut self, text: &str) {
        let (Some(current), Some(field)) = (self.current.as_mut(), self.field) else { return };
        match field {
            Field::Title => current.title.push_str(text),
            Field::Link => current.link.push_str(text),
            Field::Summary => current.summary.push_str(text),
            Field::ContentFallback => current.content_fallback.push_str(text),
            Field::PublishedAt => current.published_at.push_str(text),
        }
    }

    fn close(&mut self, tag: &str) {
        if (tag == "item" || tag == "entry") && self.current.is_some() && self.depth == self.item_depth {
            if let Some(done) = self.current.take() {
                self.items.push(done);
            }
            self.item_depth = 0;
        }
        self.field = None;
        self.depth = self.depth.saturating_sub(1);
    }
}

/// Streams the XML into raw items. Reading stops quietly at the first malformed spot and keeps
/// every item finished before it.
pub fn parse_feed_xml(xml: &str) -> Vec<RawFeedItem> {
    let mut parser = ItemParser {
        items: Vec::new(),
        current: None,
        field: None,
        depth: 0,
        item_depth: 0,
    };
    let mut reader = new_reader(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => parser.open(&e),
            Ok(Event::Empty(e)) => {
                parser.open(&e);
                parser.close(&tag_name(&e));
            }
            Ok(Event::End(e)) => {
                let tag = e.name().as_ref().to_ascii_lowercase();
                parser.close(&tag);
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(other) => {
                if let Some(text) = event_text(&other) {
                    parser.text(&text);
                }
            }
        }
    }
    parser.items
}

/// Parses and sanitises one feed. Artwork must be on `image_hosts`.
pub fn to_feed_items(xml: &str, image_hosts: &[&str]) -> Vec<FeedItem> {
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    for raw in parse_feed_xml(xml) {
        if items.len() >= ITEMS_PER_FEED_CAP {
            break;
        }
        let Some(url) = sanitize_item_url(Some(&raw.link)) else { continue };
        let id = stable_id_for_url(&url);
        if seen.contains(&id) {
            continue;
        }
        let title = sanitize_feed_text(Some(&raw.title), TITLE_CHAR_CAP);
        if title.is_empty() {
            continue;
        }
        seen.insert(id.clone());
        // A feed that names art in a media tag and gets it wrong gets no art. Only a feed with no
        // media tag at all falls back to the first real picture in the story body.
        let image_url = if raw.has_media_image {
            sanitize_image_url(Some(&raw.image_url), image_hosts)
        } else {
            feed_body_image_url(&raw.content_fallback, &raw.summary, image_hosts)
        };
        let summary_source = if raw.summary.is_empty() { &raw.content_fallback } else { &raw.summary };
        items.push(FeedItem {
            id,
            title,
            url,
            published_at: sanitize_published_at(Some(&raw.published_at)),
            image_url,
            summary: sanitize_feed_text(Some(summary_source), SUMMARY_CHAR_CAP),
        });
    }
    items
}

/// Reader for any confirmed public feed. No artwork host is trusted, so no art is kept.
pub fn parse_public_feed_items(xml: &str) -> Vec<FeedItem> {
    if xml.encode_utf16().count() > PUBLIC_FEED_XML_CHAR_CAP {
        return Vec::new();
    }
    to_feed_items(xml, &[])
}

/// True for a well-formed Atom feed or RSS document with a channel.
pub fn is_public_feed_document(xml: &str) -> bool {
    if xml.encode_utf16().count() > PUBLIC_FEED_XML_CHAR_CAP {
        return false;
    }
    let mut reader = new_reader(xml);
    let mut stack: Vec<String> = Vec::new();
    let mut root: Option<String> = None;
    let mut rss_channel = false;
    loop {
        let event = match reader.read_event() {
            Ok(event) => event,
            Err(_) => return false,
        };
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let is_empty = matches!(event, Event::Empty(_));
                let tag = tag_name(e);
                if stack.is_empty() {
                    if root.is_some() {
                        return false;
                    }
                    root = Some(tag.clone());
                } else if root.as_deref() == Some("rss") && stack.len() == 1 && tag == "channel" {
                    rss_channel = true;
                }
                if !is_empty {
                    stack.push(e.name().as_ref().to_string());
                }
            }
            Event::End(e) => {
                // The old parser matched close tags case-sensitively, ignored a close tag that
                // names nothing open, and treated closing over an open child as malformed.
                let name = e.name();
                let tag = name.as_ref();
                if let Some(at) = stack.iter().rposition(|opened| opened == tag) {
                    if at + 1 != stack.len() {
                        return false;
                    }
                    stack.pop();
                }
            }
            Event::Text(_) | Event::CData(_) | Event::GeneralRef(_) => {
                if stack.is_empty() {
                    let text = event_text(&event).unwrap_or_default();
                    if !text.trim_start_matches('\u{feff}').trim().is_empty() {
                        return false;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    stack.is_empty() && (root.as_deref() == Some("feed") || (root.as_deref() == Some("rss") && rss_channel))
}
