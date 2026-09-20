# Jev screen-focus feasibility

Date: 2026-09-19

## Conclusion

Jev can plausibly decide whether observed activity is focused or distracting, but it cannot itself watch or understand a screen. Jev 1.13 accepts text only—no image, audio, or video—so another component must first turn screen activity into text or structured fields.

Jev is a candidate for the narrow judgment step, not the perception, memory, notification-writing, or action steps.

## What fits

- Jev evaluates a string, JSON object, or array supplied as `state`, so it could compare structured observations such as the active app, window title, page text, current high-priority task, and recent activity.
- Its typed primitives fit the decision: a `Choice` could return `focused`, `necessary_detour`, `distracted`, or `insufficient_evidence`; a `Noul` could estimate whether the activity is a distraction; a `Score` could express severity.
- Choice and Score responses include probabilities and confidence, which would allow conservative notification thresholds.
- Current documented limits—1,200 requests per minute and 250,000 input tokens per second—do not rule out periodic evaluation.

## Lowest-cost observation strategy

1. Collect active app, window title, browser domain/tab title, idle time, and the current priority task locally.
2. Handle obvious cases with deterministic rules and send only ambiguous cases to Jev as compact JSON.
3. Use macOS Accessibility or browser DOM text when titles are ambiguous. Reserve local OCR for apps that expose neither.
4. Trigger on app/tab changes or sustained dwell rather than continuously polling screenshots.
5. Let Jev return a typed classification; use a canned Moss notification instead of a second generative-model call.

At Jev's documented $0.042 per million input tokens, one 500-token decision per minute for eight hours across 22 days is approximately $0.22 per user per month.

## Important limits

- There is no documented screen-capture, image, video, streaming, persistent-session, or temporal-memory interface. Continuous observation means repeated requests with externally maintained state.
- Jev does not generate the supportive message or execute an action.
- TypeSafe describes Jev as fast but publishes no numeric latency guarantee or SLA in the reviewed documentation.
- Jev 1.13 is unreliable at date/time comparison and loses accuracy when state contains much irrelevant detail. Time windows and rolling-history calculations should remain deterministic, and each request should stay small.
- Jev does not treat state as hostile by default. Text extracted from a malicious webpage could influence its judgment, so raw page text creates a prompt-injection risk.
- Screen observations are highly sensitive. TypeSafe says inputs are not used to train or fine-tune models, but it collects API input and retains personal data as reasonably necessary. Zero-data-retention is described as an enterprise option.

## Primary sources

- [Models](https://docs.typesafe.ai/models)
- [State](https://docs.typesafe.ai/concepts/state)
- [Introduction](https://docs.typesafe.ai/introduction)
- [System One](https://docs.typesafe.ai/concepts/system-one)
- [Confidence](https://docs.typesafe.ai/confidence)
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [API reference](https://docs.typesafe.ai/api)
- [Legal](https://docs.typesafe.ai/legal) and [Privacy Policy](https://typesafe.ai/legal/privacy-policy)
