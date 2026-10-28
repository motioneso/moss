# N3 O2b2b runner wiring plan

Spec: `docs/superpowers/specs/2026-10-27-n3-o2b2b-runner-wiring.md`. Issue #3529.

## Slice a

1. Add an optional run id to `provisionForUat` dependencies so callers choose the project name.
2. In the worker, set the lifecycle directory and nonce, build the observer option, build the
   authority record from independent reads, and construct `InstalledCollector`.
3. Call `provisionForUat` with the option and collector. After it returns, call
   `collector.compose()` and open the consumer. Close it in cleanup.
4. Keep the guard in place. Fake controls cover the new worker steps.

## Slice b

1. Add a file handshake helper shared by worker and spec.
2. Wrap each chat turn in the spec with window-open and window-finish steps.
3. Worker polls for requests, drives `beginWindow` and `finishWindow`.

## Slice c

1. Enforce the twelve-minute run and two-minute cleanup as one deadline.
2. Order teardown: close consumer, record receipts, remove credentials, then volumes.
3. Report retained resources on any uncertainty.

## Slice d

1. Read what changed on main in the six frozen files and review it.
2. Refresh the base commit and the frozen source map, and fix the installed-evidence test.
3. Remove `requireFallbackObserver()` and rewrite the self-test to assert the wiring.
4. Live run under the verify-gate launcher, evidence posted to the pull request.

## Verification

Offline controls per slice. Live run only after slice d, with a claimed dev port, the CLI
sign-in, the cheapest model and no faked data.
