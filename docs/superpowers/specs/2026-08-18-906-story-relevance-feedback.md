# Story relevance feedback for News and Sports (#906)

**Status:** APPROVED by Ben 2026-08-18  
**Issue:** #906  
**Builds on:** #526 unified priority model and #527 usefulness feedback signals  
**Primary verification seam:** story feedback submission through refreshed News/Sports overview

## Problem Statement

News and Sports sometimes surface routine stories that a user does not care about. Today the user
cannot tell Moss that a story is uninteresting, explain why, or make that explanation affect future
story collection and selection. The same unwanted subjects can therefore keep returning on Today and
on the dedicated News and Sports pages.

A hard topic block is also wrong. A user who does not want ordinary Yankees coverage still needs to
see a historic championship result or a serious event that becomes major general news. A user who is
usually uninterested in New York still needs to see a terrorist incident or other urgent,
life-changing event there. The system needs a strong preference with an explicit, evidence-backed
exception—not an absolute filter and not a vague promise to "be intelligent."

## Solution

Add a discreet three-dot menu to News and Sports story cards on Today and on their module pages. The
menu offers **More like this** and **Less like this**. More like this records a positive preference
from the selected story. Less like this opens a compact text field where the user explains why; that
reason is required so Moss can apply the preference to future story collection and selection.

After feedback is saved, the selected story disappears immediately and the surface fills its place
from the next eligible story already available. The owning module then refreshes its story selection
using the active preference. Ordinary matching stories are suppressed before publication to the
user-facing story set. A matching story survives only when a shared relevance policy classifies it
as exceptional from explicit event evidence plus editorial-prominence evidence.

News and Sports use the same usefulness-feedback contract and the same relevance-policy functions,
but neither module imports the other's implementation or reads the other's tables. Each module owns
its source retrieval, candidate metadata, refresh behavior, story presentation, and Settings
surface.

Active feedback appears in the owning module's Settings page with enough context to recognize it.
The user can edit a Less like this reason or remove either kind of feedback. Editing or removing a
preference triggers reselection so the visible behavior catches up promptly.

## User Stories

1. As a News user, I want to mark a story as Less like this, so that routine stories I do not care
   about stop occupying my News page.
2. As a Sports user, I want to mark a story as Less like this, so that routine coverage of teams,
   leagues, or subjects I do not follow stops displacing useful stories.
3. As a user browsing Today, I want the same feedback actions available on News and Sports stories,
   so that I do not need to leave Today to tune either module.
4. As a user, I want feedback actions inside a discreet three-dot menu, so that story cards remain
   visually calm.
5. As a keyboard user, I want the feedback menu and reason field to have clear labels, focus order,
   and Escape/Cancel behavior, so that the compact treatment remains accessible.
6. As a user choosing Less like this, I want to explain why, so that Moss learns the relevant subject
   rather than guessing from one story alone.
7. As a user, I want the reason field to preserve exactly what I wrote, so that I can recognize and
   revise the preference later.
8. As a user, I want an empty or whitespace-only reason rejected, so that a Less like this action
   cannot pretend to provide future personalization without usable guidance.
9. As a user, I want the selected story to disappear immediately after feedback saves, so that the
   action has a visible result.
10. As a user, I want the removed story replaced by the next eligible story when one exists, so that
    the page does not develop an unexplained hole.
11. As a user, I want an honest empty state when no replacement exists, so that Moss does not
    resurrect the rejected story merely to fill space.
12. As a user, I want Less like this to affect the next News compilation, so that unwanted routine
    subjects are filtered from the user-facing snapshot rather than only shuffled lower on screen.
13. As a user, I want Less like this to affect Sports story selection, so that ordinary matching
    headlines are removed before the Sports overview is composed.
14. As a user, I want a preference such as "I don't want routine Yankees stories" to suppress
    ordinary game results, previews, and similar coverage about the Yankees.
15. As a user, I want a historic championship result involving that team to remain eligible, so that
    a preference does not hide an exceptional event.
16. As a user, I want a major public-safety event to remain eligible even when its place or subject
    matches a negative preference, so that personalization does not become a safety blind spot.
17. As a user, I want source prominence alone to be insufficient for an override, so that publishers
    cannot defeat my preference simply by leading with routine coverage.
18. As a user, I want exceptional status to require recognizable event evidence, so that the override
    is rare and explainable.
19. As a user, I want the exact story I just rejected to stay gone from the current surface even if
    it was exceptional, so that the override does not undo my immediate action.
20. As a user, I want More like this to boost similar future stories without monopolizing the page,
    so that one positive signal does not erase source and subject diversity.
21. As a News user, I want my active News feedback visible in News Settings with story, source,
    direction, reason, and date context, so that I understand what shapes News.
22. As a Sports user, I want my active Sports feedback visible in Sports Settings with story, source,
    direction, reason, and date context, so that I understand what shapes Sports.
23. As a user, I want to edit a Less like this reason, so that a preference can become narrower or
    broader without creating a duplicate rule.
24. As a user, I want to remove a feedback item, so that it stops influencing future selection.
25. As a user, I want editing or removing feedback to request a fresh selection, so that Settings and
    story surfaces do not disagree for days.
26. As a user, I want News feedback to affect News and Sports feedback to affect Sports, so that one
    module does not silently reinterpret a preference created in the other.
27. As a user, I want Today to honor the preference of the module that supplied each story, so that
    Today remains consistent with the dedicated module page.
28. As a user, I want my feedback to be private to my account, so that another user's preferences do
    not change my stories and an admin cannot inspect my private reasons.
29. As a user, I want my feedback reason excluded from logs, queue payloads, screenshots, and other
    users' responses, so that a private preference does not leak through operations tooling.
30. As a user, I want Moss to treat my reason as preference data rather than executable instructions,
    so that free text cannot alter unrelated AI behavior.
31. As a user without a currently available relevance evaluator, I want the exact story action and
    saved preference to remain truthful while background reselection reports its degraded state, so
    that Moss does not claim future personalization succeeded when it did not.
32. As a user, I want the last good story set preserved if a refresh fails, except for the exact story
    I dismissed locally, so that feedback cannot blank the module or replace it with unverified data.

## Implementation Decisions

- Extend the existing usefulness-feedback capability instead of creating parallel News and Sports
  feedback stores. Add story target kinds for News and Sports, story-capable surfaces for News,
  Sports, and Today, and a distinct `less_like_this` kind. Keep `not_useful` semantically separate;
  it describes one rendered item, while Less like this creates an ongoing selection preference.
- Add a new migration owned by usefulness-feedback. Never edit the applied feedback migration. The
  migration expands the checked vocabularies and adds dedicated fields for a bounded user reason,
  a versioned structured relevance rule, and update time. The reason is not hidden inside generic
  metadata.
- A Less like this reason is required after trimming, is plain text, and is capped at 500 Unicode
  characters. More like this accepts no reason. Unknown request keys remain rejected.
- The story reference is an opaque stable identity derived from the canonical story URL. Raw URLs
  and article bodies are not used as feedback identifiers. The target registry records only bounded
  public story context needed to verify and later display the preference: module, headline, source,
  published time, topic/team/competition identifiers, and editorial evidence.
- Each rendered story is registered as an owner-scoped feedback target before the API accepts
  feedback for it. A target verifier confirms that the story belonged to the actor's current News or
  Sports result. Client-supplied source, topic, team, or prominence claims are ignored.
- One active direction exists per user, module, and story. Saving More after Less, or Less after More,
  supersedes the previous active direction. Idempotent retries return the existing active result and
  do not create duplicate refresh work.
- Feedback removal remains non-destructive: mark the record undone. Editing a Less reason updates the
  active preference revision, recompiles its structured rule, and retains the stable feedback id.
  Settings shows active preferences; a separate audit-history UI is not part of this slice.
- The usefulness-feedback module owns a shared `StoryRelevancePolicy` application boundary. It turns
  a saved signal plus verified story context into a bounded, versioned rule and evaluates candidate
  story metadata against active rules. News and Sports receive this behavior through injected ports;
  neither imports the other module or queries usefulness-feedback tables directly.
- Shared pure types and policy helpers may live in a neutral shared package. Source retrieval,
  refresh scheduling, candidate construction, and presentation remain in the owning module. This is
  the allowed sharing seam and does not weaken module isolation.
- Rules are module-scoped in this version. News feedback affects News, Sports feedback affects Sports,
  and Today delegates to whichever module supplied the story. A cross-module interests profile is a
  later decision.
- Rule compilation extracts bounded subjects from the user's reason and verified story context. For
  Sports, stable team and competition identifiers are preferred over names when available. For News,
  verified topic labels and normalized subjects are used. The original reason remains the source of
  truth shown in Settings; derived rule data is replaceable and versioned.
- Free-text reasons are user preference data, not trusted instructions. They are supplied to the
  configured structured evaluator in a separate data field, sanitized and bounded, and cannot alter
  tool policy, system prompts, source permissions, or unrelated module configuration.
- Applying a preference happens during candidate collection/selection, before the final user-facing
  story set is published. Source feeds may still need to be retrieved as a bundle; the guarantee is
  that routine matching candidates are not admitted to the resulting snapshot or overview. For
  search-driven News topics, active preferences also inform search planning so Moss avoids seeking
  routine matching stories in the first place.
- Saving, editing, or removing feedback requests a coalesced refresh for the owning module. Queue
  payloads contain only actor id, module, preference revision, and idempotency metadata; they never
  contain the reason, headline, URL, or article content. Workers read private preference data under
  the actor's data context.
- The client removes the selected story only after the feedback request succeeds. It fills the slot
  from the next eligible story already present in the loaded module response and invalidates the
  owning overview for background replacement. If no spare exists, it renders the existing honest
  empty treatment rather than restoring the story.
- The just-rejected canonical story is always excluded from the current result. Exceptional override
  applies to future distinct coverage, not to resurrecting the same story immediately.
- Candidate evaluation returns `ordinary` or `exceptional` plus closed evidence codes. A negative
  match is suppressed by default. It survives only when exceptional event evidence and editorial
  evidence both pass; an evaluator's unsupported free-form assertion is not enough.
- Exceptional event evidence is limited to: an imminent or ongoing public-safety threat; terrorism,
  mass-casualty event, major natural disaster, war escalation, or similarly consequential civic
  event; a championship/title outcome; a genuinely historic competitive record; or a death, serious
  crisis, or event that has clearly crossed from routine sports coverage into major general news.
- Routine game results, previews, standings movement, rumors, transfers/trades, ordinary injuries,
  opinion pieces, and normal local developments are never exceptional merely because a publisher
  placed them first.
- Editorial evidence is derived from trusted server context: source feed position, championship or
  event-stage metadata, and—where available—independent coverage across publishers. Client values
  cannot grant exceptional status. Source prominence alone never overrides a negative preference.
- News adds active rules to its existing structured compilation/ranking pass and publishes only the
  evaluated result. Sports passes its fetched headline candidates and source prominence/team/event
  metadata through the same relevance policy before composing followed cards, top stories, and
  league news. The evaluation is batched, not one model call per story.
- A positive match provides a bounded boost after baseline newsworthiness and recency. It cannot make
  an otherwise ineligible story eligible, defeat deduplication, or fill every slot with one subject.
- If relevance evaluation fails, do not publish a newly guessed or partially filtered story set.
  Preserve the last good server result, keep the exact client-side dismissal for the current view,
  expose a metadata-only degraded state, and retry through the existing coalesced refresh path.
- News Settings lists only active News story feedback. Sports Settings lists only active Sports story
  feedback. Each row shows direction, bounded headline/source context, reason when applicable,
  creation/update time, Edit for Less reasons, and Remove. Both panes explain that exceptional major
  stories may still appear.
- Feedback and target rows remain owner-only under forced RLS. There is no admin private-data bypass.
  Reasons are included in the user's own data export and deletion lifecycle, but excluded from logs,
  metrics, queue payloads, operational audit summaries, and screenshots/evidence.
- Logs and metrics contain only feedback id, module, direction, rule version, candidate counts,
  suppression counts, override counts, outcome, duration, and error class. They never contain the
  reason, target reference, headline, URL, or derived subjects.

## Testing Decisions

- The primary test is the highest external seam: submit feedback as a user, refresh the owning
  overview, and assert the returned story set. Tests should observe stories and Settings behavior,
  not private helper calls or prompt wording.
- Use one shared contract fixture containing an ordinary matching story, an unrelated replacement,
  and a matching exceptional story with explicit event and editorial evidence. Run the same behavior
  contract through News and Sports adapters so shared policy cannot drift while module-specific
  metadata remains honest.
- At the primary seam, Less like this removes the selected story, supplies the replacement, suppresses
  the later ordinary match, and retains the exceptional match. Editing the reason changes the next
  result; removing the preference restores ordinary eligibility.
- Existing usefulness-feedback integration tests are prior art for owner-only RLS, target
  verification, idempotent creation, listing, undo, and side effects. Extend them for story targets,
  required reason validation, opposite-direction supersession, edit revisioning, and module filters.
- Existing News compilation tests are prior art for candidate collection, structured ranking,
  last-good preservation, coalesced refresh, and metadata-only jobs. Add active preference guidance,
  suppression-before-publication, positive bounded boost, exceptional override evidence, and
  evaluator-failure coverage.
- Existing Sports service and News-band ranking tests are prior art for feed-order prominence,
  followed-team ranking, cross-feed URL identity, hero selection, and deduplication. Add preference
  filtering before cards/top stories/bands are finalized and prove filtered stories do not reappear
  through a sibling feed.
- UI tests cover the same menu on Today, News, and Sports; accessible trigger/labels; the Less reason
  editor; pending/error states; immediate removal and replacement; and the no-replacement empty case.
- Settings tests cover module-scoped lists, displayed context, reason editing, removal, the major-news
  explanation, and query invalidation of both Settings and the owning overview.
- Privacy tests use two actors and prove that one actor cannot verify, create, list, edit, remove, or
  consume the other's feedback. Admin context receives no private-data bypass.
- Security tests place instruction-like text in the reason and prove it remains bounded preference
  data, cannot alter the structured response shape, and never appears in logs or job payloads.
- Failure tests prove that an unavailable evaluator keeps the last good server story set, records only
  metadata, does not claim a successful refresh, and does not reinsert the exact story already removed
  from the current client view.
- The live-path acceptance run logs in with News and Sports enabled, submits Less feedback on one
  story from each module, sees each disappear and be replaced, observes an ordinary matching fixture
  suppressed and an exceptional matching fixture retained, edits then removes both preferences in
  Settings, and confirms ordinary eligibility returns. Record desktop and narrow-width evidence of
  the discreet menu and Settings history without capturing private reason text in screenshots.

## Out of Scope

- A global interests profile shared across modules.
- Machine-learning training, embeddings, collaborative filtering, or cross-user recommendations.
- Admin analytics or visibility into user feedback and reasons.
- Absolute topic blocking. Users may still exclude entire News publishers through the existing
  publisher-exclusion feature.
- Free-form feedback kinds beyond More like this and Less like this.
- Using feedback to change followed teams, leagues, News sources, topics, permissions, or module
  enablement automatically.
- Fetching full article bodies solely to classify preference matches. Use the bounded headline,
  excerpt, source, and trusted event metadata already available during selection.
- A full audit-history screen for undone or superseded preferences.
- Applying old feedback retroactively to historical briefings, chat messages, or already-delivered
  notifications.
- Guaranteeing that bundled RSS/API feeds are never retrieved from the network. The product guarantee
  concerns search planning and admission to the user-facing story set.
- Authenticated/paywalled publisher support; that remains separate from public story relevance.

## Further Notes

- Less like this is the primary value. More like this deliberately remains a bounded ranking hint,
  while Less changes candidate eligibility.
- The major-news override is intentionally conservative. Suppression wins whenever evidence is
  missing or ambiguous. On evaluator failure, last-good preservation avoids both silently admitting
  routine matches and publishing an empty replacement.
- "History" in this slice means the user's currently active preference context. The underlying
  non-destructive status transition preserves auditability, but an archive UI is deferred.
- The design keeps one shared behavior seam without turning News and Sports into one module: shared
  feedback storage and policy, module-owned candidate truth and presentation.
