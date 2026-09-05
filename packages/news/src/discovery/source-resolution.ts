import { randomUUID } from "node:crypto";
import { Parser } from "htmlparser2";

import type { DataContextDb } from "@moss/db";

import { normalizePublisherDomain, publisherDomainMatches } from "../personalization-domain.js";
import type { NewsPersonalizationRepository } from "../personalization-repository.js";
import { TITLE_CHAR_CAP, sanitizeFeedText } from "../source/sanitize.js";
import {
  discoverFeedUrls,
  extractListingHeadlines,
  sampleFeedHeadlines
} from "./feed-discovery.js";
import { decideSourcePolicy } from "./policy-validation.js";
import type {
  NewsAiPort,
  NewsSafeFetchFailure,
  NewsFetchPort,
  NewsSafeFetchPort,
  NewsSafeFetchResult,
  NewsWebSearchPort
} from "./ports.js";
import type { VerifiedSourceCandidate } from "./preview-store.js";

const KNOWN_LINK_SHORTENERS = new Set([
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "lnkd.in"
]);

const MAX_PUBLISHER_REDIRECT_HOPS = 5;

/**
 * Curated groups of registrable domains a human has separately confirmed are the same
 * publisher (for example a full rebrand onto an unrelated domain name). Empty until an entry
 * is added by hand — a page merely describing itself as its own address is not evidence of
 * common ownership with the domain the user typed, so it is never enough on its own (Ben,
 * 2026-09-04, review of PR 2246).
 */
const SAME_OWNER_ALIAS_GROUPS: readonly (readonly string[])[] = [];

function redirectNoteFor(fromDomain: string, toDomain: string): string {
  if (fromDomain === toDomain) {
    return `We followed the address you gave to ${toDomain}'s homepage, so that is the page we will use.`;
  }
  return `${fromDomain} sends visitors to ${toDomain}, so that is the site we will follow.`;
}

/** Whether every domain-matching rule in this file considers `a` and `b` the same registrable
 *  domain or a hand-confirmed alias of it. Exported for direct unit testing of the alias rule. */
export function isKnownSameOwnerAlias(
  groups: readonly (readonly string[])[],
  a: string,
  b: string
): boolean {
  return groups.some(
    (group) =>
      group.some((domain) => samePublisherIdentity(domain, a)) &&
      group.some((domain) => samePublisherIdentity(domain, b))
  );
}

function isLinkShortenerDomain(domain: string): boolean {
  for (const shortener of KNOWN_LINK_SHORTENERS) {
    if (samePublisherIdentity(shortener, domain)) return true;
  }
  return false;
}

export type SourceResolutionResult =
  | { status: "ok"; candidates: [VerifiedSourceCandidate] }
  | { status: "ambiguous"; candidates: VerifiedSourceCandidate[] }
  | {
      status: "rejected";
      /** `redirected`: the address led to a different site (not a policy call).
       *  `blocked`: the site's own robots rules refuse automatic access (not a reachability problem). */
      reason: "policy" | "redirected" | "invalid_input" | "unreachable" | "not_https" | "blocked";
    }
  | { status: "unavailable" };

/**
 * Turns a raw fetch failure into the reason shown to the caller. A site that deliberately blocks
 * automatic access through its robots rules is not "unreachable" — it answered, and said no. Every
 * other failure (rate limiting, an HTTP error, a bot challenge, a timeout, a network problem) is a
 * genuine reachability problem and stays "unreachable".
 */
function mapFetchFailure(
  reason: NewsSafeFetchFailure["reason"]
): "unreachable" | "not_https" | "blocked" {
  if (reason === "not_https") return "not_https";
  if (reason === "robots") return "blocked";
  return "unreachable";
}

type ResolutionRepo = Pick<
  NewsPersonalizationRepository,
  "listExclusions" | "readPolicyVerdict" | "upsertPolicyVerdict"
>;

function htmlMetadata(html: string): {
  title: string;
  description: string;
  canonicalUrl: string | null;
} {
  let title = "";
  let inTitle = false;
  let titleCaptured = false;
  let description = "";
  let canonicalUrl: string | null = null;
  const parser = new Parser({
    onopentag(name, attributes) {
      const tag = name.toLowerCase();
      if (tag === "title" && !titleCaptured) inTitle = true;
      if (tag === "link" && (attributes.rel ?? "").toLowerCase() === "canonical") {
        canonicalUrl = attributes.href ?? null;
      }
      if (tag === "meta") {
        const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
        if (key === "og:url") canonicalUrl = attributes.content ?? canonicalUrl;
        if (key === "description" || key === "og:description") {
          description = attributes.content ?? description;
        }
      }
    },
    ontext(text) {
      if (inTitle) title += text;
    },
    onclosetag(name) {
      if (name.toLowerCase() === "title" && inTitle) {
        inTitle = false;
        titleCaptured = true;
      }
    }
  });
  parser.end(html);
  return {
    title: sanitizeFeedText(title, TITLE_CHAR_CAP),
    description: sanitizeFeedText(description, 300),
    canonicalUrl
  };
}

function isFeed(contentType: string | null, body: string): boolean {
  return /(?:rss|atom|xml)/i.test(contentType ?? "") || /^\s*<(?:\?xml|rss|feed)\b/i.test(body);
}

function samePublisherIdentity(left: string, right: string): boolean {
  return (
    left === right || publisherDomainMatches(left, right) || publisherDomainMatches(right, left)
  );
}

/**
 * Why the fetched address cannot stand in for the requested publisher, or null when it can.
 * An excluded final domain is a policy call; landing on another site is just a redirect, and
 * the user should be told that rather than blamed for a policy breach (Ben, 2026-09-04).
 */
function finalDomainRejection(
  finalUrl: string,
  expectedDomain: string,
  exclusions: readonly string[]
): "policy" | "redirected" | null {
  const normalized = normalizePublisherDomain(finalUrl);
  if (!normalized.ok) return "redirected";
  if (exclusions.some((excluded) => publisherDomainMatches(excluded, normalized.domain))) {
    return "policy";
  }
  return samePublisherIdentity(expectedDomain, normalized.domain) ? null : "redirected";
}

/**
 * Whether a fetch can still be trusted as that publisher's own move, and if so, whether the
 * address actually changed and the note to show the user for it. Deterministic only — no model
 * call (Ben, 2026-09-04). `requestedUrl` is the exact address this particular fetch was asked
 * for, so a same-domain move (a www prefix, or a specific page sent to its own homepage) is
 * still recognized as a move even though ownership never changed.
 */
function evaluatePublisherRedirect(
  fetched: NewsSafeFetchResult,
  requestedUrl: string,
  requestedDomain: string,
  exclusions: readonly string[]
):
  | { accepted: true; redirected: boolean; note: string | null }
  | { accepted: false; reason: "policy" | "redirected" } {
  const outcome = finalDomainRejection(fetched.finalUrl, requestedDomain, exclusions);
  if (outcome === "policy") return { accepted: false, reason: "policy" };

  if (outcome === null) {
    if (fetched.finalUrl === requestedUrl) return { accepted: true, redirected: false, note: null };
    // Same registrable domain (including a subdomain move like adding "www"), but the address
    // itself changed — still a real move, just one that never changed ownership.
    const finalDomain = normalizePublisherDomain(fetched.finalUrl);
    const toDomain = finalDomain.ok ? finalDomain.domain : requestedDomain;
    return { accepted: true, redirected: true, note: redirectNoteFor(requestedDomain, toDomain) };
  }

  // outcome === "redirected": a genuine cross-domain redirect. Accept only if every check passes.
  const finalDomain = normalizePublisherDomain(fetched.finalUrl);
  if (!finalDomain.ok) return { accepted: false, reason: "redirected" };

  if ((fetched.hopCount ?? 0) > MAX_PUBLISHER_REDIRECT_HOPS) {
    return { accepted: false, reason: "redirected" };
  }

  if (isLinkShortenerDomain(finalDomain.domain) || isLinkShortenerDomain(requestedDomain)) {
    return { accepted: false, reason: "redirected" };
  }

  // A page describing itself as its own address proves nothing about the domain the user
  // typed — any site's own canonical or og:url tag names itself. The only accepted move onto
  // a genuinely different registrable domain is one a human has separately confirmed and
  // added to SAME_OWNER_ALIAS_GROUPS above; without that, the move is refused rather than
  // trusted on the destination's say-so.
  if (!isKnownSameOwnerAlias(SAME_OWNER_ALIAS_GROUPS, requestedDomain, finalDomain.domain)) {
    return { accepted: false, reason: "redirected" };
  }

  return {
    accepted: true,
    redirected: true,
    note: redirectNoteFor(requestedDomain, finalDomain.domain)
  };
}

export async function resolveSourceInput(
  scopedDb: DataContextDb,
  deps: {
    fetch: NewsSafeFetchPort;
    /** #2282: options-capable fetch for subreddit resolution (task 1.6); optional so fakes stay small. */
    fetchWithOptions?: NewsFetchPort;
    search: NewsWebSearchPort;
    ai: NewsAiPort;
    repo: ResolutionRepo;
  },
  input: { raw: string; hasWebSearch: boolean }
): Promise<SourceResolutionResult> {
  const raw = input.raw.trim();
  const exclusions = (await deps.repo.listExclusions(scopedDb)).map((item) => item.canonicalDomain);
  const normalized = normalizePublisherDomain(raw);
  const looksLikeUrl =
    /^[a-z][a-z0-9+.-]*:/i.test(raw) || (!raw.includes(" ") && raw.includes("."));
  if (looksLikeUrl) {
    if (!normalized.ok) {
      return {
        status: "rejected",
        reason: normalized.reason === "non_https_scheme" ? "not_https" : "invalid_input"
      };
    }
    if (exclusions.some((domain) => publisherDomainMatches(domain, normalized.domain))) {
      return { status: "rejected", reason: "policy" };
    }
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    const resolved = await verifyPublisher(scopedDb, deps, url, exclusions);
    if (resolved.status !== "candidate") return resolved.result;
    return { status: "ok", candidates: [resolved.candidate] };
  }

  if (!input.hasWebSearch) return { status: "unavailable" };
  const search = await deps.search.search(
    scopedDb,
    `"${sanitizeFeedText(raw, 80)}" news publisher official site`,
    { limit: 5 }
  );
  const candidates: VerifiedSourceCandidate[] = [];
  const seen = new Set<string>();
  let providerUnavailable = false;
  for (const result of search.results) {
    if (candidates.length >= 3) break;
    const domain = normalizePublisherDomain(result.url);
    if (!domain.ok || seen.has(domain.domain)) continue;
    seen.add(domain.domain);
    if (exclusions.some((excluded) => publisherDomainMatches(excluded, domain.domain))) continue;
    const resolved = await verifyPublisher(scopedDb, deps, result.url, exclusions);
    if (resolved.status === "candidate") candidates.push(resolved.candidate);
    else if (resolved.result.status === "unavailable") providerUnavailable = true;
  }
  if (candidates.length === 1) return { status: "ok", candidates: [candidates[0]!] };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return providerUnavailable
    ? { status: "unavailable" }
    : { status: "rejected", reason: "unreachable" };
}

async function verifyPublisher(
  scopedDb: DataContextDb,
  deps: {
    fetch: NewsSafeFetchPort;
    ai: NewsAiPort;
    repo: ResolutionRepo;
  },
  rawUrl: string,
  exclusions: readonly string[]
): Promise<
  | { status: "candidate"; candidate: VerifiedSourceCandidate }
  | { status: "failed"; result: SourceResolutionResult }
> {
  const requestedDomain = normalizePublisherDomain(rawUrl);
  if (!requestedDomain.ok) {
    return { status: "failed", result: { status: "rejected", reason: "invalid_input" } };
  }
  const requestedUrl = new URL(rawUrl).toString();
  const fetched = await deps.fetch(requestedUrl);
  if (!fetched.ok) {
    return {
      status: "failed",
      result: { status: "rejected", reason: mapFetchFailure(fetched.reason) }
    };
  }
  const fetchedUrl = new URL(fetched.finalUrl);
  const redirectDecision = evaluatePublisherRedirect(
    fetched,
    requestedUrl,
    requestedDomain.domain,
    exclusions
  );
  if (!redirectDecision.accepted) {
    return { status: "failed", result: { status: "rejected", reason: redirectDecision.reason } };
  }
  // Whether ANY move away from the exact address the user gave has happened yet, across both
  // this fetch and (below) a same-site page-to-homepage move. Once true, the model is never
  // called for this source — see the allowModelCall use below (Ben, 2026-09-04).
  let redirected = redirectDecision.redirected;
  let redirectNote = redirectDecision.note;
  let homepageUrl = new URL("/", fetchedUrl).toString();
  let homepageBody = fetched.body;
  let feedUrl: string | null = null;
  let headlines: { headline: string; url: string; publishedAt?: string | null }[] = [];

  if (isFeed(fetched.contentType, fetched.body)) {
    feedUrl = fetchedUrl.toString();
    headlines = sampleFeedHeadlines(fetched.body, 10);
  } else {
    const initialMetadata = htmlMetadata(fetched.body);
    if (initialMetadata.canonicalUrl) {
      try {
        homepageUrl = new URL("/", new URL(initialMetadata.canonicalUrl, fetchedUrl)).toString();
      } catch {
        return { status: "failed", result: { status: "rejected", reason: "invalid_input" } };
      }
    }
    const canonical = normalizePublisherDomain(homepageUrl);
    if (!canonical.ok) {
      return { status: "failed", result: { status: "rejected", reason: "redirected" } };
    }
    if (exclusions.some((domain) => publisherDomainMatches(domain, canonical.domain))) {
      return { status: "failed", result: { status: "rejected", reason: "policy" } };
    }
    if (fetchedUrl.toString() !== homepageUrl) {
      const homepage = await deps.fetch(homepageUrl);
      if (!homepage.ok) {
        return {
          status: "failed",
          result: { status: "rejected", reason: mapFetchFailure(homepage.reason) }
        };
      }
      // The page named this homepage itself (its own canonical or og:url tag), so checking the
      // fetch result against that same self-declared address would always pass. The address the
      // user actually typed is the only thing worth checking ownership against.
      const homepageDecision = evaluatePublisherRedirect(
        homepage,
        homepageUrl,
        requestedDomain.domain,
        exclusions
      );
      if (!homepageDecision.accepted) {
        return {
          status: "failed",
          result: { status: "rejected", reason: homepageDecision.reason }
        };
      }
      redirected = true;
      const finalHomepageDomain = normalizePublisherDomain(homepage.finalUrl);
      redirectNote = redirectNoteFor(
        requestedDomain.domain,
        finalHomepageDomain.ok ? finalHomepageDomain.domain : requestedDomain.domain
      );
      homepageUrl = new URL("/", homepage.finalUrl).toString();
      homepageBody = homepage.body;
    }
    for (const discovered of discoverFeedUrls(homepageBody, homepageUrl)) {
      const feedResponse = await deps.fetch(discovered);
      if (!feedResponse.ok) continue;
      const expectedFeed = normalizePublisherDomain(homepageUrl);
      if (
        !expectedFeed.ok ||
        finalDomainRejection(feedResponse.finalUrl, expectedFeed.domain, exclusions)
      ) {
        continue;
      }
      const samples = sampleFeedHeadlines(feedResponse.body, 10);
      if (samples.length > 0) {
        feedUrl = feedResponse.finalUrl;
        headlines = samples;
        break;
      }
    }
    if (!feedUrl) headlines = extractListingHeadlines(homepageBody, homepageUrl, 10);
  }
  if (headlines.length === 0) {
    return { status: "failed", result: { status: "rejected", reason: "unreachable" } };
  }
  const domain = normalizePublisherDomain(homepageUrl);
  if (!domain.ok) {
    return { status: "failed", result: { status: "rejected", reason: "invalid_input" } };
  }
  const metadata = htmlMetadata(homepageBody);
  const policy = await decideSourcePolicy(
    scopedDb,
    { ai: deps.ai, repo: deps.repo },
    {
      canonicalDomain: domain.domain,
      description: metadata.description,
      sampleHeadlines: headlines.map((item) => item.headline)
    },
    // A followed redirect must stay fully rule-based end to end — no model call anywhere on
    // that path. An unseen domain reads as "unavailable" rather than invoking the model
    // (Ben, 2026-09-04, review of PR 2246).
    { allowModelCall: !redirected }
  );
  if (policy.verdict === "unavailable") {
    return { status: "failed", result: { status: "unavailable" } };
  }
  if (policy.verdict === "rejected") {
    return { status: "failed", result: { status: "rejected", reason: "policy" } };
  }
  return {
    status: "candidate",
    candidate: {
      candidateId: randomUUID(),
      label: metadata.title || domain.domain,
      canonicalDomain: domain.domain,
      homepageUrl,
      feedUrl,
      retrievalMethod: feedUrl ? "feed" : "scrape",
      sampleCount: headlines.length,
      validationFingerprint: policy.fingerprint,
      redirectNote
    }
  };
}
