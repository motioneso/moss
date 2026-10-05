# Trail Marker: judge the screenshot directly

**Status:** Approved by Ben in chat on October 5, 2026 ("approve, please proceed"), after agreeing the direction the same day ("yea lets do it").

**Amends:** [Rung 3 vision spec](2026-09-21-trail-marker-rung3-vision.md) §3, §5 and §6. Everything else there stands.

**Depends on:** [Decision-model presets](2026-10-05-decision-model-presets-design.md) (#3057), which adds Clef and the Cloudflare dialect for text only.

**Tracking:** [Task #3067](https://github.com/motioneso/moss/issues/3067).

## 1. Goal

When the decision model judging Trail Marker focus can read images, let it judge the captured window directly. Skip the separate describe step.

Today rung 3 has two steps. The Mac captures the window, a vision model describes it in a sentence, and Moss judges the sentence. Clef and Clef-flash accept up to four images next to the usual `state` and `questions`. A probe on October 5, 2026 (`tools/jev-pilot/clef_probe.py`) sent a mock shopping page with two goals:

| Goal                               | Clef, image direct                   | Describe (Qwen) then Jev             |
| ---------------------------------- | ------------------------------------ | ------------------------------------ |
| Finish the Q4 budget spreadsheet   | shopping 0.90, distracted 0.89, 1.2s | shopping 1.00, distracted 0.98, 6.3s |
| Buy headphones for a flight, <$150 | shopping 0.95, focused 0.88, 1.4s    | shopping 1.00, focused 1.00, 5.4s    |

Clef-flash gave the same labels in about 0.6s. One image cost about 1,840 input tokens. One easy mock proves only that the path works. Accuracy on real windows is part of the live proof (§9).

## 2. What Cloudflare accepts (checked October 5, 2026)

From Clef's published input schema (`developers.cloudflare.com/workers-ai/models/clef/schema-input.json`), confirmed by the probe:

- `images` is an optional array of at most 4 items. Each item is a data URL (`data:image/jpeg;base64,…`, also PNG or WebP) or `{content_type, base64}`. Remote URLs are refused.
- Limits: 4 MiB and 16 megapixels per image, 8 MiB decoded in total, 13 MiB for the whole body.
- The schema calls `images` a "Clef extension to the System One API". Jev and the standard dialect do not accept it.

## 3. Which models qualify

A decision model qualifies when its model row carries the existing `vision` capability. No new column, flag or provider kind.

- This spec adds `vision` to the fixed model list #3057 gives Clef, so `clef` and `clef-flash` carry `json` and `vision`.
- Jev's models stay `json` only.
- For "Any compatible service", the person ticks Vision in the existing edit-model form (`settings-ai-edit-model-form.tsx`). Test sends one 8×8 PNG with a yes/no question. If the service refuses it, the warning says "This service didn't accept a picture" and the capability is not ticked automatically.

## 4. The new screenshot source

Rung 3 §3 gains a third source: **"Your focus judge in Moss"**. Only one source is active at a time, as now.

- **Availability.** It is offered only when Moss reports that the bound judge takes images. `POST /api/companion/focus/context` gains `judgeTakesImages: boolean` and `judgeName: string | null`, which is the provider label and model, for example "Clef-flash (Cloudflare)". Neither is secret.
- **What happens.** After rung 1 returns `insufficient_evidence`, the Mac captures the window exactly as §4 of the rung 3 spec describes (one window, longest side 1024px, JPEG, memory only). It then calls judge a second time with an `image` field instead of a `description`. There is no describe call.
- **Changing judges.** If the person later binds a judge that can't take images, the source shows as unavailable ("Your focus judge in Moss no longer reads pictures. Choose another way to describe the screen."). Rung 3 then behaves as "vision unavailable" (§5 of the rung 3 spec). It never switches to another source silently.
- **No default switch.** People who already chose a source keep it. This source is never selected automatically.

Settings mockup (Trail Marker → Settings → Focus, the existing section):

```
When a title alone isn't enough
[x] Take one picture of the screen and describe it

    When Trail Marker can't tell from the window title alone, it will take one
    picture of an allowed app and send it to Clef-flash (Cloudflare) through your
    Moss server to judge. The picture is never saved and never sent anywhere else.

    Describe with:  ( ) An API key
                    ( ) Claude Code, signed in on this Mac
                    (•) Your focus judge in Moss: Clef-flash (Cloudflare)
                        Uses the judge set in Moss. No key is stored on this Mac.

    [ Test ]
    Captured from Safari:  [ thumbnail ]
    Shopping, distracted (89% sure)
```

Test with this source sends the capture to a new test variant of the judge call. It shows the captured thumbnail (as today) and the resulting label and confidence instead of a description. No judgment row is stored for a test.

## 5. Consent wording

Rung 3 §5's sentence gains a third destination, built from `judgeName`: "…and send it to {judgeName} through your Moss server to judge. The picture is never saved and never sent anywhere else." When `judgeName` is unknown the source is unavailable, so the sentence never says "a model".

The sentence must be literally true for the build that ships. That is a test condition in §8, not a claim made here.

## 6. Server side

**Request.** `FocusJudgeRequest` gains an optional `image` field: a JPEG data URL, at most 1 MiB of text (enough for a 1024px JPEG at the Mac's 0.6 quality, which is typically 100–300 KB). It is mutually exclusive with `description`; sending both is a 400. The judge route sets its own `bodyLimit` of 1.25 MiB. Every other companion route keeps its limit.

**Routing.** The judgment service passes the image to `generateChoices` as a separate argument, not inside `state`:

- If the bound model has `vision` and its provider speaks the Cloudflare dialect, the image goes in `images: [dataUrl]`. The 12,000-byte cap from #3057 still applies to `state` plus `questions`. The image has its own cap (above), so text requests stay bounded as before.
- In any other case `generateChoices` returns `not_supported` for an image request. The judge does **not** fall back to the prompt path with the image, and does not drop the image and judge the title alone. The result is `insufficient_evidence` with a bounded diagnostic `judge_image_not_supported`. The Mac shows this as the source being unavailable.
- The standard System One dialect never receives `images`. When a compatible service ships image input under the same field name, enabling it is a one-line dialect change plus that service's live proof, not part of this spec.

**What must not hold the image.** The image may exist only in the request being handled and the one outbound provider call:

- not the judgment row (no image or description column, unchanged)
- not `moss_model_activity_log` or its facts
- not pg-boss (the judge is synchronous; no job carries it)
- not any log line, including Fastify's request logging and error serialization
- not error messages returned to the Mac

**Activity history** records the call like any judge call, with one fact added to the allow-list: `images` (a count, 0 or 1). That changes the allow-list in the `moss_model_activity_log` check, so it needs a new migration in `packages/ai/sql/`. The existing one is not edited.

## 7. What does not change

- When a capture happens (rung 3 §2), the denylist, watching the entire desktop (§7), Screen Recording handling.
- The questions, labels, nudge rules and stored row.
- The describe-then-judge sources and their settings.

## 8. Tests

- **Server, unit:** `generateChoices` puts the image in `images` for a Cloudflare-dialect model with `vision`; returns `not_supported` for a model without `vision`, for the standard dialect, and for Jev; keeps the 12,000-byte text cap; enforces the image cap.
- **Server, route:** `image` and `description` together is a 400; an over-limit image is a 413; `judgeTakesImages` and `judgeName` reflect the bound model.
- **No image retained (must be seen failing with the protection removed):** a judge call with a marker image, then assert the marker's base64 appears in no log line captured during the call, no activity-log row, no judgment row and no error body.
- **Mac:** the source is offered only when `judgeTakesImages` is true; a judge change to a non-image model makes it unavailable, never another source; the consent sentence names `judgeName`; the image `Data` is released after the judge call returns or fails.
- **Existing behaviour guard:** a judge call with no `image` sends a byte-for-byte identical request to #3057's.

## 9. Live proof

On the dev instance, after #3057 is live:

1. Bind Clef-flash as the Trail Marker judge and choose "Your focus judge in Moss" on the Mac.
2. Open a window whose title is ambiguous (for example an untitled browser tab on a shopping page) during a calendar block, and see one capture and a judgment with the right label.
3. Confirm the picture is absent from the API and worker logs, Activity history and the judgment row.
4. Switch the judge to Jev and see the source become unavailable, with rung 3 standing at `insufficient_evidence`.
5. Run five real windows from Ben's day through both this source and describe-then-judge, and record the labels side by side on the PR.

## 10. App map and release note

- **App map.** Trail Marker's Focus settings entry gains the third source, its unavailable state and remediation, and the consent wording. The decision-model provider entry from #3057 notes that a model with `vision` can judge screenshots.
- **Release note.** Category Added, "Judge screenshots with your decision model". Description: "If your focus judge can read pictures, such as Cloudflare's Clef, Trail Marker can show it the window directly instead of describing it first."

## 11. Decisions (defaults taken, changeable)

1. **The image goes through Moss, not straight from the Mac to the provider.** The key stays in Moss's encrypted store, and the model choice stays in Moss settings. The Mac never holds a Cloudflare token.
2. **Reuse the `vision` capability** instead of a new image flag.
3. **No silent fallbacks.** A judge that can't take the image gives `insufficient_evidence`, not a title-only judgment or a switch to another source.
4. **One image per judgment.** Clef allows four. Earlier frames for context are a separate decision.
5. **Cloudflare dialect only for now.** The standard dialect gets `images` when a service there is proven live.

## 12. Not in this spec

- Sending images to chat models on the prompt path (a vision chat model as judge).
- More than one image, or frames over time.
- Raising the 12,000-byte text cap.
- Using images for mail sorting.
- Perplexity (#3058).
