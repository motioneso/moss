use moss_news_reader::{html::*, url::Url};

const PAGE: &str = r#"<html><head><title> Example  News </title>
  <meta name="description" content="Local reporting">
  <link rel="canonical" href="https://www.example.com/">
  <link rel="alternate" type="application/rss+xml" href="/feed.xml">
  <link rel="alternate" type="application/atom+xml" href="http://www.example.com/insecure.xml">
  <link rel="alternate" type="application/rss+xml" href="https://other.org/feed.xml">
  <link rel="alternate" type="application/rss+xml" href="/feed.xml">
  </head><body>
  <a href="/a/one">A headline long enough to count</a>
  <a href="/a/two">short</a>
  <a href="https://other.org/x">A headline on another site entirely</a>
  <a href="/a/one">A headline long enough to count</a></body></html>"#;

#[test]
fn finds_same_publisher_https_feeds_once() {
    assert_eq!(discover_feed_urls(PAGE, "https://www.example.com/"), vec!["https://www.example.com/feed.xml"]);
}

#[test]
fn listing_keeps_long_same_site_links_once() {
    let found = extract_listing_headlines(PAGE, "https://www.example.com/", 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].url, "https://www.example.com/a/one");
}

#[test]
fn metadata_reads_title_description_and_canonical() {
    let meta = html_metadata(PAGE);
    assert_eq!(meta.title, "Example News");
    assert_eq!(meta.description, "Local reporting");
    assert_eq!(meta.canonical_url.as_deref(), Some("https://www.example.com/"));
}

#[test]
fn relative_forms_resolve() {
    let base = Url::parse("https://example.com/a/b?x=1").unwrap();
    assert_eq!(resolve_url("c", &base).unwrap().href, "https://example.com/a/c");
    assert_eq!(resolve_url("../c", &base).unwrap().href, "https://example.com/c");
    assert_eq!(resolve_url("//cdn.example.com/f", &base).unwrap().href, "https://cdn.example.com/f");
    assert_eq!(resolve_url("?y=2", &base).unwrap().href, "https://example.com/a/b?y=2");
    assert!(resolve_url("javascript:alert(1)", &base).is_none());
}

#[test]
fn feed_samples_need_https_links() {
    let xml = "<rss><channel><item><title>One</title><link>https://e.com/1</link></item><item><title>Two</title><link>http://e.com/2</link></item></channel></rss>";
    let found = sample_feed_headlines(xml, 10);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].headline, "One");
}
