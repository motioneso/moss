# Meeting summaries with a promoted Codex release

A completed ring recording reached its production Meeting and transcript, but summary readiness
returned `model-unavailable` and automatic generation failed `meeting_output_route_unavailable`.
The constrained runner probe returned `not_installed`. The supported installer returned HTTP 200,
`alreadyInstalled: true`, `binaryChanged: false`, version `0.159.3`: the managed updater correctly
keeps a promoted version above the image's `0.157.1` floor. The summary transport's exact-binary
allowlist did not include that installed version.

No provider credential, selected default, personal override or transcription setting was changed
to diagnose this. A CLI provider's public `hasCredential: false` is intentional DTO behavior and
is not evidence that its sealed credential is absent. A tentative fix based on that inference was
removed before this change.

## Native artifacts

Each official npm archive was verified against its published SHA-512 integrity before extracting
and hashing the native executable. The x64 hash also matches the installed production artifact.

| Version | Architecture | Native SHA-256                                                     |
| ------- | ------------ | ------------------------------------------------------------------ |
| 0.159.3 | x64          | `8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479` |
| 0.159.3 | arm64        | `54a834b6b16d8a01ff80f7f9cee4aedec35a61c90379e088792623bf1b4c1e3d` |

The 0.157.1 floor hashes remain unchanged. Acceptance requires an explicit listed hash; an arbitrary
future managed update does not become eligible for constrained summaries automatically.

## Executed native checks

Run with a claimed dev port and the extracted native executable:

```sh
CONSTRAINED_CODEX_NATIVE=<verified-native> CONSTRAINED_CODEX_TEST_PORT=<claimed> pnpm exec vitest run packages/chat/src/live/constrained-codex-profile.test.ts tests/unit/constrained-codex-catalog-pin.test.ts
```

Before the fix, the 0.159.3 native profile test failed with `ConstrainedCodexUnsupportedError`.
After the fix, both the 0.157.1 and 0.159.3 x64 native profiles passed. The protected loopback
Responses run verifies the configured model, zero outgoing tools, no project instruction tripwire
and no rollout files. Three removal controls enable tools, project instructions or persistence
individually and observe the corresponding behavior. These use synthetic local inference, not a
real credential or private transcript. Additional checks reject unapproved executable bytes
without running the wrapper and resolve an approved artifact through the managed npm layout.

Both ARM archive integrity and native hashes were verified; ARM execution was not performed.
Live Meeting UI acceptance and CI are recorded separately on the PR. These native checks alone
do not establish production summary success.

The new unapproved-byte regression was also run with the shared hash predicate temporarily
replaced by unconditional acceptance. It failed on the resolver's returned unapproved path
(exit 1). Restoring the predicate returned the focused suite to green (exit 0). No mutation
remains in the source.
