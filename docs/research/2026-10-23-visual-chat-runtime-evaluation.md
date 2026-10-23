# Visual chat runtime evaluation — stage 1a

Date: 2026-10-23. Part of [#3583](https://github.com/motioneso/moss/issues/3583).
[Plan](../superpowers/plans/2026-10-23-visual-chat-replies.md),
[experiment and reproduction](../../spikes/visual-chat-runtime/README.md).

## Result and recommendation

The actual published OpenUI runtime renders the experiment's two generic compositions
through Moss components. Proceed to the production message/tool integration experiment
(stage 1b) using the inspected adapter as input. This is not a completed runtime-and-contract
gate: no actual Moss chat, authorized source snapshot, configured model, storage or action
has been connected yet. The feature is not available in production.

The production adapter must retain the measured development-loader fix, validate its larger
catalog and prove its own live installed-dev lifecycle and configured-engine acceptance.
Do not promote this experiment's hardcoded fact map or limited grammar into that implementation
without the planned authorized registry and contract work.

## Exact environment

Workspace-only dependencies; the production web manifest is unchanged:

| Dependency                                     | Resolved version |
| ---------------------------------------------- | ---------------- |
| `@openuidev/react-lang`                        | 1.0.1            |
| `@openuidev/lang-core`                         | 1.0.1            |
| `@openuidev/devtools` (vendor transitive)      | 0.3.0            |
| `@openuidev/observability` (vendor transitive) | 0.0.4            |
| React / React DOM                              | 19.2.7 / 19.2.7  |
| Zod                                            | 4.4.3            |
| Vite / React plugin                            | 7.3.5 / 5.2.0    |

The lockfile records integrity hashes. Both valid programs reference host-owned, explicitly
labeled example facts and rearrange the same registered Reply/Section/Fact vocabulary.
No model generated these programs; no format-reliability or latency claim follows.

## Observed failures and adapter changes

The first Firefox development run failed before showing the visual. Its request receipt
included an automatic jsDelivr inspector request, and its page error was
`process is not defined`. The initial entry match missed Vite's versioned module ID; the
private renderer chunk also used bracket-form `process.env["NODE_ENV"]`.

`runtime-entry.ts` now strips exactly the inspected web bootstrap region, requires exactly
one match, handles versioned module IDs and normalizes the bracket-form environment check
within this pinned package. OpenUI is excluded from dependency prebundling so this transform
sees its entry. The Renderer receives no tool provider and disables its observability publishing.
This is an experiment-specific transform, not an upstream-supported opt-out.

The corrected development browser run rendered both valid compositions and four fallback cases.
Across those six navigations the receipt recorded zero external requests, automatic devtools
requests, inspector mounts or unhandled page errors. These are observations of these paths,
not a universal claim about every possible OpenUI program or environment.

## Positive and negative evidence

- Thirty unit checks passed, including valid layouts, inert escaped strings, unavailable
  fields, unknown widgets, extra arguments, invalid nesting, over-limit input, unsupported
  state/actions, changed vendor bootstrap and Vite module ID/environment handling.
- Removing the lexical restriction produced an observed failing unit run: 3 failed,
  25 passed. Duplicate root assignment and invalid string forms were accepted by the
  permissive underlying parser. The guard was restored; the current 30-test suite passes.
- Disabling bootstrap removal while retaining the environment compatibility fix produced
  an observed failing browser run. Across six navigations it recorded 6 external CDN
  requests, 12 requests matching devtools (including those CDN requests), one mounted
  inspector on the final page and zero unhandled page errors. The unchanged browser
  assertion failed with exit 1. Normal suppression is restored by default.
- The production preview rendered both layouts and all four fallbacks with zero observed
  external/devtools requests, inspector mounts or unhandled page errors.
- Each browser run checked the ordinary answer, exact displayed example facts, readable
  fallback and absence of raw program text on failure. It used fresh headless Firefox and
  captured the main element, not a full-page screenshot. No application API was intercepted.

The checked browser cases are `allocation`, `rearranged`, `unknown`, `truncated`, `query`
and `unknown-fact`. The checked-in Python script reproduces their assertions and writes
request/error receipts plus screenshots to a caller-selected scratch directory.

## Bundle measurement

Both minified builds use the same React/Moss frame and CSS. The baseline displays ordinary
text facts and does not import Zod/schema construction. The runtime includes Zod, OpenUI,
the validator, catalog, fixture selection and failure handling. Summed JavaScript asset bytes:

| Build              | Raw bytes | Gzip bytes |
| ------------------ | --------: | ---------: |
| Text baseline      |   194,756 |     61,283 |
| Runtime experiment |   382,495 |    119,884 |
| Increment          |   187,739 |     58,601 |

These are isolated fixture-build measurements, approximately 57.2 KiB additional gzip
JavaScript. They are not the incremental Moss app bundle cost: the app already shares some
dependencies and still needs its own lazy-loading/build measurement. No token savings,
provider cost or model latency was measured.

## Checks and remaining gates

Passed: scoped ESLint, Prettier, experiment TypeScript, root `tsc --noEmit`, file-size check,
30 unit tests, paired builds and the development/production fixture browser checks.
Negative controls failed as intended and their guards were restored. No database/full
foundation gate or installed-Moss e2e gate was run for this isolated experiment.

Still required before stage 1 is complete:

1. Versioned shared/live/history contracts, validation and host-readable copy/export fallback.
2. Actor/thread/turn-bound authorized snapshots and registered read-only `chat.present`.
3. Finalization, cancellation, reconnect, incognito, deletion and thread-switch browser proof.
4. Twenty prompts on each configured rollout engine/provider route, at least 19 intended
   visuals on the first attempt and useful text for all 20, including novel compositions.
5. Actual app prompt/output/latency/bundle measurements and truthful product app-map entries.

Sports latest-result reads, real team logos, interval Weather data, the full component
vocabulary, conversation controls and real actions follow those gates as specified.
