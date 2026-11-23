# Phase 6 part 3 — module publish review proof

Task JS-405; plan row 3 / M; package/registry spec section 5.5. Built on parts 1 and 2 at
`5057f55c1`. This slice is internal tooling; no app screens, settings or app-map behavior changes.

## Delivered

- `rust-spike/module-publisher/` has real `review` and `publish` CLI commands. The candidate and
  latest prior version come from authenticated bytes, not submitted manifest summaries.
- Host archive, manifest/model-field, publisher-name/signature, Wasmtime import, SQL subset and
  unchanged-migration checks are reused. Historical-package parsing shares those canonical
  structural checks without requiring an old release to run on the candidate's Moss version;
  candidate and installer compatibility checks remain in place.
- Host permission comparison marks operation/resource/private-access and permission metadata
  growth. Fetch and credential broker destinations are also diffed explicitly. Removals alone
  need no approval. New publisher means an actual public key absent from the registry's published
  history, rather than a changed display name or key alias.
- `Index.publish_reviews` serializes as `publishReviews`, keyed by package digest. Each signed
  record contains the computed request/diff and optional signed human approval. Existing Index
  literals receive empty maps; this is the only change in module fixtures and server harnesses.
- Moss policy waits for a trusted human signature for new publishers, capabilities or fetch
  destinations. The request binds registry identity, exact base index digest, candidate/prior
  digests, publisher alias/public key and diff. All supplied approvals are checked, including
  under self-hosted policy. Human signing keys are not part of this tool.
- Publication outputs an exact index JSON string plus detached signature after all checks pass;
  it does not upload, stage files or mutate the source registry. The index key must match the
  trusted signing key. Serial increases, history/revocations are retained and expiry is renewed.
  Protected policy configuration and serialized staging remain the release owner's responsibility.

## Failing first

The real CLI integration suite first ran against a stub:

```text
test result: FAILED. 0 passed; 18 failed; 0 ignored
```

A later test exposed the historical-version issue before its fix:

```text
prior_for_an_older_moss_version_can_be_compared ... FAILED
This module needs a different Moss version
```

After the fix, both historical comparison and incompatible-candidate refusal pass.

## Executed checks

From `~/Jarv1s`, unpiped commands with explicit Rust environment:

```bash
RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js405-target \
  pnpm test:rust-module-publisher
RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js405-target \
  PUBLISH_REVIEW_PROOF_DIR=/tmp/js405-negative-reviewed \
  python3 rust-spike/module-publisher/tools/negative-controls.py
pnpm lint
pnpm format:check
pnpm check:file-size
pnpm typecheck
```

Focused runner: **37 passed, exit 0**. The control runner uses one cargo build at a time,
`CARGO_BUILD_JOBS=2`, dev/test debug info off. It restores original source bytes in `finally`.
**35 guard-removal controls failed at test assertions**, followed by **37 passing tests, exit 0**.
A compiler error or a different refusal reason does not count as a successful control.
Refusal controls require unexpected acceptance; growth-marker controls require a failed marker
assertion. The immutable-SQL fixture declares its owned table, so removing the immutability
guard accepts the changed SQL rather than tripping an unrelated ownership check. An initial control trial hit a type
inference error; the final complete run corrected it and passed all controls.

Controls cover archive/manifest/import/SQL/model/publisher checks, same/downgraded/non-latest
versions, changed old SQL, tampered prior index/package, publisher-only review, capability/host
review and signed growth markers, valid human signatures bound to wrong digest/diff, changed
candidate/base, untrusted reviewer, forged signature, candidate compatibility, wrong registry,
expired base, wrong index key, input size and serial exhaustion. Fixtures generate fresh
Ed25519 keys in temporary directories; no private keys or external credentials are in source.

## Independent review follow-up

Read-only Claude review of `4303efaa5` found no major or blocker issues. Its first three minor
findings are addressed: credential-host and existing-publisher/new-module coverage, unchanged and
removed hosts, a real host round trip of the emitted signed index, the shared host index-size
limit, and refusal of blocked digests/publishers using the existing host revocation policy.
Warnings still permit publication. The additional refusal tests were observed failing before
their guards were added (34 passed, 3 failed), then green. Their guard-removal controls are part
of the final count above. Existing host regression suites passed 19 boundary and 9 registry tests;
the pre-existing real-TLS test was ignored.

The remaining minor finding is accepted and documented: historical review supports today's
schema/ABI only, and indexes with `publishReviews` require an updated host. A future schema/ABI
migration needs an explicit historical decoder and coordinated host/index rollout. No older
format compatibility is claimed by this slice. Final independent review output is in the task
proof artifact.

## Not proven by this slice

- Production registry uploads, release secret custody, concurrent/atomic staging and installer
  bundle integration belong to parts 4 and 5.
- No database, browser or installed-app journey was run for this internal CLI slice. Broader
  Phase 6 lifecycle/UI proofs remain with their owning parts.
- No claim of a full foundation gate or cross-platform build matrix.

The Herdr proof artifact carries current command output and the independent review result.
