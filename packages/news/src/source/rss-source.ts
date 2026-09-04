import { Parser } from "htmlparser2";

import type { ExternalSourceAdapter, ExternalSourceAdapterContext } from "@moss/module-sdk";

import { sourceEntry, type NewsSourceEntry } from "./catalog.js";
import {
  SUMMARY_CHAR_CAP,
  TITLE_CHAR_CAP,
  sanitizeFeedText,
  sanitizeImageUrl,
  sanitizeItemUrl,
  sanitizePublishedAt
} from "./sanitize.js";

// Everything a feed contributes to the page. Fully sanitized before it leaves this layer —
// the service composes these into `NewsHeadline`s without touching the raw XML.
export interface RssFeedItem {
  /** Stable hash of the article URL (dedupe key + React key). */
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly imageUrl: string | null;
  readonly summary: string;
}

export interface NewsFeedParams {
  readonly sourceKey: string;
  /** Canonical topic key, or null for the source's top feed. */
  readonly topicKey: string | null;
}

const ITEMS_PER_FEED_CAP = 30;
const PUBLIC_FEED_XML_CHAR_CAP = 1_000_000;

/** FNV-1a 32-bit over the URL — stable across processes (no per-boot salt), collision-tolerant
 *  because it's only a dedupe/React key, never a security boundary. */
export function stableIdForUrl(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

interface RawFeedItem {
  title: string;
  link: string;
  summary: string;
  contentFallback: string;
  publishedAt: string;
  imageUrl: string;
  imageIsThumbnail: boolean;
  imageWidth: number;
}

function emptyRawItem(): RawFeedItem {
  return {
    title: "",
    link: "",
    summary: "",
    contentFallback: "",
    publishedAt: "",
    imageUrl: "",
    imageIsThumbnail: false,
    imageWidth: 0
  };
}

// Accumulating-text fields ontext() can append to (attribute-driven fields are set directly).
type TextField = "title" | "link" | "summary" | "contentFallback" | "publishedAt";

/**
 * Streaming RSS 2.0 / Atom parser over htmlparser2's XML mode (CDATA + entity decoding handled
 * by the parser; both feed dialects verified against real fixtures in `__fixtures__/`).
 * Tolerates whitespace/attributes after the root tag name — the Verge's Atom root spreads its
 * xmlns attributes across lines, which naive regex sniffing misses.
 */
export function parseFeedXml(xml: string): RawFeedItem[] {
  const items: RawFeedItem[] = [];
  let current: RawFeedItem | null = null;
  let field: TextField | null = null;
  // Depth guard: media:group or nested containers can hold their own <title>-like tags; only
  // capture text for direct children of <item>/<entry> (depth === itemDepth + 1).
  let depth = 0;
  let itemDepth = -1;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        depth += 1;
        const tag = name.toLowerCase();
        if ((tag === "item" || tag === "entry") && current === null) {
          current = emptyRawItem();
          itemDepth = depth;
          return;
        }
        if (!current) return;
        // Media tags may sit inside <media:group>; accept them at any depth within the item.
        if (tag === "media:content" || tag === "media:thumbnail") {
          const url = attribs["url"];
          // Prefer media:content (full-size art) over media:thumbnail, and among several
          // media:content sizes (Guardian emits 140/460/…) keep the widest.
          if (url) {
            const width = Number(attribs["width"]) || 0;
            if (tag === "media:content") {
              if (!current.imageUrl || current.imageIsThumbnail || width > current.imageWidth) {
                current.imageUrl = url;
                current.imageIsThumbnail = false;
                current.imageWidth = width;
              }
            } else if (tag === "media:thumbnail" && !current.imageUrl) {
              current.imageUrl = url;
              current.imageIsThumbnail = true;
              current.imageWidth = width;
            }
          }
          return;
        }
        if (tag === "enclosure") {
          if (!current.imageUrl && attribs["url"] && (attribs["type"] ?? "").startsWith("image/")) {
            current.imageUrl = attribs["url"];
          }
          return;
        }
        if (depth !== itemDepth + 1) return;
        switch (tag) {
          case "title":
            field = "title";
            break;
          case "description":
          case "summary":
            field = "summary";
            break;
          case "content":
          case "content:encoded":
            // Fallback body when the feed has no description/summary (some Atom feeds).
            field = "contentFallback";
            break;
          case "link":
            if (attribs["href"]) {
              // Atom: <link href="..."/> (rel absent or "alternate" = the article link).
              const rel = attribs["rel"];
              if ((!rel || rel === "alternate") && !current.link) {
                current.link = attribs["href"];
              }
            } else {
              field = "link"; // RSS: <link>https://…</link>
            }
            break;
          case "pubdate":
          case "published":
          case "updated":
          case "dc:date":
            // First-wins keeps <published> over a later <updated> in Atom entries.
            if (!current.publishedAt) field = "publishedAt";
            break;
          default:
            break;
        }
      },
      ontext(text) {
        if (current && field) current[field] += text;
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if ((tag === "item" || tag === "entry") && current && depth === itemDepth) {
          items.push(current);
          current = null;
          itemDepth = -1;
        }
        field = null;
        depth -= 1;
      }
    },
    { xmlMode: true }
  );
  parser.write(xml);
  parser.end();
  return items;
}

/** Parse + sanitize one feed's XML into ready-to-serve items (also the fixture-test entrypoint). */
export function toFeedItems(xml: string, source: NewsSourceEntry): RssFeedItem[] {
  return toSanitizedFeedItems(xml, source.imageHosts);
}

/** Public, catalog-independent RSS/Atom parser for other modules' confirmed public feeds. */
export function parsePublicFeedItems(xml: string): RssFeedItem[] {
  if (xml.length > PUBLIC_FEED_XML_CHAR_CAP) return [];
  return toSanitizedFeedItems(xml, []);
}

export function isPublicFeedDocument(xml: string): boolean {
  if (xml.length > PUBLIC_FEED_XML_CHAR_CAP) return false;
  const stack: Array<{ name: string; selfClosing: boolean }> = [];
  let root: string | null = null;
  let rssChannel = false;
  let invalid = false;
  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        stack.push({
          name: tag,
          selfClosing: xml
            .slice(parser.startIndex, parser.endIndex + 1)
            .trimEnd()
            .endsWith("/>")
        });
        if (stack.length === 1) {
          if (root !== null) invalid = true;
          root = tag;
        } else if (root === "rss" && stack.length === 2 && tag === "channel") {
          rssChannel = true;
        }
      },
      ontext(text) {
        if (stack.length === 0 && text.replace(/^\uFEFF/, "").trim()) invalid = true;
      },
      onclosetag(name, isImplied) {
        const opened = stack.pop();
        if (opened?.name !== name.toLowerCase() || (isImplied && opened.selfClosing === false)) {
          invalid = true;
        }
      },
      onerror() {
        invalid = true;
      }
    },
    { xmlMode: true }
  );
  try {
    parser.write(xml);
    parser.end();
  } catch {
    return false;
  }
  return !invalid && stack.length === 0 && (root === "feed" || (root === "rss" && rssChannel));
}

// Some feeds (NPR) carry no media:content/media:thumbnail/enclosure at all — the only image is
// the first real <img> in the story's HTML body. The body fragment is read with the same
// streaming HTML tokenizer the rest of this module already uses, not a regex: hand-written
// patterns kept both losing valid pictures (uppercase tag names, unquoted values, a tag split
// across lines, a ">" inside an attribute value) and letting tracking pixels through. The
// tokenizer is a single forward pass, and the fragment is capped first, so a huge or malformed
// body costs a bounded amount of work.
const BODY_IMAGE_SCAN_CHAR_CAP = 20_000;

// Tracking pixels are invisible by construction, so only unambiguous evidence disqualifies an
// image: a declared width or height of 0 or 1, a hidden attribute or style, a host whose first
// label exists to count views, or the whole word "pixel" or "impression" standing alone as a
// path segment or a query key. Nothing else counts. Earlier revisions matched tracking-sounding
// words inside a file name or a campaign value, which threw away real photographs called
// "track.jpg", "beacon.jpg" and "real.jpg?trk=newsletter".
const TRACKING_HOST_LABEL_PATTERN =
  /^(?:pixel|pixels|px|beacon|track|tracker|tracking|analytics|stats|metrics|collect|counter|imp|impression|log|logs)$/i;
// "pixel" or "impression" and nothing else, ignoring a file extension: "/pixel.gif" and
// "/impression/abc" qualify, "google-pixel-10.jpg" and "pixels-of-history.jpg" do not.
const TRACKING_WORD_PATTERN = /^(?:pixel|impression)(?:\.[a-z0-9]+)?$/i;
const TRACKING_QUERY_KEY_PATTERN = /^(?:pixel|impression)$/i;
// A style that hides the image outright, or sizes it down to a single pixel.
const HIDDEN_STYLE_PATTERN =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|(?:width|height)\s*:\s*(?:0|1)(?:\.0+)?(?:px)?\s*)(?:;|$)/i;

/** A declared HTML pixel size, or null when the attribute is absent or not a plain number
 *  ("auto", "50%", ""). Only a real number can disqualify an image; junk means "unknown". */
function declaredPixelSize(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^\s*(\d+)(?:\.\d+)?\s*(?:px)?\s*$/i.exec(value);
  return match ? Number(match[1]) : null;
}

function isInvisibleImage(attribs: Record<string, string>): boolean {
  if (attribs.hidden !== undefined) return true;
  if (attribs.style !== undefined && HIDDEN_STYLE_PATTERN.test(attribs.style)) return true;
  const width = declaredPixelSize(attribs.width);
  const height = declaredPixelSize(attribs.height);
  return (width !== null && width <= 1) || (height !== null && height <= 1);
}

function isTrackingAddress(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src, "https://feed.invalid/");
  } catch {
    return false; // unparseable — the allow-list check downstream rejects it anyway
  }
  const firstLabel = url.hostname.split(".")[0] ?? "";
  if (TRACKING_HOST_LABEL_PATTERN.test(firstLabel)) return true;
  for (const segment of url.pathname.split("/")) {
    if (segment && TRACKING_WORD_PATTERN.test(segment)) return true;
  }
  for (const key of url.searchParams.keys()) {
    if (TRACKING_QUERY_KEY_PATTERN.test(key)) return true;
  }
  return false;
}

/** First real (non-tracking) <img> address in an HTML fragment, or null. The tokenizer runs in
 *  HTML mode, so it lower-cases tag and attribute names, accepts unquoted and single-quoted
 *  values, and decodes each entity exactly once — an already-escaped "&amp;lt;" stays "&lt;"
 *  rather than collapsing to "<" and changing the address. */
function firstRealImgSrc(html: string): string | null {
  if (!html) return null;
  const text =
    html.length > BODY_IMAGE_SCAN_CHAR_CAP ? html.slice(0, BODY_IMAGE_SCAN_CHAR_CAP) : html;
  const picked: { src: string | null } = { src: null };
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (picked.src !== null || name !== "img") return;
        const src = (attribs.src ?? "").trim();
        if (!src) return;
        if (isInvisibleImage(attribs)) return;
        if (isTrackingAddress(src)) return;
        picked.src = src;
      }
    },
    { decodeEntities: true }
  );
  try {
    parser.write(text);
    parser.end();
  } catch {
    return picked.src;
  }
  return picked.src;
}

function toSanitizedFeedItems(xml: string, imageHosts: readonly string[]): RssFeedItem[] {
  const items: RssFeedItem[] = [];
  const seen = new Set<string>();
  for (const raw of parseFeedXml(xml)) {
    if (items.length >= ITEMS_PER_FEED_CAP) break;
    const url = sanitizeItemUrl(raw.link);
    if (!url) continue; // no valid http(s) link → the item is unusable, drop it whole
    const id = stableIdForUrl(url);
    if (seen.has(id)) continue;
    const title = sanitizeFeedText(raw.title, TITLE_CHAR_CAP);
    if (!title) continue;
    seen.add(id);
    // Fall back to a body image only when the feed carried no media tag at all. A media image
    // that exists but fails the host check must not open the door to a body image instead — the
    // feed named the story's art and got it wrong, so the story gets no art (reviewer blocker 5).
    const imageUrl = raw.imageUrl
      ? sanitizeImageUrl(raw.imageUrl, imageHosts)
      : sanitizeImageUrl(
          firstRealImgSrc(raw.contentFallback) ?? firstRealImgSrc(raw.summary),
          imageHosts
        );
    items.push({
      id,
      title,
      url,
      publishedAt: sanitizePublishedAt(raw.publishedAt),
      imageUrl,
      summary: sanitizeFeedText(raw.summary || raw.contentFallback, SUMMARY_CHAR_CAP)
    });
  }
  return items;
}

function resolveFeedUrl(source: NewsSourceEntry, topicKey: string | null): string | null {
  if (topicKey === null) return source.topFeedUrl;
  const url = source.topicFeeds[topicKey as keyof typeof source.topicFeeds];
  return url ?? null;
}

async function getFeed(fetchFn: typeof fetch, params: NewsFeedParams): Promise<RssFeedItem[]> {
  const source = sourceEntry(params.sourceKey);
  if (!source) {
    throw new Error(`news adapter: unknown source "${params.sourceKey}"`);
  }
  const feedUrl = resolveFeedUrl(source, params.topicKey);
  if (!feedUrl) {
    // The service only plans fetches for topics a source maps, so this is a caller bug — but
    // degrade to empty rather than 500 the whole overview over one feed.
    return [];
  }
  const response = await fetchFn(feedUrl, {
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }
  });
  if (!response.ok) {
    throw new Error(`news feed fetch failed (${response.status}) for ${params.sourceKey}`);
  }
  return toFeedItems(await response.text(), source);
}

// --- Adapter (the `ExternalSourceAdapter` implementation the dataset runtime dispatches to) --

// Single dataset: one cached entry per (sourceKey, topicKey) via the runtime's param-keyed cache.
// The key MUST be declared in manifest.ts externalSources[].datasets or the runtime throws
// "Unknown dataset" at request time and 500s the whole overview (recurring trap, see sports).
const NEWS_DATASET_KEYS = ["feed"] as const;
type NewsDatasetKey = (typeof NEWS_DATASET_KEYS)[number];

function isNewsDatasetKey(value: string): value is NewsDatasetKey {
  return (NEWS_DATASET_KEYS as readonly string[]).includes(value);
}

export function createRssDatasetAdapter(): ExternalSourceAdapter {
  return {
    async fetchDataset(
      datasetKey: string,
      params: Record<string, unknown>,
      ctx: ExternalSourceAdapterContext
    ): Promise<unknown> {
      if (!isNewsDatasetKey(datasetKey)) {
        throw new Error(`news adapter: unknown dataset "${datasetKey}"`);
      }
      return getFeed(ctx.fetchFn, params as unknown as NewsFeedParams);
    }
  };
}
