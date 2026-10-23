# Constrained Codex summary transport

The Meeting runtime keeps the effective chat default (administrator lock and enabled user
override included). It requests structured summarization without selecting a vendor or
substituting a model. API-key routes keep the shared HTTP adapter. Subscription routes require
an implemented constrained adapter; this change adds Codex alongside Claude. Google CLI and
other unimplemented profiles remain unavailable without fallback.

## Artifact and source inspected

Codex 0.157.1, source tag `rust-v0.157.1`, commit
`ac0e23e5232692b95268583c8278c50b8c436d2b` in `openai/codex`. The managed runner recipe's
platform tarballs were verified against their locked SHA-512 npm integrity before extracting
and hashing native executables. Linux SHA-256:

| Architecture | Digest                                                             |
| ------------ | ------------------------------------------------------------------ |
| x64          | `3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970` |
| arm64        | `9cbc3cdcc18ca336523ffa7d64207a1ae1f5991f823081d0a37bcb3a748de093` |

Relevant upstream source: `codex-rs/core/src/tools/spec_plan.rs` (tool construction),
`codex-rs/protocol/src/openai_models.rs` (catalog fields),
`codex-rs/models-manager/src/model_info.rs` (metadata),
`codex-rs/core/src/config/mod.rs` and its `config.schema.json` (configuration), and
`codex-rs/exec` (ephemeral execution and schema output). The binary finder admits only the
pinned native bytes; catalog/recipe tests fail when the managed version changes.

## Launch and proof

The runner creates a fresh owner home and seeds only its reconciled Codex login. It writes a
minimal model catalog retaining the exact configured model slug, with disabled shell, no patch
or experimental tools, and direct tool mode. Generated config disables project instructions,
web search, planning, user input, shell/image/multi-agent/app/plugin/hook features. The process
receives explicit HOME/CODEX_HOME/TMPDIR/PATH/LANG, without inherited endpoint overrides. Prompt
travels on stdin. Schema is a private file. The existing bounded process runner enforces output,
time, cancellation and process-group cleanup. Release reconciles refreshed login before removing
the temporary home; existing shared-login signature and same-account checks still govern promotion.

The opt-in native test uses the real x64 executable and a loopback synthetic Responses SSE
server. It observes outgoing requests and files, with these controls:

| Configuration                             | Observed assertion                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Protected profile                         | Exact selected model, zero advertised tools, no project instruction marker, no JSONL rollout |
| Shell feature plus shell catalog restored | Tools advertised                                                                             |
| `--ephemeral` removed                     | JSONL rollout created                                                                        |
| Project instruction byte limit restored   | AGENTS marker reaches inference request                                                      |

Run the committed `constrained-codex-profile.test.ts` with `CONSTRAINED_CODEX_NATIVE` pointing
at the pinned executable and `CONSTRAINED_CODEX_TEST_PORT` set to a claimed dev port. No login,
real transcript, or vendor inference is used by this native fixture. The arm64 artifact is
integrity/hash verified; native execution evidence is x64 only.

Organization-managed policy remains trusted configuration, as with the existing Claude
profile. These controls address untrusted transcript-induced actions, not hostile administrators.
No cgroup guarantee against detached processes is claimed. Ephemeral proof concerns JSONL
session rollouts, not an assertion that the CLI creates no temporary files.

The shared escaped-input limit remains 65,536 bytes. This transport change does not establish
whole two-hour transcript coverage, audio/ASR correctness, or model quality. Real subscription
UI proof is a separate `3574-meeting-default-provider-real.uat.spec.ts` run on a disposable stack,
with short synthetic speech and the dynamically discovered economy model.
