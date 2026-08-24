// #1572 Custom public news sources by team and league — URL-only source discovery.
// Mirrors packages/news/src/discovery/source-resolution.ts:90-266, minus the name/web-search
// path (spec restricts MVP to public URL submission only) and minus News' source-exclusion list
// (Sports has no equivalent concept).

import { randomUUID } from "node:crypto";

import { Parser } from "htmlparser2";

import type { DataContextDb } from "@moss/db";
import {
  discoverFeedUrls,
  extractListingHeadlines,
  normalizePublisherDomain,
  publisherDomainMatches,
  sampleFeedHeadlines,
  sanitizeFeedText,
  decideSourcePolicy,
  TITLE_CHAR_CAP,
  type NewsAiPort
} from "@moss/news";

import type { SportsSourceRecipe } from "./recipe.js";

export type SportsSafeFetchPort = (url: string) => Promise<
  | {
      readonly ok: true;
      readonly status: number;
      readonly finalUrl: string;
      readonly contentType: string | null;
      readonly body: string;
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "blocked"
        | "robots"
        | "rate_limited"
        | "http_error"
        | "challenge"
        | "timeout"
        | "network"
        | "not_https";
      readonly status?: number;
    }
>;

interface VerifiedSportsSourceCandidateBase {
  readonly candidateId: string;
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly sampleCount: number;
  readonly validationFingerprint: string;
  readonly confirmedFetchHosts: readonly string[];
}

export type VerifiedSportsSourceCandidate = VerifiedSportsSourceCandidateBase &
  (
    | {
        readonly feedUrl: string;
        readonly retrievalMethod: "feed";
        readonly recipe: null;
        readonly recipeFingerprint: null;
      }
    | {
        readonly feedUrl: null;
        readonly retrievalMethod: "scrape";
        readonly recipe: SportsSourceRecipe;
        readonly recipeFingerprint: string;
      }
  );

export type SportsSourceResolutionResult =
  | { status: "ok"; candidate: VerifiedSportsSourceCandidate }
  | { status: "rejected"; reason: "policy" | "invalid_input" | "unreachable" | "not_https" }
  | { status: "unavailable" };

export interface SportsPolicyVerdictRepo {
  readPolicyVerdict(
    scopedDb: DataContextDb,
    canonicalDomain: string,
    fingerprint: string
  ): Promise<"approved" | "rejected" | null>;
  upsertPolicyVerdict(
    scopedDb: DataContextDb,
    input: {
      canonicalDomain: string;
      fingerprint: string;
      verdict: "approved" | "rejected";
      ttlMs: number;
    }
  ): Promise<void>;
}

function htmlMetadata(html: string): {
  title: string;
  description: string;
  canonicalUrl: string | null;
} {
  let title = "";
  let inTitle = false;
  let description = "";
  let canonicalUrl: string | null = null;
  const parser = new Parser({
    onopentag(name, attributes) {
      const tag = name.toLowerCase();
      if (tag === "title") inTitle = true;
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
      if (name.toLowerCase() === "title") inTitle = false;
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

function acceptedFinalDomain(finalUrl: string, expectedDomain: string): string | null {
  const normalized = normalizePublisherDomain(finalUrl);
  if (!normalized.ok || !samePublisherIdentity(expectedDomain, normalized.domain)) return null;
  return normalized.domain;
}

export async function resolveSportsSourceInput(
  scopedDb: DataContextDb,
  deps: { fetch: SportsSafeFetchPort; ai: NewsAiPort; repo: SportsPolicyVerdictRepo },
  input: { rawUrl: string }
): Promise<SportsSourceResolutionResult> {
  const raw = input.rawUrl.trim();
  const requestedDomain = normalizePublisherDomain(raw);
  if (!requestedDomain.ok) {
    return {
      status: "rejected",
      reason: requestedDomain.reason === "non_https_scheme" ? "not_https" : "invalid_input"
    };
  }
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  const fetched = await deps.fetch(new URL(url).toString());
  if (!fetched.ok) {
    return {
      status: "rejected",
      reason: fetched.reason === "not_https" ? "not_https" : "unreachable"
    };
  }
  const fetchedUrl = new URL(fetched.finalUrl);
  if (!acceptedFinalDomain(fetched.finalUrl, requestedDomain.domain)) {
    return { status: "rejected", reason: "policy" };
  }

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
        return { status: "rejected", reason: "invalid_input" };
      }
    }
    const canonical = normalizePublisherDomain(homepageUrl);
    if (!canonical.ok) {
      return { status: "rejected", reason: "policy" };
    }
    if (fetchedUrl.toString() !== homepageUrl) {
      const homepage = await deps.fetch(homepageUrl);
      if (!homepage.ok) {
        return { status: "rejected", reason: "unreachable" };
      }
      const expectedHomepage = normalizePublisherDomain(homepageUrl);
      if (
        !expectedHomepage.ok ||
        !acceptedFinalDomain(homepage.finalUrl, expectedHomepage.domain)
      ) {
        return { status: "rejected", reason: "policy" };
      }
      homepageUrl = new URL("/", homepage.finalUrl).toString();
      homepageBody = homepage.body;
    }
    for (const discovered of discoverFeedUrls(homepageBody, homepageUrl)) {
      const feedResponse = await deps.fetch(discovered);
      if (!feedResponse.ok) continue;
      const expectedFeed = normalizePublisherDomain(homepageUrl);
      if (!expectedFeed.ok || !acceptedFinalDomain(feedResponse.finalUrl, expectedFeed.domain)) {
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
    return { status: "rejected", reason: "unreachable" };
  }
  const domain = normalizePublisherDomain(homepageUrl);
  if (!domain.ok) {
    return { status: "rejected", reason: "invalid_input" };
  }
  const metadata = htmlMetadata(homepageBody);
  const policy = await decideSourcePolicy(
    scopedDb,
    { ai: deps.ai, repo: deps.repo },
    {
      canonicalDomain: domain.domain,
      description: metadata.description,
      sampleHeadlines: headlines.map((item) => item.headline)
    }
  );
  if (policy.verdict === "unavailable") {
    return { status: "unavailable" };
  }
  if (policy.verdict === "rejected") {
    return { status: "rejected", reason: "policy" };
  }
  // Static/browser extraction must first produce and replay a validated declarative recipe.
  if (!feedUrl) return { status: "rejected", reason: "unreachable" };
  return {
    status: "ok",
    candidate: {
      candidateId: randomUUID(),
      label: metadata.title || domain.domain,
      canonicalDomain: domain.domain,
      homepageUrl,
      feedUrl,
      retrievalMethod: "feed",
      sampleCount: headlines.length,
      validationFingerprint: policy.fingerprint,
      recipe: null,
      recipeFingerprint: null,
      confirmedFetchHosts: [
        ...new Set([homepageUrl, feedUrl].map((value) => new URL(value).hostname))
      ]
    }
  };
}
