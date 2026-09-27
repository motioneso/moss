# 2026-09-27 — Merge the same story from different outlets (#2746, part of #2521)

## Root cause, confirmed

Today's news widget (`packages/news/src/web/today-widget.tsx`) just renders
`topStories[0]` as the lead and `topStories[1..3]` as the side list. It has no dedup logic
of its own, so the duplication is not a Today problem — it comes from the news module's
own data.

`/api/news/overview` has two code paths in `packages/news/src/news-service.ts`:

- `composePersonalized` (a fresh, unexpired compiled snapshot exists) reads from
  `compilePersonalizedNews` → `applyDeterministicFilters`
  (`packages/news/src/compilation/filters.ts:91-106`), which already collapses stories that
  share an exact canonical URL, then stories that share an exact normalized headline,
  across every source. Verified directly: feeding it 4 candidates from 4 different
  publishers, same URL and headline, returns 1.
- `composeOverview` (no snapshot yet — always true for a newly seeded or freshly installed
  account, and what a fresh dev/UAT/parity run hits) fetches each configured source's feed
  live and dedupes **only within one source's own feeds**
  (`packages/news/src/news-service.ts:315-316`, `seen` is declared inside the per-source
  loop). Across sources, nothing merges. This is called out in the code as a deliberate V1
  scope cut, and is pinned down by an existing test:
  `tests/unit/news-service.test.ts:374` — `"does NOT dedupe across sources (differing
  coverage of one event is a feature)"` — which feeds the same id/url to 4 sources and
  asserts 4 stories come back. Issue #2746 reverses that decision.

The parity fixture (`tests/uat/fixtures/espn-fixture-routes.ts:239-281`) serves the exact
same RSS body, with the exact same story links, to all 4 of the account's default sources.
A freshly seeded parity/UAT account has no compiled snapshot yet on first load, so it hits
`composeOverview`, and the one story from the fixture shows up once per source — the lead,
plus twice more in the side list. That matches gap-check item 5 exactly.

## Decision: which layer owns the merge

News, not Today. The "same story" signal (canonical URL, then normalized headline) already
exists in the News module and is already the accepted rule for the compiled path. The fix
is to apply that same rule in `composeOverview` too, so both code paths behave the same way
regardless of whether a compiled snapshot exists yet. Today keeps rendering `topStories` as
a plain list; it never needs to know what "same story" means.

## How "same story" is decided

Two exact tests, applied to the list of `NewsHeadline`s **after** they are ranked
(`rankStories(allInputs)`, `packages/news/src/news-service.ts:355`), so the highest-ranked
(most-recent / most editorially weighted) copy is the one that survives:

1. Same canonical URL — same normalization `filters.ts` already does: lowercase scheme,
   drop the fragment, strip `utm_*`/`fbclid`/`gclid` params, sort remaining params.
2. Failing that, same normalized headline — Unicode-normalized, lowercased, punctuation
   stripped to spaces, trimmed. This requires the **entire** headline to match after
   normalization, not a word or two in common, so "City council approves night-bus trial"
   and "City council raises parking fines" are never merged.

Nothing new is invented — both checks are the exact same normalization functions
`filters.ts` already uses (`safeCanonicalUrl`, `normalizedHeadline`), exported from there so
`news-service.ts` reuses them instead of a second copy of the same logic. First occurrence
in the ranked list wins; every later story matching it on either check is dropped.

## Which outlet wins, and whether others stay visible

Whichever outlet's copy sorts first under the existing `rankStories` order (editorial
weight — art, dek, source's own lead position — then recency, then discovery order) wins
and is what's shown. No new tie-break rule.

The other outlets' copies of the same story do not stay visible anywhere in the Today
widget. Checked `docs/superpowers/plans/2026-09-16-visual-parity.md` by section (grepped
for "same story", "merge", "also in", "outlet") — no mention. The mockup reference for
this gap (gap-check item 5) says only "distinct stories only," with no "also covered by"
affordance. Item 6's separate "Your news, in context" note is a different, already-tracked
gap and out of scope here. So: merge silently, no "also in X" text, no new field on
`NewsHeadline`.

This only touches `topStories` (Today's widget and the `/news` page's "All stories" list,
and `getTopHeadlinesForToday`, which reads `overview.topStories`). `sourceGroups` (the
per-source grouped view) is untouched — a story is still allowed to appear once under each
source's own group, matching the existing "same source, two topic feeds" dedup test at
`tests/unit/news-service.test.ts:358`.

## Scope check against the visual-parity plan

No dependency on anything the visual-parity plan owns. It doesn't cover news dedup logic at
all — it's shell/screen layout and capture tooling. Nothing here needs data or behavior
outside the News module.

## Tasks

1. **Export the normalization helpers.** In `packages/news/src/compilation/filters.ts`,
   export `safeCanonicalUrl` and `normalizedHeadline` (no behavior change, just visibility)
   so `news-service.ts` can import them.
2. **Merge across sources in `composeOverview`.** In `packages/news/src/news-service.ts`,
   after `const ranked = rankStories(allInputs)` (replacing the current inline
   `rankStories(allInputs).slice(0, TOP_STORIES_CAP)` on line 355), add a same-module
   helper:

   ```ts
   function mergeSameStoryAcrossSources(headlines: readonly NewsHeadline[]): NewsHeadline[] {
     const seenUrls = new Set<string>();
     const seenHeadlines = new Set<string>();
     return headlines.filter((headline) => {
       const url = safeCanonicalUrl(headline.url) ?? headline.url;
       const normalized = normalizedHeadline(headline.title);
       if (seenUrls.has(url) || seenHeadlines.has(normalized)) return false;
       seenUrls.add(url);
       seenHeadlines.add(normalized);
       return true;
     });
   }
   ```

   `topStories` becomes `mergeSameStoryAcrossSources(ranked).slice(0, TOP_STORIES_CAP)`.
   `sourceGroups` keeps using the unmerged `groups` data, unchanged.
3. **Update the app map.** Add a `features` entry to `packages/news/src/manifest.ts`
   (alongside `news.story_pictures`), e.g. `news.same_story_merge`: "The same story from
   different outlets is shown once, not once per outlet. Which outlet's version is kept
   follows the same order the page already ranks stories in."
4. **Tests (`tests/unit/news-service.test.ts`), written before the fix:**
   - Replace the existing test at line 374 (`"does NOT dedupe across sources..."`, which
     pins down the old, now-wrong behavior) with one asserting the new behavior: 3 sources
     (mirroring the parity fixture's 4) each returning a headline with the identical id/url,
     expect `overview.topStories` to have length 1.
   - New test: two sources return genuinely different stories that share a couple of
     words in their headlines (e.g. "City council approves night-bus trial" vs "City
     council raises parking fines"), assert `overview.topStories` has length 2 — proves the
     merge can't over-trigger on partial overlap.
   - Re-run the full file to confirm the "same source, two topic feeds" test at line 358
     and the "caps topStories at 6" test at line 311 still pass unchanged.

## Verification

```bash
pnpm --filter @moss/news test -- news-service.test.ts > /tmp/2746-unit.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`, with the two new/changed cases visible as passing in the log.

Full gate via the `verify-gate` skill before the PR, plus the parity runner
(`tests/uat/visual-parity`) on a disposable stack per the task brief, to show Today's news
area at 1440 and 375 with the fixture's story appearing once.

## Kill gate

If `composeOverview`'s per-source `seen` set turns out to be load-bearing for something the
tests above don't cover (checked by running the full `news-service.test.ts` file, not just
the new cases), stop and report to the coordinator rather than special-casing around it.
