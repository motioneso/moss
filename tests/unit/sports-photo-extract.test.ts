import { describe, expect, it } from "vitest";

import {
  extractFeedPhoto,
  extractShareImage,
  isUsablePhotoCandidate,
  parseFeedPhotoItems,
  photoKey
} from "../../packages/sports/src/source/photo.js";

describe("sports feed photo extraction (#2237)", () => {
  it("prefers media:content over media:thumbnail and an enclosure", () => {
    const found = extractFeedPhoto({
      link: "https://example.com/a",
      media: [
        { tag: "enclosure", url: "https://example.com/e.jpg", type: "image/jpeg", medium: null, width: null, height: null },
        { tag: "media:thumbnail", url: "https://example.com/t.jpg", type: null, medium: null, width: null, height: null },
        { tag: "media:content", url: "https://example.com/c.jpg", type: "image/jpeg", medium: null, width: null, height: null }
      ]
    });
    expect(found).toEqual({ url: "https://example.com/c.jpg", origin: "feed" });
  });

  it("takes the largest declared width within one tag name", () => {
    const found = extractFeedPhoto({
      link: "https://example.com/a",
      media: [
        { tag: "media:content", url: "https://example.com/small.jpg", type: null, medium: "image", width: 200, height: 100 },
        { tag: "media:content", url: "https://example.com/big.jpg", type: null, medium: "image", width: 1200, height: 600 }
      ]
    });
    expect(found?.url).toBe("https://example.com/big.jpg");
  });

  it("ignores a media:content that declares a non-image type", () => {
    const found = extractFeedPhoto({
      link: "https://example.com/a",
      media: [
        { tag: "media:content", url: "https://example.com/clip.mp4", type: "video/mp4", medium: "video", width: 1920, height: 1080 }
      ]
    });
    expect(found).toBeNull();
  });

  it("returns null when an item carries no media tag", () => {
    expect(extractFeedPhoto({ link: "https://example.com/a", media: [] })).toBeNull();
  });

  it("parses media tags per item out of an RSS body", () => {
    const items = parseFeedPhotoItems(`<?xml version="1.0"?>
      <rss><channel>
        <item>
          <link>https://example.com/one</link>
          <media:content url="https://example.com/one.jpg" medium="image" width="900"/>
        </item>
        <item>
          <link>https://example.com/two</link>
        </item>
      </channel></rss>`);
    expect(items).toHaveLength(2);
    expect(items[0]?.link).toBe("https://example.com/one");
    expect(extractFeedPhoto(items[0]!)?.url).toBe("https://example.com/one.jpg");
    expect(extractFeedPhoto(items[1]!)).toBeNull();
  });
});

describe("sports share image extraction (#2237)", () => {
  it("prefers og:image:secure_url, then og:image, then twitter:image", () => {
    const html = `<html><head>
      <meta name="twitter:image" content="https://example.com/twitter.jpg">
      <meta property="og:image" content="https://example.com/og.jpg">
      <meta property="og:image:secure_url" content="https://example.com/secure.jpg">
    </head></html>`;
    expect(extractShareImage(html, "https://example.com/story")).toEqual({
      url: "https://example.com/secure.jpg",
      origin: "share"
    });
  });

  it("resolves a relative share image against the article page", () => {
    const html = `<html><head><meta property="og:image" content="/img/story.jpg"></head></html>`;
    expect(extractShareImage(html, "https://example.com/sport/story")?.url).toBe(
      "https://example.com/img/story.jpg"
    );
  });

  it("rejects rather than upgrades a plain http share image", () => {
    const html = `<html><head><meta property="og:image" content="http://example.com/s.jpg"></head></html>`;
    expect(extractShareImage(html, "https://example.com/story")).toBeNull();
  });

  it("returns null for a page with no share image", () => {
    expect(extractShareImage("<html><head></head></html>", "https://example.com/s")).toBeNull();
  });
});

describe("sports photo candidate rules (#2237)", () => {
  const publisherHost = "example.com";

  it("accepts the publisher's own host and its subdomains", () => {
    expect(isUsablePhotoCandidate("https://example.com/a.jpg", { publisherHost })).toBe(true);
    expect(isUsablePhotoCandidate("https://images.example.com/a.jpg", { publisherHost })).toBe(true);
  });

  it("accepts a host on the built-in image host list", () => {
    expect(isUsablePhotoCandidate("https://i.guim.co.uk/a.jpg", { publisherHost })).toBe(true);
  });

  it("rejects an unrelated third-party host", () => {
    expect(isUsablePhotoCandidate("https://tracker.example.net/a.jpg", { publisherHost })).toBe(
      false
    );
  });

  it("rejects plain http, credentials in the URL, and an address literal", () => {
    expect(isUsablePhotoCandidate("http://example.com/a.jpg", { publisherHost })).toBe(false);
    expect(isUsablePhotoCandidate("https://u:p@example.com/a.jpg", { publisherHost })).toBe(false);
    expect(isUsablePhotoCandidate("https://127.0.0.1/a.jpg", { publisherHost: "127.0.0.1" })).toBe(
      false
    );
    expect(isUsablePhotoCandidate("https://localhost/a.jpg", { publisherHost: "localhost" })).toBe(
      false
    );
  });

  it("rejects site furniture and a declared tracking pixel", () => {
    expect(isUsablePhotoCandidate("https://example.com/logo.png", { publisherHost })).toBe(false);
    expect(isUsablePhotoCandidate("https://example.com/favicon.ico", { publisherHost })).toBe(false);
    expect(isUsablePhotoCandidate("https://example.com/px.gif?w=1&h=1", { publisherHost })).toBe(
      false
    );
    expect(isUsablePhotoCandidate("https://example.com/pixel/1x1.gif", { publisherHost })).toBe(
      false
    );
  });

  it("rejects an over-long URL", () => {
    const long = `https://example.com/${"a".repeat(2100)}.jpg`;
    expect(isUsablePhotoCandidate(long, { publisherHost })).toBe(false);
  });
});

describe("sports photo key (#2237)", () => {
  it("is stable, 32 hex characters, and scoped to the source", () => {
    const key = photoKey("source-a", "https://example.com/a.jpg");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(photoKey("source-a", "https://example.com/a.jpg")).toBe(key);
    expect(photoKey("source-b", "https://example.com/a.jpg")).not.toBe(key);
    expect(photoKey("source-a", "https://example.com/b.jpg")).not.toBe(key);
  });
});
