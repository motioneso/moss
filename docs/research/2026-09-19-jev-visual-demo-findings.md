# Jev visual demo evidence

Checked: 2026-09-19. Scope: identify what supplied perception in the game-playing
and Skittles examples, separately from Jev's decision-making.

## Confirmed: TypeSafe's Doom demo uses structured game state

TypeSafe's [launch article](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
under **Fun Demos → Doom → Nuance**, explicitly says:

> The demo is on structured state as a data structure with text, not on images (yet…)

The same section reports about ten queries per second and approximately $7/hour.
These are the developer's reported figures, not measurements reproduced here.
The demo establishes fast action selection from supplied game state. It does not
establish screen-image recognition by Jev or reveal a separate visual detector.

The article's Wikiracing example chooses among links on Wikipedia pages; it also
does not demonstrate image recognition.

## Not verified: the Skittles example's input and implementation

Searches for Jev/TypeSafe with Skittles, sorting, colors, and candy found a
[secondary Stork article](https://www.stork.ai/blog/chatgpts-co-creator-built-its-killer)
claiming a demo sorted 150,000 Skittles in five seconds. That article does not
provide the demo's source code, a concrete source video URL, input schema, or an
explanation of whether colors were supplied as text, RGB values, sensor readings,
or camera pixels. Its repetition of the claim is not independent verification.

Targeted indexed searches on X and YouTube did not locate an attributable source
for this particular demo. A YouTube CLI search returned no entries. The
[Made with Jev showcase](https://madewithjev.com/) likewise did not expose a
Skittles entry in the retrieved text. This is a search limitation, not proof that
the demo does not exist.

## Consequence for the Mac pilot

Do not infer that a visually presented demo means Jev consumed pixels. The
confirmed Doom pattern is **application state → Jev decision → application
action**. For desktop perception, independently verify an image-input capability
or supply a separate perception step that turns the captured screen into text or
structured observations. No evidence here justifies sending screenshot bytes to
the current Jev endpoint.

## Current API capability

The [model documentation](https://docs.typesafe.ai/models) explicitly specifies:

> Text only. String, JSON object, or array of text values. No image, audio, or video input.

It instructs developers to preprocess non-text inputs into text or structured
fields. The [state documentation](https://docs.typesafe.ai/concepts/state) agrees.
At the time checked, `jev-latest` maps to `jev-1.13.0`. Sending a base64 screenshot
inside JSON would not add image understanding.

## Smallest useful visual pilot

Keep the existing Accessibility sampler and duration tracker. Add perception
before Jev, initially testing individual screenshots before continuous sampling:

```text
Allowed foreground window → screenshot → visual observations
Accessibility text + visual observations + goal → Jev activity/alignment
Jev judgments over time → existing distraction timer
```

1. **Capture:** use Apple's [ScreenCaptureKit screenshot manager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)
   (`SCScreenshotManager`, macOS 14+) with a single-window content filter. Check
   the Mac's OS before choosing this API. Apple's [capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
   documents Screen Recording permission and window selection. No audio is needed.
2. **Text:** retain Accessibility first; use native [Vision OCR](https://developer.apple.com/documentation/vision/recognizing-text-in-images)
   when screenshot text supplies missing evidence. Apple documents on-device
   processing. OCR alone does not recognize games, photographs, or video scenes.
3. **Visual meaning:** use a separate image-capable model to describe visible
   content in bounded fields such as `content_type`, `visible_subjects`,
   `onscreen_text`, and `uncertainties`. Ask for observations rather than user
   intent or goal alignment; let Jev make those judgments. Treat both observed
   strings and generated descriptions as untrusted evidence.
4. **Local candidate:** [MLX-VLM](https://github.com/Blaizzy/mlx-vlm) documents
   image inference on Apple Silicon and JSON-schema output. Benchmark a small
   supported model on the actual Mac before selecting it. RAM, latency, and
   battery cost are unmeasured; local inference is a proposed configuration,
   not an audited privacy guarantee. A configured hosted vision model is an
   alternative, requiring explicit screenshot-upload opt-in.

For a first monitoring experiment, consider snapshots every 10–15 seconds with
visual inference only on meaningful changes; retain the existing roughly
one-minute Jev cadence initially. These are starting parameters to measure, not
validated defaults. Keep images ephemeral by default, preserve app allowlisting
and pause/lock handling, and exclude secure surfaces before capture. Screenshot
pixels can contain sensitive fields that the current Accessibility sampler skips;
its filtering does not automatically protect screenshot capture. Generated visual
descriptions can also contain sensitive information and need minimization before
being sent to Jev. Keep saved pilot logs categorical.

## Verification before making this the default

Compare Accessibility alone, Accessibility plus OCR, and Accessibility plus visual
descriptions on text pages, a game, video, a map, a chart, and a product photograph.
Record whether the added evidence improves activity and goal alignment, plus
latency, memory, and power impact. Include an ambiguous scene and a page change
during inference so stale observations cannot count toward the distraction timer.

This research adds no capture implementation. Native APIs and local visual-model
performance have not been exercised on the pilot Mac.

## Low-cost model shortlist (2026-09-19)

Cost is a primary constraint for continuous monitoring. Start screenshot quality
tests with Qwen 3.7 Flash and compare Gemini 2.5 Flash-Lite on the same images.
These are candidates, not validated screenshot readers for this pilot.

| Candidate | USD per million input / output tokens | Illustrative cost per 1,000 screenshots |
| --- | --- | --- |
| Qwen 3.7 Flash, Alibaba via OpenRouter | $0.03 / $0.13 | $0.043 |
| Gemini 2.5 Flash-Lite, paid API | $0.10 / $0.40 | $0.14 |
| SmolVLM-500M, local | No API charge | Device compute and power |

Sources: OpenRouter's live [model catalog](https://openrouter.ai/api/v1/models)
and [Qwen provider endpoint](https://openrouter.ai/api/v1/models/qwen/qwen3.7-flash/endpoints)
confirm image input, Alibaba availability, and the listed short-context rates.
Google's [pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite)
confirm image input and paid rates. These are synchronous prices; batch discounts
are deliberately excluded for live monitoring.

Arithmetic assumes **1,000 total input tokens including the image and 100 total
billable output tokens per request**, with no cache discounts. At eight hours per
day for 30 days, one request per minute costs approximately $0.62 for Qwen or
$2.02 for Gemini; one per 15 seconds costs $2.48 or $8.06 respectively. These
exclude Jev, retries, provider/platform fees, taxes, and any extra reasoning
tokens. Image tokenization differs by model and resolution: measure response
usage on actual screenshots before setting a budget. This is an illustrative
workload, not a fixed per-image quote or a guarantee of the cheapest service.

The [SmolVLM-500M model card](https://huggingface.co/HuggingFaceTB/SmolVLM-500M-Instruct)
reports 1.23 GB GPU RAM for single-image inference; the
[release article](https://huggingface.co/blog/smolervlm) documents MLX support.
That is not a measurement on this Mac or a total application memory estimate.
Test it if eliminating API charges matters more than keeping installation and
device compute small; dense-screen recognition quality remains unverified.

For the comparison, request a short factual description with uncertainty, avoid
long reasoning, retain Accessibility/OCR for exact text, and measure billable
usage, latency, and correctness. Later, skip unchanged screens and cap inference
frequency. Cost-saving downscaling must not erase the evidence needed to
distinguish, for example, two different travel destinations. Use the paid Gemini
tier for private-screen experiments: Google's pricing page marks free-tier data
as used to improve products and paid-tier data as not used for that purpose.
