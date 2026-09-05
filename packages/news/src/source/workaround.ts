// packages/news/src/source/workaround.ts
// #2282 Task 1.4 — "workaround" identity for a saved source. A feed source whose feed host
// belongs to a different publisher than the saved canonical domain is a workaround feed (a
// mirror, an aggregator, a third-party RSS bridge). The DTO, the collector and compile all
// derive that flag here so the rule has exactly one home.

import { publisherDomainMatches } from "../personalization-domain.js";

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * True when `feedUrl` is served by a host that is not the publisher named by `canonicalDomain`
 * (in either direction: apex vs www, publisher vs its feeds subdomain). Null or unparseable
 * feed URLs are never a workaround. Suffix tricks (notexample.com, example.com.evil.com) never
 * count as the same publisher.
 */
export function isWorkaroundFeed(canonicalDomain: string, feedUrl: string | null): boolean {
  if (!feedUrl) return false;
  const feedHost = hostOf(feedUrl);
  if (!feedHost) return false;
  const publisher = canonicalDomain.toLowerCase();
  return !(publisherDomainMatches(publisher, feedHost) || publisherDomainMatches(feedHost, publisher));
}

/**
 * The fetch-host allowlist for a source written from its own URLs: every parseable host from
 * `urls` plus any bare `hosts`, lowercased and deduplicated, in first-seen order. Task 1.6
 * replaces this with the hosts confirmed during preview; until then a source may only be
 * fetched from the hosts its homepage and feed URL name.
 */
export function deriveFetchHosts(
  urls: readonly (string | null)[],
  hosts: readonly string[] = []
): string[] {
  const seen = new Set<string>();
  for (const host of hosts) {
    const lowered = host.trim().toLowerCase();
    if (lowered.length > 0) seen.add(lowered);
  }
  for (const url of urls) {
    if (!url) continue;
    const host = hostOf(url);
    if (host) seen.add(host);
  }
  return [...seen];
}
