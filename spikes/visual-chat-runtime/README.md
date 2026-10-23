# Visual chat runtime experiment

Part of [#3583](https://github.com/motioneso/moss/issues/3583), stage 1a of the
[implementation plan](../../docs/superpowers/plans/2026-10-23-visual-chat-replies.md).
This workspace has no production caller. It uses the real published OpenUI parser/React
renderer and existing Moss components, with fixed programs and labeled example data.
It does not call a model or read user accounts.

The deliberately small dialect accepts a single `root = Reply(...)` statement. `Reply`
contains one to three `Section` calls, each with a short JSON-string title and `Fact`
children. At most three facts appear across the reply. Facts select a host-owned example
field; the program does not supply their labels or numbers. Named references, expressions,
actions, state, queries/mutations, objects and arbitrary components are outside this
experiment. The production catalog/authorized snapshot registry remain separate work.

`guard.ts` bounds bytes and nesting before the permissive upstream parser, then rejects
errors/incomplete output and validates the whole tree. Failed programs show readable facts;
they do not display the raw program. Runtime failures have the same text fallback.

The pinned 1.0.1 web entry auto-imports devtools in development. `runtime-entry.ts` removes
exactly the inspected bootstrap region through a Vite transform, failing if that region
changes. The transform handles Vite's versioned module IDs and normalizes the vendor's
bracket-form `process.env["NODE_ENV"]` checks, which otherwise fail in the development browser.
OpenUI stays out of Vite dependency prebundling so the transform sees its entry.
The renderer receives `publishObservability={false}` and no tool provider. This is an
evaluation integration, not an upstream-supported loader opt-out or a production isolation claim.

## Reproduce

From the repository root, install the lockfile normally, then:

```bash
pnpm --filter @moss/visual-chat-runtime-spike typecheck
pnpm exec vitest run spikes/visual-chat-runtime/guard.test.ts
pnpm --filter @moss/visual-chat-runtime-spike build
devports claim moss-visual-runtime
```

Use the claimed port for each server below, and release it after stopping. Never choose a
port by hand. Each verification command expects exit 0; retain its actual exit code.

```bash
pnpm --filter @moss/visual-chat-runtime-spike dev --port <claimed-port>
python3 spikes/visual-chat-runtime/browser/final_script.py --url <server-url> --output-dir <scratch-run-directory>
```

Stop development before starting preview on that reservation:

```bash
pnpm --filter @moss/visual-chat-runtime-spike preview --port <claimed-port>
python3 spikes/visual-chat-runtime/browser/final_script.py --url <server-url> --output-dir <another-scratch-run-directory>
```

The Python browser check uses a fresh headless Firefox, asserts both positive compositions,
four fallback cases, readable facts, no page errors, no automatic devtools requests/mounts,
and no external requests. It saves an element screenshot and a bounded request/log receipt.
These are fixture-browser checks, not installed-Moss end-to-end proof.

For a deliberate failing loader control, start development with
`MOSS_OPENUI_NEGATIVE_LOADER=1` and repeat the browser check. Expect nonzero because the real
entry loads devtools. This switch exists only in the isolated spike's Vite configuration.
To check the grammar control, temporarily remove `!allowedSyntax(program)` from the validator,
run the unit suite expecting failure, then restore the guard before any commit.

`measure.mjs` compares two minified builds using the same React/Moss frame and CSS. The
increment includes OpenUI, the catalog, validator, fixtures and failure handling. Report raw
and gzip JavaScript byte deltas; CSS is shared. This is not a production app bundle estimate,
a token-saving benchmark or proof of model-format reliability.

Record measured results and unpassed gates in the implementation evidence note before
using the experiment to recommend further integration.
