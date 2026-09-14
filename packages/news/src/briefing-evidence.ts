import {
  NEWS_EVIDENCE_STORIES_MAX,
  NEWS_EVIDENCE_SUMMARY_MAX,
  type NewsBriefingEvidenceV1,
  type NewsBriefingEvidenceStoryV1,
  type NewsHeadline
} from "@moss/shared";

function sanitizeSummary(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, NEWS_EVIDENCE_SUMMARY_MAX);
}

/** Project personalized headlines to bounded briefing evidence. */
export function projectNewsBriefingEvidence(
  headlines: readonly NewsHeadline[],
  capturedAt: string,
  degraded: boolean
): NewsBriefingEvidenceV1 {
  const stories: NewsBriefingEvidenceStoryV1[] = [];
  for (const headline of headlines.slice(0, NEWS_EVIDENCE_STORIES_MAX)) {
    if (!headline.title || !headline.url) continue;
    let url: string;
    try {
      const protocol = new URL(headline.url).protocol;
      if (protocol !== "https:" && protocol !== "http:") continue;
      url = headline.url.slice(0, 2000);
    } catch {
      continue;
    }
    stories.push({
      id: headline.id.slice(0, 300),
      title: headline.title.slice(0, 300),
      sourceLabel: (headline.sourceLabel ?? "").slice(0, 200),
      sourceKey: (headline.sourceKey ?? "").slice(0, 200),
      url,
      publishedAt: headline.publishedAt,
      summary: sanitizeSummary(headline.summary ?? ""),
      imageUrl: headline.imageUrl ? headline.imageUrl.slice(0, 2000) : null,
      ...(headline.feedbackRef ? { feedbackRef: headline.feedbackRef.slice(0, 300) } : {})
    });
  }
  return { version: 1, capturedAt, degraded, stories };
}

/** Compact "Title — Source" facts, matching the existing tool output. */
export function newsFactsFor(headlines: readonly NewsHeadline[]): string[] {
  return headlines
    .slice(0, NEWS_EVIDENCE_STORIES_MAX)
    .map((headline) => `${headline.title} — ${headline.sourceLabel}`);
}
