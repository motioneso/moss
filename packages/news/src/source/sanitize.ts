// Plaintext sanitizers for feed-supplied text (spec: "Sanitization / security" —
// docs/superpowers/specs/2026-07-08-news-module.md). Same posture as sports'
// `sanitizeArticleBody`: after these run there are ZERO tags/tokens left, so the web layer
// rendering the strings as React text nodes can't emit any publisher-controlled markup.
// Exported so the unit suite can assert "zero surviving tags" against real feed fixtures.

export const TITLE_CHAR_CAP = 300;
export const SUMMARY_CHAR_CAP = 500;

// Decode the small set of HTML entities news feeds actually emit (named + numeric). Deliberately
// narrow: we're producing plaintext for text rendering, not a general HTML decoder. Copied from
// sports' espn-source.ts so both modules share one reviewed behavior.
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;|&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m: string, code: string) => codePointOr(Number(code), m))
    .replace(/&#x([0-9a-fA-F]+);/g, (m: string, code: string) =>
      codePointOr(parseInt(code, 16), m)
    );
}

// String.fromCodePoint throws RangeError on a value above U+10FFFF (or a lone surrogate), and a
// caller's catch would then drop the whole item over one malformed entity. An out-of-range
// codepoint keeps its literal source text instead — lossless and never throwing.
export function codePointOr(n: number, original: string): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return original;
  }
  return String.fromCodePoint(n);
}

/**
 * Feed text → capped plaintext. Handles both already-decoded text (htmlparser2 decodes entities,
 * so escaped HTML like `&lt;p&gt;` arrives as real tags) and double-encoded stragglers: strip
 * tags first, decode, strip residual angle brackets, collapse whitespace, cap at a word boundary.
 */
export function sanitizeFeedText(raw: string | undefined | null, cap: number): string {
  if (!raw) return "";
  const plain = decodeEntities(raw.replace(/<[^>]+>/g, " "))
    .replace(/<[^>]*>?/g, " ") // tags that only became tags after entity decoding
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= cap) return plain;
  const clipped = plain.slice(0, cap);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > cap * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/** Article link: must parse as http(s) or the caller drops the whole item. */
export function sanitizeItemUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Artwork URL: https only AND host must be on the source's declared allow-list, else null.
 * Defense in depth in front of the CSP img-src (which is derived from the same manifest hosts).
 */
export function sanitizeImageUrl(
  raw: string | undefined | null,
  imageHosts: readonly string[]
): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    if (!imageHosts.includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** RFC822 (RSS) / ISO-8601 (Atom) date → ISO instant, or null when absent/garbled. */
export function sanitizePublishedAt(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
