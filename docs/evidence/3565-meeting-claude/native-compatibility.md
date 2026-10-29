# Meeting summaries with a promoted Claude release

A completed ring recording reached its production Meeting and transcript, but summary readiness
returned `model-unavailable` and generation failed `meeting_output_route_unavailable`. The
installed Anthropic CLI was 2.1.286. The summary transport's exact-version allowlist held only
2.1.282, so the constrained probe returned `not_installed`. An earlier `meeting_output_provider_failed`
attempt ran on Codex during a transient vendor fault and is unrelated.

No credential, selected default or transcription setting was changed to diagnose this.

## Native artifacts

Each official npm archive was verified against its published SHA-512 integrity before extracting
and hashing the native executable.

| Version | Architecture | Archive SHA-512 (base64)                                                                   | Native SHA-256                                                     |
| ------- | ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 2.1.286 | x64          | `PnVL8ZCEev3IexLeOc9/QRfqRDUZRgnsaMLdpjlBN0VaieeTrf7mZ2JJi29ue2KAqHvq6SsOadU5G/shnFE4MA==` | `fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f` |
| 2.1.286 | arm64        | `dHQ/ObyC4jaGHVk+gFE8P8PALMIVLhQSyhiC3y3kkuLp0H0MHgLxHt/srQ3zJs892ClDbtl1swxv4bw1ioruZA==` | `0292fa22ac2fd43e16be9d0e511ddd8347280d6e0ebaca744ef5b27e05d8d0f8` |

The 2.1.282 floor hashes are unchanged and the floor x64 archive was re-verified
(`sha512-iuegTPhk...zEOQ==`, native `3afe8535...eed3`). Acceptance requires an explicit listed
hash. An arbitrary future update does not become eligible.

## Executed native checks

```sh
MOSS_TEST_CLAUDE_NATIVE_BINARY=<verified-native> pnpm exec vitest run packages/chat/src/live/constrained-claude-profile.test.ts
```

- Before the change, the 2.1.286 x64 native run failed 4 tests with
  `ConstrainedClaudeUnsupportedError` (exit 1).
- After the change, the 2.1.286 x64 run passed (exit 0), as did the 2.1.282 x64 floor.
- The native tests show hostile inherited hooks do not execute, only the output formatter is
  offered as a tool, no session transcript is saved, and cancellation kills a stalled process.
  Each protection has a removal control that observes the unprotected behavior. These use
  synthetic local inference, not a real credential or private transcript.
- arm64 archive integrity and native hashes were verified; arm64 execution was not performed.
- With the shared hash predicate temporarily replaced by unconditional acceptance, the new
  rejection regression failed (exit 1). Restoring it returned the suite to green. No mutation
  remains in the source.

Live Meeting UI acceptance and CI are recorded separately on the PR. These checks alone do not
establish production summary success.
