import { createHash } from "node:crypto";

import { Parser } from "htmlparser2";
import { getDomain } from "tldts";

/**
 * #2237 slice 1 — the deterministic photo pass for custom-source stories (spec decisions 1-3).
 * Pure parsing and candidate rules only: no fetching, no storage. The reader drives the order
 * (feed media tags, then the article page's share image) and the photo store owns the download.
 */

export interface FoundPhoto {
  readonly url: string;
  readonly origin: "feed" | "share";
}

/** One media-bearing tag inside a feed item, in document order. */
export interface ParsedFeedMedia {
  readonly tag: "media:content" | "media:thumbnail" | "enclosure";
  readonly url: string;
  readonly type: string | null;
  readonly medium: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ParsedFeedItem {
  /** The item's article link, normalized the same way the feed parser normalizes it. */
  readonly link: string;
  readonly media: readonly ParsedFeedMedia[];
}

export const SPORTS_PHOTO_MAX_URL_LENGTH = 2048;
export const SPORTS_PHOTO_MIN_SHORT_SIDE = 64;

/**
 * Image hosts publishers commonly serve story photos from, when the photo does not sit on the
 * publisher's own registrable domain. Deliberately short and extended by ordinary code review
 * (spec decision 3) — never by a model, and never from anything a page or feed says.
 */
export const SPORTS_PHOTO_IMAGE_HOSTS: readonly string[] = [
  "i.guim.co.uk",
  "media.guim.co.uk",
  "ichef.bbci.co.uk",
  "static01.nyt.com",
  "cdn.vox-cdn.com",
  "i.imgur.com",
  "i.redd.it",
  "preview.redd.it",
  "external-preview.redd.it",
  "res.cloudinary.com",
  "imagedelivery.net",
  "cdn.sanity.io",
  "images.prismic.io",
  "images.squarespace-cdn.com",
  "substackcdn.com",
  "i0.wp.com",
  "i1.wp.com",
  "i2.wp.com"
];

// Path fragments that mark a site asset rather than a story photo (spec decision 3).
const NON_PHOTO_PATH_FRAGMENTS = ["favicon.ico", "logo", "default", "placeholder", "sprite"];

function parsedWidth(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isImageMedia(media: ParsedFeedMedia): boolean {
  if (media.medium && media.medium.toLowerCase() === "image") return true;
  return (media.type ?? "").toLowerCase().startsWith("image/");
}

/**
 * Feed media tags, in the order spec decision 1.1 fixes: `media:content` that declares an image,
 * then `media:thumbnail`, then an image `enclosure`. Within one tag name the largest declared
 * width wins; with no widths the first in document order wins.
 */
export function extractFeedPhoto(item: ParsedFeedItem): FoundPhoto | null {
  const pick = (candidates: readonly ParsedFeedMedia[]): ParsedFeedMedia | null => {
    let best: ParsedFeedMedia | null = null;
    for (const candidate of candidates) {
      if (!best) {
        best = candidate;
        continue;
      }
      if ((candidate.width ?? 0) > (best.width ?? 0)) best = candidate;
    }
    return best;
  };
  const content = pick(
    item.media.filter((media) => media.tag === "media:content" && isImageMedia(media))
  );
  const thumbnail = pick(item.media.filter((media) => media.tag === "media:thumbnail"));
  const enclosure = pick(
    item.media.filter(
      (media) => media.tag === "enclosure" && (media.type ?? "").toLowerCase().startsWith("image/")
    )
  );
  const chosen = content ?? thumbnail ?? enclosure;
  return chosen ? { url: chosen.url, origin: "feed" } : null;
}

/**
 * Media tags per item out of a raw RSS/Atom body. Sports parses these itself rather than
 * reaching into News' feed parser: News' public seam sanitizes the image URL away against an
 * empty host allow-list, and module isolation forbids importing its internals.
 */
export function parseFeedPhotoItems(xml: string): ParsedFeedItem[] {
  const items: ParsedFeedItem[] = [];
  let media: ParsedFeedMedia[] | null = null;
  let link = "";
  let atomLink = "";
  let inLink = false;
  let depth = 0;
  let itemDepth = -1;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        depth += 1;
        const tag = name.toLowerCase();
        if ((tag === "item" || tag === "entry") && media === null) {
          media = [];
          link = "";
          atomLink = "";
          itemDepth = depth;
          return;
        }
        if (media === null) return;
        if (tag === "media:content" || tag === "media:thumbnail" || tag === "enclosure") {
          const url = attribs["url"];
          if (url) {
            media.push({
              tag,
              url,
              type: attribs["type"] ?? null,
              medium: attribs["medium"] ?? null,
              width: parsedWidth(attribs["width"]),
              height: parsedWidth(attribs["height"])
            });
          }
          return;
        }
        if (tag === "link" && depth === itemDepth + 1) {
          const rel = attribs["rel"];
          if (attribs["href"]) {
            if ((!rel || rel === "alternate") && !atomLink) atomLink = attribs["href"];
          } else if (!link) {
            inLink = true;
          }
        }
      },
      ontext(text) {
        if (inLink) link += text;
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if ((tag === "item" || tag === "entry") && media !== null && depth === itemDepth) {
          items.push({ link: (link || atomLink).trim(), media });
          media = null;
          itemDepth = -1;
        }
        inLink = false;
        depth -= 1;
      }
    },
    { xmlMode: true }
  );
  try {
    parser.write(xml);
    parser.end();
  } catch {
    return items;
  }
  return items;
}

const SHARE_IMAGE_TAGS = ["og:image:secure_url", "og:image", "twitter:image"] as const;

/**
 * The article page's share image (spec decision 1.3). Relative URLs resolve against the page,
 * and only an `https:` result is returned — an `http:` share image is rejected outright rather
 * than silently upgraded, because the upgrade would be our guess, not the publisher's.
 */
export function extractShareImage(html: string, pageUrl: string): FoundPhoto | null {
  const found = new Map<string, string>();
  const parser = new Parser({
    onopentag(name, attribs) {
      if (name.toLowerCase() !== "meta") return;
      const key = (attribs["property"] ?? attribs["name"] ?? "").trim().toLowerCase();
      const content = attribs["content"]?.trim();
      if (!key || !content || found.has(key)) return;
      if ((SHARE_IMAGE_TAGS as readonly string[]).includes(key)) found.set(key, content);
    }
  });
  try {
    parser.write(html);
    parser.end();
  } catch {
    return null;
  }
  for (const tag of SHARE_IMAGE_TAGS) {
    const raw = found.get(tag);
    if (!raw) continue;
    try {
      const resolved = new URL(raw, pageUrl);
      if (resolved.protocol !== "https:") return null;
      return { url: resolved.toString(), origin: "share" };
    } catch {
      continue;
    }
  }
  return null;
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home")) return false;
  // An IP literal is never a publisher's photo host; the safe-fetch layer blocks private ranges
  // at request time, and rejecting all literals here keeps the rule readable.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  return host.includes(".");
}

function sameSite(photoHost: string, publisherHost: string): boolean {
  const photo = photoHost.toLowerCase();
  const publisher = publisherHost.toLowerCase();
  if (photo === publisher) return true;
  if (photo.endsWith(`.${publisher}`) || publisher.endsWith(`.${photo}`)) return true;
  const photoDomain = getDomain(photo);
  const publisherDomain = getDomain(publisher);
  return photoDomain !== null && photoDomain === publisherDomain;
}

function declaresTrackingPixel(url: URL): boolean {
  const dimension = (name: string): number | null => {
    const value = url.searchParams.get(name);
    if (value === null) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const width = dimension("w") ?? dimension("width");
  const height = dimension("h") ?? dimension("height");
  if (width === 1 && height === 1) return true;
  return /(^|[^0-9])1x1([^0-9]|$)/.test(url.pathname.toLowerCase());
}

/**
 * Every check spec decision 3 puts in front of a candidate URL. There is no minimum size here:
 * the 64 pixel short-side floor is enforced on the fetched image's real dimensions in the photo
 * store, because a URL's declared size is the publisher's claim, not a fact.
 */
export function isUsablePhotoCandidate(
  candidateUrl: string,
  options: { readonly publisherHost: string }
): boolean {
  if (candidateUrl.length > SPORTS_PHOTO_MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(candidateUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (!isPublicHostname(url.hostname)) return false;
  const host = url.hostname.toLowerCase();
  if (!sameSite(host, options.publisherHost) && !SPORTS_PHOTO_IMAGE_HOSTS.includes(host)) {
    return false;
  }
  const path = url.pathname.toLowerCase();
  if (NON_PHOTO_PATH_FRAGMENTS.some((fragment) => path.includes(fragment))) return false;
  if (declaresTrackingPixel(url)) return false;
  return true;
}

/** Stable per-owner file name for one source's photo: two stories sharing a photo share a copy. */
export function photoKey(sourceId: string, photoUrl: string): string {
  return createHash("sha256").update(`${sourceId}\0${photoUrl}`).digest("hex").slice(0, 32);
}
