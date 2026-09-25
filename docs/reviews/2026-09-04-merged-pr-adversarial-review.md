# Adversarial review of September 4, 2026 merges

Reviewed in `~/Jarv1s`, using September 4 in America/Los_Angeles. **Six primary findings: one P1 and five P2. Two P2 findings are in the running production source.** This is a review, not a fix or deployment approval.

## Exact scope and deployment evidence

| Target                             | Reviewed revision                                                                       | Meaning                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Before today                       | `ece7de311582f669eb4e8f92b1f929cb8e5b5c9a`                                              | Parent of today's first Pacific-time merge                                       |
| Local dev, initial snapshot        | `2109320c6165062b57067515ddfd017f91dd458b`                                              | Includes locally integrated branches still open on GitHub                        |
| Local dev, final reviewed snapshot | `bedfb038209035b12a036a51437def53df7cb55a`                                              | Adds PR #2244, which landed during this review                                   |
| GitHub main                        | `06635eba5a187831eb65e739236fda3b5e1ca324`                                              | Thirteen PRs merged today at the review cutoff                                   |
| Running production source          | Matches `d4bf3f24f04d247f46315dcaae46ba37f50dd185` across today's changed runtime paths | Includes #2210, #2212 and #2214; later main merges are not in this running image |

Production container `Moss` started at `2026-09-04T11:01:54Z`. Its image was built at `10:45:16Z`, digest `sha256:81f136b568b6297c9f31f1484d11f58c7031041cd853b30ccc2793f833516fa3`. The image has no revision label. Read-only hashes of the union of 161 initially changed paths showed no runtime-file differences from `d4bf3f24f`; differences were confined to docs/tests. This establishes the source relevant to this review, not an exact full-image Git attestation. No production data or settings were changed.

### PR inventory

| PR    | Area                                                                | Main | Local dev           | Running prod |
| ----- | ------------------------------------------------------------------- | ---- | ------------------- | ------------ |
| #2210 | Sports/news feedback, college catalog, Reddit sources, source icons | Yes  | Yes                 | Yes          |
| #2212 | Timezone combobox, settings refinements                             | Yes  | Yes                 | Yes          |
| #2214 | Chat thinking/status/feedback presentation                          | Yes  | Yes                 | Yes          |
| #2215 | Email-address-first account connection                              | Yes  | Yes                 | No           |
| #2216 | Model Chat toggle                                                   | Yes  | Yes                 | No           |
| #2217 | Browser weather location                                            | Yes  | Yes                 | No           |
| #2218 | News redirect rejection wording                                     | Yes  | Yes                 | No           |
| #2221 | News settings and AP feeds                                          | Yes  | Yes, branch version | No           |
| #2222 | Fold Chat settings into Assistant & AI                              | Yes  | Yes                 | No           |
| #2223 | Web-push design spec only                                           | Yes  | Yes                 | No           |
| #2224 | Agentation HTTPS endpoint                                           | Yes  | Yes                 | No           |
| #2225 | Product polish and immediate news feedback                          | Yes  | Yes                 | No           |
| #2226 | Native web-search design spec only                                  | Yes  | Yes                 | No           |
| #2219 | Model release-date ordering                                         | No   | Yes                 | No           |
| #2220 | Settings section deep links                                         | No   | Yes                 | No           |
| #2231 | News discovery engine wiring and error logging                      | No   | Yes                 | No           |
| #2233 | Login dialog StrictMode handling                                    | No   | Yes                 | No           |
| #2242 | Provider token probe and lifecycle reconciliation                   | No   | Yes                 | No           |
| #2243 | Robots redirects, source labels and blocked-site wording            | No   | Yes                 | No           |
| #2244 | Email structured engine selection and Google diagnostics            | No   | Yes, late merge     | No           |

#2206 was merged September 3 Pacific and is the baseline, not part of today's changes. Main and local dev were reviewed separately because their files differ. Later merges beyond the named snapshots are outside this report.

## Standards and invariant findings

### S1 — P2: College team abbreviations are not unique identities

**PR #2210. Affects local dev, main and running production.**

Changed entry point: [espn-source.ts:273](https://github.com/motioneso/moss/blob/015b85bb01de8d5d5fb44bfd25b226998a18f63a/packages/sports/src/source/espn-source.ts#L273), together with the new college catalog. `listTeams` still assigns `teamKey` from the abbreviation at lines 290–300. ESPN's newly supported NCAA baseball list contains Pacific Lutheran Lutes (`129700`) before Pacific Tigers (`413`), both abbreviated `PAC`.

Choosing **Pacific Tigers** persists `ncaa-baseball/pac`. `SportsService.getOverview` uses the first matching `teamKey` to recover `sourceTeamId`, so it selects **Pacific Lutheran** for downstream requests. Source assignments repeat the same first-match lookup, and the two teams cannot be followed independently. This is an identity-contract failure, not just a duplicate React key. Read-only vendor results also contain several other abbreviation collisions.

**Proof:** `repro-college-identity.mts` runs the actual ESPN adapter against the two recorded vendor rows and the exact persisted-follow lookup. Chosen ID is `413`; resolved ID is `129700`. Existing 113 focused sports/source tests pass without covering collisions.

**Fix:** use an unambiguous identity consistently through the newly supported teams, follows, scoreboards, standings and source assignments; preserve compatibility for existing follows. Picking a different duplicate in one lookup does not fix the contract.

### S2 — P1: Raw AI provider response text escapes into error logs

**PR #2231, commit `113629265` (issue #2229). Affects local dev only.**

[generate-structured.ts:185–195](https://github.com/motioneso/moss/blob/113629265/packages/ai/src/structured/generate-structured.ts#L185) now logs `error.message` for every non-parse adapter exception. The comment claiming the message is already redacted is incorrect: the preceding credential-decryption catch protects a different operation and does not sanitize adapter errors.

The real `HttpApiAdapter.generateStructured` calls `response.json()`. A malformed successful response makes Node's JSON parser include raw body text in its `SyntaxError.message`. A fake response containing `PRIVATE_SENTINEL` produced an application log containing `Unexpected token 'P', "PRIVATE_SENTINEL" is not valid JSON`. Private response content can therefore cross the logging boundary. This is a new disclosure path; it does not establish that real credentials have already leaked.

**Proof:** `repro.mts` uses the real orchestrator and HTTP adapter, mocked repository and mocked HTTP only. No database, credentials or real provider calls are involved.

**Fix:** retain structured error classification or allowlisted diagnostic codes. Do not log arbitrary exception messages. Add the malformed-response regression to the retained test suite.

## Specification and behavior findings

### B1 — P2: Response style disappears on the default settings view

**PR #2222. Affects local dev and main; not running production.**

[settings-ai-pane.tsx:221–232](https://github.com/motioneso/moss/blob/db54907fed1794faf04a55e66f49418e0920dab6/apps/web/src/settings/settings-ai-pane.tsx#L221) puts Response style inside the guided-persona branch. Persona mode initializes to `authored`, and the previous Chat settings page was removed.

Open Assistant & AI normally: Concise/Balanced/Detailed is absent. It appears only after choosing the unrelated “Use guided dials” persona mode. The PR promises to move this independent saved chat preference into Assistant & AI, and the app map describes it without that restriction. Switching modes does not itself destroy persona text; the defect is that the sole control is hidden for the default/authored view.

**Proof:** the real-component regression fails to find “Response style”; eight pre-existing persona/archive tests pass. **Fix:** place this independent setting outside the persona-mode conditional.

### B2 — P2: Empty search results leave timezone keyboard selection stuck

**PR #2212. Affects local dev, main and running production.**

[combobox.tsx:95–97](https://github.com/motioneso/moss/blob/d6ac9255313bc61f75f2df603259381cdace5648/packages/ui/src/combobox.tsx#L95) sets the active index to `-1` on ArrowDown with zero matches. The effect at lines 73–75 clamps only the upper bound, preserving the negative index when results return. Enter then reads `filtered[-1]`.

**Reproduce:** open Time zone → type a query with no matches → ArrowDown → replace the query with `tok` → Enter. Tokyo is the sole visible result, but the old timezone remains selected and the picker stays open. Mouse selection or another arrow key recovers it. This violates the PR's explicit keyboard-navigation requirement.

**Proof:** a DOM test gets Europe/London instead of Asia/Tokyo; all four existing combobox tests pass. **Fix:** clamp both bounds and handle the empty list before moving selection.

### B3 — P2: Negative feedback drains the news carousel instead of replacing stories

**PR #2225. Affects local dev and main; not running production.**

[story-feedback-menu.tsx:19–25](https://github.com/motioneso/moss/blob/d74cc844313ea34e2cee30643ec05e76a9456d6c/packages/news/src/web/story-feedback-menu.tsx#L19) filters cached `topStories` and `rankedStories` independently. The success handler no longer invalidates overview, and nothing refills `topStories` from the retained ranked pool. The PR explicitly promises immediate replacement.

With eight ranked stories and six top stories, dismissing two hero stories leaves six ranked candidates but only four carousel slides, although the carousel can show five. Continued dismissals remove the hero altogether while other ranked stories remain. This is not just delayed server compilation: the client has usable candidates and does not promote them. The page has no polling; window-focus refetch is disabled.

**Proof:** the test renders real NewsPage and feedback menus with React Query and mocked HTTP, saves two negative-feedback reasons, and fails with four slides instead of five. Three existing feedback tests pass. **Fix:** refill the top-story slice from the remaining ranked pool while preserving the dismissal; an immediate blind refetch can resurrect a stale server snapshot.

### B4 — P2: The email fix also disables persistent execution for ordinary Anthropic chat

**PR #2244, commit `5e8c029de`, integrated during this review. Affects final local dev only.**

[engine-selection.ts:177–180](https://github.com/motioneso/moss/blob/5e8c029de/packages/chat/src/live/engine-selection.ts#L177) now excludes every Anthropic `non_interactive` call from persistent-runtime selection. This mode does not identify email extraction: it is also the normal provider default, set by `AiRepository.createProvider` at lines 421–425 and migrations 0172/0173. `ChatSessionManager` forwards that database value unchanged for ordinary chat.

For an ordinary default Anthropic provider with persistent runtime enabled, the selector now returns `ClaudePrintChatEngine` and never consults the warm pool. Previously the enabled persistent flag took precedence. Email extraction needs a structured-capable engine, but the fix unintentionally removes persistent execution from normal sessions too.

**Proof:** the actual selector, with a ready fake pool and ordinary session key, selects the print engine with zero admissions. The changed test now omits the realistic execution mode when testing pool admission. Eleven late-merge unit tests pass.

**Fix:** distinguish the structured-call requirement at its call boundary instead of inferring it from a provider execution mode shared by normal chat. Chat still replies through the print engine; this finding concerns lost persistent/warm-pool behavior, not a total chat outage. Flag-off deployments and explicitly interactive providers are unaffected.

## Lower-priority observations

- **P3, #2219, dev only:** `model-discovery.ts:197–199` accepts any finite positive epoch then calls `toISOString()` without checking the resulting Date. A successful list containing one `created: 1e20` entry discards the entire catalog, including valid entries, and caches the empty result for an hour. `repro.mts` demonstrates this. Invalid dates should become `null` per the function's stated contract. This does not delete existing API-key models.
- **App-map mismatch, #2210:** `sports.subreddit_sources` promises stickied posts are skipped, while the RSS implementation has no sticky-status filter. Correct that promise or implement a supported filter; no live pinned-post incident was established. App-map truthfulness is an explicit repository requirement.
- **Missing promised affordance, #2222:** the PR promises a microphone/transcription setup note in Assistant & AI, but it is absent after the old Voice input section was removed. Admin transcription configuration remains available; this is not broken transcription.

A cross-HOME provider-cache collision was reproducible at helper level, but was not promoted to a finding because a concrete affected supported login path was not established. The normal OAuth token change does change the cache key. Main's AP image CSP correctly matches the API's dynamically derived hosts; no CSP mismatch was found.

## Validation and review limits

- **275 existing tests passed:** 136 AI/provider/news/safe-fetch checks; 113 sports/Reddit/icon checks; 15 original UI checks in the reproduction harnesses; 11 engine-selection/Google-write checks.
- **Three new regression assertions failed as expected:** hidden response style, timezone keyboard selection and news carousel replacement. These are targeted behavioral proofs, not claims that the full existing suite fails.
- The root `pnpm exec tsc --noEmit` check passed. It is not the full `pnpm typecheck` script or the foundation gate.
- Actual-module assertion scripts reproduced the log disclosure, wrong college identity, persistent-runtime bypass and malformed release-date handling without DB access.
- Reviewed authorization-before-cache on source icons, existing owner RLS, safe-fetch/DNS/redirect handling, migration placement, AI credential boundaries, settings/onboarding contracts, manifests, and UI interactions. No additional confirmed new SSRF or cross-owner bypass was found in the reviewed paths.
- No foundation gate, DB-backed tests, live UI mutations, production deployment, PR comments or product fixes were performed. Read-only vendor requests checked source-feed viability and college identity collisions. Unit checks do not establish full live end-to-end behavior.

Evidence and runnable harnesses are in `/tmp/moss-adversarial-20260904/`, including `standards.md`, `spec.md`, `prod-source-comparison.json`, `repro.mts`, `repro-college-identity.mts`, `repro-persistent-selection.mts`, `spec-*.test.tsx` and the test logs. Run the assertion scripts from `~/Jarv1s` using `pnpm exec tsx <script>`. Run the three UI regressions with:

```sh
pnpm exec vitest run --config /tmp/moss-adversarial-20260904/spec-vitest.config.ts --reporter=dot
```

That UI command is expected to fail on the reviewed implementation. Scratch artifacts are temporary; this report is the durable review record.

Standards axis: two primary findings, worst P1 raw provider-output logging. Spec/behavior axis: four primary findings, all P2.
