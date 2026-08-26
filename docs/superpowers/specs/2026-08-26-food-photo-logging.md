# Food photo logging (#2001)

**Status:** Ready for agent after Ben-approved brief and test-seam review  
**Issue:** #2001  
**Parent:** #926  
**Primary verification seam:** Chat photo submission → Food meal log → structured nutrition result → Food log and Chat response

## Problem Statement

Manually describing a meal is tedious, and words do not always capture the useful visual context
of what someone is eating. A Food user should be able to take a photo in Chat and have Moss use it
to create the meal record and explain the estimated nutrition.

The result is an estimate, not a measurement. Moss must preserve uncertainty and must file the meal
under the correct consumed day.

## Solution

Extend the existing Food meal-logging path so a user can attach a meal photo in Chat and ask Moss to
log it. The Food module receives an owner-authorized image reference, sends the image and any user
context through the existing structured-AI route, stores the identified food items and their
estimated nutrients, and returns the same itemized breakdown to Chat.

The Food log and Chat response must agree. If the image is unclear, Moss saves the meal honestly as
incomplete or failed and asks for the missing detail instead of inventing a confident estimate.

## User Stories

1. As a Food user, I want to attach a photo of my meal in Chat, so that I can log it without typing a full description.
2. As a Food user, I want Moss to understand that my attached photo is intended for meal logging, so that the photo becomes a Food record rather than an unrelated chat attachment.
3. As a Food user, I want the photo to produce one Food log entry, so that I can find the meal later.
4. As a Food user, I want Moss to identify each recognizable food item in the photo, so that the record explains what was logged.
5. As a Food user, I want a nutrition breakdown for every identified item, so that I can see how the estimate was assembled.
6. As a Food user, I want Chat to show the itemized nutrition breakdown after processing, so that I get immediate feedback without opening the Food page.
7. As a Food user, I want the Food log to show the same itemized breakdown as Chat, so that the two surfaces do not disagree.
8. As a Food user, I want calories, protein, carbohydrates, fat, fiber, sugar, and sodium shown when they can be estimated, so that I get consistent basic nutrition context.
9. As a Food user, I want every value labeled as an estimate, so that I do not mistake an image-based guess for measured nutrition.
10. As a Food user, I want Moss to say when the photo is too unclear to estimate, so that missing information is visible instead of silently becoming zero.
11. As a Food user, I want to add a short description or serving detail with the photo, so that Moss can use context the image cannot show.
12. As a Food user, I want a meal saved even when its estimate needs more detail or fails, so that the act of logging is not lost.
13. As a Food user, I want a retry or clarification path for an incomplete estimate, so that I can finish the record without creating a duplicate meal.
14. As a Food user, I want the meal assigned to the correct local day, so that a photo submitted near midnight does not appear in the wrong day's history.
15. As a Food user, I want an explicitly stated earlier consumed time to override the submission time, so that delayed logging preserves when I actually ate.
16. As a Food user, I want my photo to remain private to my account, so that other users and administrators cannot inspect it.
17. As a Food user, I want raw image bytes kept out of logs and job payloads, so that private meal photos do not leak through infrastructure.
18. As a Food user, I want my configured AI provider and vision-capable model selection respected, so that Food does not route the photo through an unexpected provider.
19. As a Food user, I want an unsupported or unavailable vision capability reported honestly, so that the Food record does not claim an estimate that never happened.
20. As a Food user, I want a repeated Chat submission to remain idempotent, so that a retry cannot create duplicate meal records.

## Implementation Decisions

- Extend the existing Food meal-logging assistant tool rather than creating a second photo-specific
  logging command. The tool accepts an owner-authorized image attachment reference, optional user
  description, optional serving detail, optional consumed time, and the existing idempotency key.
- The supported MVP entry point is Chat. The user attaches a photo and asks Moss to log the meal;
  the Chat assistant selects the Food logging tool and passes the attachment reference. A new
  standalone Food-page camera or upload surface is not part of this issue.
- Keep the existing Food command as the single write path. Chat does not write Food tables directly;
  it invokes the Food module's command, which persists the meal and records the estimate.
- Use the existing private Chat attachment lifecycle and the public module attachment contract from
  #1695. Food receives only an actor-scoped attachment reference and reads image bytes through the
  authorized module capability. Food never trusts a caller-supplied owner id.
- Use the structured-AI image input contract from #1696. The Food module supplies its existing
  nutrition schema and prompt plus the authorized image content; model selection remains the host's
  provider-agnostic vision-capability decision.
- The image prompt asks the model to identify individual foods, estimate each item's nutrients, and
  return a bounded clarification when the image or serving information is insufficient. It must not
  claim medical meaning or certainty.
- Reuse the existing nutrition schema and domain validation. The stored meal items and total
  nutrients are derived from the validated item results, so Chat and the Food page use one source
  of truth.
- A photo may be submitted without a typed description. If the user supplies text, it is bounded
  context for the image rather than a replacement for the image. Empty or unsupported input is
  rejected at the tool boundary.
- Persist the meal before estimation, as the existing Food path does. The visible estimate state is
  `estimated`, `needs_details`, or `failed`; incomplete nutrient fields remain null and are never
  treated as zero.
- A provider failure, unavailable vision capability, malformed response, unsupported image, or
  attachment read failure becomes an honest failed/incomplete result. These failures do not expose
  provider details or image contents in the user response.
- The Food log command returns the validated itemized result in its structured tool output. Chat
  renders or summarizes that result in a response containing each identified food and its nutrient
  breakdown, with the same estimate/uncertainty wording used by Food.
- When clarification is needed, Chat receives the bounded clarification question and the Food log
  shows the incomplete state. A later retry targets the existing meal and estimate revision; it does
  not create another meal.
- The meal's consumed time follows the existing precedence: an explicit valid consumed time wins;
  otherwise the capture-time instant is used. The actor's host-resolved IANA timezone determines the
  local Food day. Submission time and consumed time remain distinct.
- Preserve existing idempotency and revision guards. A retried Chat request with the same key must
  return the existing meal, and a stale estimate must not overwrite a newer correction or retry.
- Keep image bytes, prompts, model responses, and nutrient values out of logs, metrics, and job
  payloads. Only bounded identifiers, capture kind, estimate state/revision, duration, field
  presence, and error class may be recorded.
- Preserve Food's owner-scoped RLS and module boundary. The image and resulting meal are available
  only to the active Food owner; no administrator private-data bypass is introduced.
- Do not implement #1695 or #1696 in this issue. If either platform contract is not available, the
  Food feature remains blocked at that boundary and does not add a private first-party shortcut.

## Testing Decisions

- The highest test seam is one external journey: submit an image in Chat, invoke the real Food
  logging path, use a deterministic structured-AI image fixture, then assert the Chat result and Food
  record. Tests should assert public behavior and persisted owner-scoped data, not private helper
  calls.
- Extend the existing Food integration coverage for the `food.meals.log` tool and its structured
  estimate result. The test fixture should return multiple food items with distinct nutrient values,
  making disagreement between item totals, Chat, and the Food log observable.
- Reuse the existing Chat attachment fixtures and attachment ownership tests. Prove an image can be
  read by its owner, while a guessed attachment id from another actor is rejected or unavailable.
- Reuse the existing structured-AI test seam with a deterministic vision-capable provider fixture.
  Do not call a live provider in unit or integration tests, and do not assert provider-specific
  request formats in Food tests.
- Add an end-to-end or integration assertion that the Chat response names every returned food item
  and its nutrient breakdown, and that the Food log contains the same items and values.
- Add a near-midnight test using the actor's timezone and an explicit earlier-consumed-time test.
  Assert the Food local date, not the server date or the wall-clock date of the test runner.
- Add coverage for a photo with optional user context, no typed description, unsupported image mime,
  oversized image, missing attachment, and an attachment owned by another actor.
- Add coverage for an ambiguous image returning `needs_details`. Assert that the meal is retained,
  the Food log discloses incompleteness, and Chat asks the bounded clarification rather than
  presenting invented nutrients.
- Add coverage for provider failure, unavailable vision configuration, malformed structured output,
  and retry. Assert an honest failed state, no leaked provider detail, and no duplicate meal after
  retry.
- Add coverage for a successful retry and a concurrent/stale estimate result. Assert revision guards
  preserve the newest valid result.
- Add privacy assertions that image bytes, image content, prompts, model responses, and nutrient
  values do not appear in logs, metrics, or job payloads.
- Add a two-actor test proving the second actor cannot read the first actor's meal or image through
  Chat, the Food page, or the Food tool.
- The live acceptance path is: install and enable Food, attach a photo of a meal with multiple
  identifiable items in Chat, ask Moss to log it, confirm the Chat itemized breakdown, open Food,
  and confirm the same items and nutrients appear under the correct local day.

## Out of Scope

- A standalone Food-page camera, gallery picker, or image-upload workflow.
- Implementing the shared module attachment contract (#1695).
- Implementing structured-AI image support or vision model routing (#1696).
- Nutrition databases, barcode scanning, measured nutrition, or guaranteed portion accuracy.
- Calorie targets, diet plans, coaching, medical advice, diagnosis, or causal health claims.
- Automatic logging of every image attached to Chat without a clear meal-logging request.
- Automatic creation of Wellness check-ins or interpretation of symptoms.
- Changes to Food's existing text/voice logging behavior except where the shared result shape is
  needed to keep Chat and the Food log consistent.
- Food export, Wellness check-in context, Food-page consent editing, or the existing Food date bug
  follow-up (#1869).

## Further Notes

- This is a Food-module consumer issue. The platform contracts remain separately specified and
  independently testable so a future third-party module can use the same image path.
- The deliberate MVP boundary is one photo submitted through Chat. Additional capture surfaces can
  be added later only if the Chat path proves useful and the platform contracts remain stable.
- The existing Food nutrition model is intentionally reused: item nutrients are validated at the
  module boundary and totals are derived from items, keeping the Chat explanation and Food history
  aligned.
