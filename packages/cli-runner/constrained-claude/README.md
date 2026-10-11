# Constrained Claude structured runner: source evidence

## Scope and trust boundary

This profile limits what untrusted meeting transcript text can make the model do. It runs in
Moss's existing runner under the owner's existing per-user identity. Each call gets a fresh
private HOME/config directory, an empty native-tool set, no inherited Moss hooks/skills/MCP,
no saved provider session, and a subprocess the caller terminates on completion or cancellation.

Organization-managed policy is trusted administrator configuration, outside this transcript
threat model. Claude may apply managed hooks or other managed settings. This implementation
neither inspects nor suppresses that policy and makes no claim that all administrator hooks
are disabled. It does not fetch account profiles, classify subscriptions, require a personal
plan, alter authentication, create a new container, or relax container security settings.

Moss's production Compose uses `/data/cli-auth`; `per-user-structured.ts` gives each owner an
agent home and neutral working directory. This profile receives a new per-call private home
created through owner-scoped I/O instead of reusing that owner's regular Claude configuration.
The existing saved OAuth token is the only authentication field passed to the child. The
caller must strip `childIdentity.env` when invoking the shared process runner, because that
runner otherwise merges identity environment fields over the explicit profile.

## Inspected published artifacts

The install recipe pins Claude Code **2.1.282**. Both official native packages were downloaded
without running their installation scripts; their tarball integrity matched
`packages/cli-runner/recipes/anthropic/npm-shrinkwrap.json`.

Linux x64 package: `@anthropic-ai/claude-code-linux-x64@2.1.282`.

```text
Tarball: sha512-iuegTPhk/134MJiuyNDD6gW2SNDRkHoPDK6XK+lrhzyISLyNpKCuFUpIHKTfxkp4RbWQgH2Dtnp1rYxmJTzEOQ==
Executable SHA-256: 3afe8535c0cc33f0e24f7b25dab7a1727b8b592196f8496a8bc302ba2161eed3
```

Linux arm64 package: `@anthropic-ai/claude-code-linux-arm64@2.1.282`.

```text
Executable SHA-256: 6764ffc39e9fed425a493ff61ea28506d1ba83996ce81a48d1177dbb393419c9
```

`constrained-claude-profile.ts` hashes the managed executable without executing it and accepts
only these source-reviewed bytes. Other versions require explicit re-verification. The managed
installation is trusted not to replace the executable between verification and launch. No
credential, transcript, or provider request is needed for this check.

The matching Agent SDK 0.3.282 ships native executables and a client transport, not an alternate
standalone `cli.js`. There is no SDK migration in this change.

## Source map

Locations below are byte offsets in the exact Linux x64 executable's embedded JavaScript;
other platform builds have different offsets. The required configuration names and flags
were also located in the integrity-verified arm64 artifact. Only x64 was executed locally.

| Behavior                                                                 | Source evidence                                                                                                        | Design consequence                                                                             |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Bare mode excludes subscription OAuth                                    | `fo()` around 194122642 and `dF()` around 197174972                                                                    | Do not use `--bare`                                                                            |
| Safe mode disables discovered customizations but retains managed hooks   | Hook resolver around 197593450; mode gate around 199276588                                                             | Use safe mode for inherited local configuration, with the administrator-policy exception above |
| User-controlled hook-disable setting retains managed hooks               | Same resolver around 197593450                                                                                         | Do not call this an all-admin-hooks disable switch                                             |
| Hook aggregation includes settings/plugin/session sources                | `Wwe()` around 199668693                                                                                               | No explicit SDK/session hooks or plugins supplied                                              |
| Empty native tools are an explicit supported selection                   | CLI option around 210766665; `oMo()` around 208330224 and `Yrr()` around 208331907                                     | Preserve an actual empty-string argument after `--tools`                                       |
| JSON-schema output adds its internal formatter after base-tool selection | Around 210184000, schema construction appends the output formatter; its validator/result-only call is around 199565579 | Empty native tools does not remove the structured-result mechanism                             |
| No-session flag is restricted to print mode                              | Around 210177537 invokes `DBr(true)`; `DBr()` around 194087784 sets persistence-disabled state                         | Pair print mode with `--no-session-persistence`                                                |

Official context: [CLI reference](https://code.claude.com/docs/en/cli-reference) and
[programmatic execution](https://code.claude.com/docs/en/headless). The inspected pinned source
is the compatibility basis; current documentation can describe newer releases.

## Launch contract

The profile returns separate executable, argument, and environment fields. It does not receive
transcript content and performs no authentication/network call. Its fixed options are:

```text
--print
--safe-mode
--setting-sources ""
--settings '{"disableAllHooks":true}'
--disable-slash-commands
--tools ""
--strict-mcp-config
--permission-mode dontAsk
--no-session-persistence
--output-format json
--json-schema <requested-schema>
--model <selected-model, when present>
```

The quotes illustrate argument values, not shell interpolation. Transcript content travels
through stdin. The environment is constructed from scratch: fresh HOME/config/temp paths,
minimal PATH/locale, the existing token, disabled auto-update, and disabled nonessential
traffic. No arbitrary parent/identity environment, new session ID, resume flag, MCP server,
plugin, additional directory, or account-type override is supplied.

The output parser requires a successful Claude result envelope. Object results are serialized;
string results, including whole-reply JSON fences, pass unchanged to shared structured parsing
and schema validation. Provider errors and malformed envelopes become fixed protocol errors
without including private diagnostics. Output-size limits and process termination belong to
`runConstrainedStructuredProcess`; profile setup is not a substitute for that lifecycle.

## Native proof and remaining limits

Opt-in fixtures in `constrained-claude-profile.test.ts` execute the hash-checked published
binary. They use synthetic configuration and transcript text, a dummy API key where needed,
and localhost-only API/proxy destinations. No actual subscription credentials or vendor
requests are used. A loopback HTTP server supplies synthetic Anthropic-protocol streaming
responses; this proves the CLI's local behavior, not a real model's judgment.

Observed on the pinned Linux x64 binary, with a separate removal control for each property:

| Property                 | Protected invocation                                                                                         | Protection removed                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Inherited local hooks    | Hostile user/project/local SessionStart marker absent; startup exits zero                                    | Removing customization/hook protections makes the marker execute                                    |
| Native tool availability | Actual outgoing model request contains only `StructuredOutput`; valid structured result completes            | Removing only the empty `--tools` selection exposes Bash, Read, Write, and other built-in tools     |
| Session persistence      | Completed synthetic model turn leaves zero `.jsonl` transcript files in the private home                     | Removing only `--no-session-persistence` creates a real project session transcript                  |
| Cancellation             | Abort while native CLI waits on loopback inference produces a cancelled result and the process group is gone | Omitting the cancellation signal leaves the native call pending; the separate timeout then kills it |

The hook test uses `--init-only` without credentials or a model turn. The tool and persistence
tests run complete native model-protocol turns against the synthetic loopback service. The
cancellation test deliberately withholds its response. Its negative control retains a timeout
so the test cannot leave an orphan process.

The custom API origin changes managed-policy eligibility, which these fixtures do not claim
to test. Organization-managed policy remains outside the transcript threat boundary. x64 was
executed; arm64 was integrity/source checked only. Subscription connectivity and behavior of a
real provider model remain unverified. Do not present these fixtures as user-facing live-path
proof or evidence that a particular production login works.

To repeat after materializing the official artifact locally:

```text
MOSS_TEST_CLAUDE_NATIVE_BINARY=<absolute-pinned-executable> node_modules/.bin/vitest run packages/chat/src/live/constrained-claude-profile.test.ts
```

## Packaging constraint

The vendor's [integration conditions](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)
require the published binary to remain unmodified. This profile is an external wrapper around
that executable; it neither patches the vendor code nor changes its authentication mechanism.
