# Safe vault-search MCP error details (#1883)

**Status:** Approved by Ben on 2026-08-23 after Moss reported that vault search failed while the
MCP tool swallowed the underlying cause.

## Outcome

When vault search fails, its MCP response preserves enough safe cause detail to distinguish common
operational failures such as connection refusal, upstream HTTP failure, and timeout. Moss can then
explain what is broken instead of returning an opaque generic error.

## Required behavior

- Keep the existing successful vault-search response unchanged.
- On failure, retain the existing MCP error contract and add the smallest safe actionable cause
  detail already available from the underlying exception.
- Prefer stable error classification/status information over a raw exception dump.
- Never return credentials, tokens, private vault content, embedding inputs, database values, or
  stack traces.
- Preserve the original failure as the server-side cause for logs/debugging.

## Verification

- A focused regression test injects representative dependency failures at the real MCP boundary
  and proves the returned result distinguishes them safely.
- The test fails against the current swallowed-error behavior and passes after the fix.
- Re-run the real vault-search request and use the surfaced detail to identify the current outage.

## Non-goals

- Redesigning all MCP errors.
- Exposing raw upstream response bodies.
- Fixing an unrelated dependency before its actual failure is identified.

