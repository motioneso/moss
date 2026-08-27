# Lane 2007 relay handoff (relay 1)

Read this, then `docs/superpowers/plans/2026-08-27-2007-credentialed-publisher-runtime.md`
(the plan) for Tasks 4-7. Do NOT re-read the whole SPEC comment on issue 2007; the plan
already carries every decision from it. A saved copy is at /tmp/spec-2007.md if you need a
detail.

Skip Start steps 1 and 2: node_modules is installed, the spec exists and is already verified
against the branch.

## Where things stand

Three commits on `fleet/lane-2007`, all green:

- `1d5011bb8` the plan + a state doc
- `f5c877a61` Task 1 + 2: `packages/news/src/source/publisher-connection.ts` (connection type,
  `assertValidPublisherConnection`, `assertValidPublisherConnectionRegistry`) and
  `packages/news/src/source/newsapi-connection.ts` (the one reviewed connection, frozen registry,
  validated at import). Test: `tests/unit/news-publisher-connections.test.ts`, 45 passing.
- `2a85184c2` Task 3: `packages/datasets/src/keyed-client.ts` plus its exports in
  `packages/datasets/src/index.ts`. Test: `tests/unit/news-keyed-dataset-client.test.ts`,
  15 passing.

Verified by running, not assumed:
`pnpm test:unit tests/unit/news-publisher-connections.test.ts` EXIT=0 (45 tests)
`pnpm test:unit tests/unit/news-keyed-dataset-client.test.ts` EXIT=0 (15 tests)

Nothing else has been run yet. Lint, formatting, typecheck, the two check scripts and the
regression test list in the plan are all still outstanding.

## What is left

Tasks 4, 5, 6 and 7 in the plan, then `coordinated-wrap-up`. In short:

4. `packages/news/src/source/credentialed-source.ts` - the adapter that sends the key in the
   declared header and maps failures to "authentication failed" or "temporarily unavailable"
   with no provider text, plus `toCredentialedHeadline`.
   Test: `tests/unit/news-credentialed-source.test.ts`.
5. `packages/news/src/source/credential-lookup-port.ts` - two type aliases onto the datasets
   types. Tiny.
6. Add `readCredentialForUse` to the `NewsCredentialRepository` class only (NOT to the
   `NewsCredentialStore` interface, or #2005's route fakes stop compiling), and add
   `packages/news/src/source/credential-lookup.ts`.
   Test: `tests/unit/news-credential-lookup.test.ts`.
7. Exports from `packages/news/src/index.ts` and `packages/datasets/src/index.ts` (datasets is
   already done), and update the stale comment above `ExternalSourceAdapterContext` in
   `packages/module-sdk/src/external-module.ts` so it names the keyed runtime as the caller that
   sets `apiKey`. That comment edit is the ONLY change permitted in that file.

## Traps already hit, do not rediscover

- The gate-pipe hook blocks any command that pipes a test or verification command into
  `grep`/`tail`. Run it as `<command> > /tmp/x.log 2>&1; echo "EXIT=$?"` and grep the log in a
  separate call.
- Do not write a rate-limit test with fake timers. The very first call also waits out the gap,
  so the test hangs for 30 seconds and times out. Use a real 60ms gap and assert elapsed time.
- `packages/datasets` must never import `packages/news`. That is why the keyed client takes a
  structural `KeyedSourceDeclaration` rather than the News connection type.

## Two things to say in the PR body

1. **#2005 landed before this was built**, so the key lookup is wired to its repository rather
   than left as a stand-in. Task 6 is that wiring.
2. **#2005's `NewsPublisherConnectionPort` was deliberately not implemented.** Its
   `NewsConnectionDescriptor` requires `retrievalMethod: "feed" | "scrape"`
   (`packages/news/src/publisher-connection-port.ts`) and an API connection is neither. Filling it
   in would mean either recording a false retrieval method or widening a type that #2005's merged
   routes already read. Raise it on the PR as a question for #2008 instead. Reasoning is in the
   plan under "Drift found against the spec".
3. There is **no live path** for this slice: no route, no manifest entry, no wiring, so nothing
   is reachable through the interface. Say that plainly rather than claiming a live proof.
   Release note section is `Category: N/A`.
4. The repository method in Task 6 has no test, because it is SQL under row security and this
   lane may not run a database test. Record it as an integration gap for #2006.

## Rules that still bind

Plain English in everything a human reads, and pass that on to anything you spawn. Never run a
database-touching test outside the `verify-gate` skill. Never pipe a gate. `git add` by explicit
path only. Report through `node /home/ben/jarv1s-fleet/fleetctl.mjs`. This is relay 1 of 1 - if
you cannot finish, the honest move is a re-slice, not a second relay.
