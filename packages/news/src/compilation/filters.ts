import { publisherDomainMatches } from "../personalization-domain.js";

import type { NewsCandidate } from "./candidates.js";

export type { NewsCandidate } from "./candidates.js";

const PREFERRED_AGE_MS = 48 * 60 * 60 * 1_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const FUTURE_TOLERANCE_MS = 15 * 60 * 1_000;

function domainAllowed(domain: string, approved: ReadonlySet<string>): boolean {
  return [...approved].some(
    (item) => publisherDomainMatches(item, domain) || publisherDomainMatches(domain, item)
  );
}

export function safeCanonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

function groupKey(candidate: NewsCandidate): string {
  return candidate.origin === "topic_search"
    ? `topic:${[...candidate.matchedTopics].sort().join("|")}`
    : `source:${candidate.canonicalDomain}`;
}

export function normalizedHeadline(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function priority(candidate: NewsCandidate): number {
  if (candidate.origin === "preferred_source") return 2;
  if (candidate.origin === "curated") return 1;
  return 0;
}

export function applyDeterministicFilters(
  candidates: NewsCandidate[],
  input: { exclusions: string[]; approvedDomains: Set<string>; now: Date }
): NewsCandidate[] {
  const now = input.now.getTime();
  const eligible = candidates.flatMap((candidate) => {
    if (!domainAllowed(candidate.canonicalDomain, input.approvedDomains)) return [];
    if (input.exclusions.some((item) => publisherDomainMatches(item, candidate.canonicalDomain))) {
      return [];
    }
    const url = safeCanonicalUrl(candidate.url);
    const urlDomain = url ? new URL(url).hostname : null;
    const published = Date.parse(candidate.publishedAt);
    if (
      !url ||
      !urlDomain ||
      input.exclusions.some((item) => publisherDomainMatches(item, urlDomain)) ||
      !Number.isFinite(published) ||
      published > now + FUTURE_TOLERANCE_MS ||
      now - published > MAX_AGE_MS
    ) {
      return [];
    }
    return [{ ...candidate, url, publishedAt: new Date(published).toISOString() }];
  });

  const recentCounts = new Map<string, number>();
  for (const candidate of eligible) {
    if (now - Date.parse(candidate.publishedAt) <= PREFERRED_AGE_MS) {
      const key = groupKey(candidate);
      recentCounts.set(key, (recentCounts.get(key) ?? 0) + 1);
    }
  }
  const ageFiltered = eligible.filter(
    (candidate) =>
      now - Date.parse(candidate.publishedAt) <= PREFERRED_AGE_MS ||
      (recentCounts.get(groupKey(candidate)) ?? 0) < 3
  );

  const chosenByUrl = new Map<string, NewsCandidate>();
  for (const candidate of ageFiltered) {
    const current = chosenByUrl.get(candidate.url);
    if (!current || priority(candidate) > priority(current)) {
      chosenByUrl.set(candidate.url, candidate);
    }
  }
  const chosenByHeadline = new Map<string, NewsCandidate>();
  for (const candidate of chosenByUrl.values()) {
    const key = normalizedHeadline(candidate.headline);
    const current = chosenByHeadline.get(key);
    if (!current || priority(candidate) > priority(current)) {
      chosenByHeadline.set(key, candidate);
    }
  }
  return [...chosenByHeadline.values()];
}
