# Reminder edit refusal

## Cause and confidence

The leading explanation is a model reply containing valid JSON inside a Markdown code block.
Confidence is moderate for the historical failure, and high for the reproduced parsing defect.
The failed run did not capture the reply or a failure reason, so its actual cause remains unproven.
No live model or proxy was called to resolve that uncertainty.

The API reply parser rejected the wrapper before the edit could be checked.
The command-line reply parser already removed that same wrapper.
A fake API reply reproduces the reported refusal for the exact combined text-and-time request.
The same reply without the wrapper succeeds before the fix.
With the fix, both forms succeed on one attempt.

Other plausible explanations are a rejected provider schema or an invalid model answer.
Those remain honest refusals; the change does not relax the schema or guess missing terms.
A target absent from the request produces a different reply, so that check does not explain
this particular refusal.
The missing usage log does not narrow the cause: the prepared call does not receive a logger.
Elapsed time alone does not establish that the provider returned a usable answer.

## Code trace

1. `prepareReminderEdit` recognizes the request, reads owned editable reminders and selects the
   configured JSON-capable model. Destination-only edits have a deterministic path. Combined
   destination edits are refused before model dispatch.
2. `prepareStructuredGeneration` copies the request, checks prompt/schema bounds and prepares one
   provider attempt while the owner transaction is open. Execution happens after that transaction.
3. The transport selection reads the provider configuration and decrypts its sealed credential.
   API-key authentication selects the HTTP adapter; command-line authentication uses its injected
   adapter instead. The model's configured provider kind controls the request format, not its name.
4. `HttpApiAdapter` sends the selected provider request and extracts the structured reply.
   For an OpenAI-compatible proxy, the request uses chat completions with strict JSON schema in
   the response-format field. The schema is not duplicated into the message text.
5. The reply extractor parses API text directly. Previously it did not remove a code block.
   Command-line text passed through the existing wrapper remover before parsing instead.
6. The generated object must pass the local JSON schema check, then the reminder field checks,
   then the target and destination checks. Passing produces an edit proposal, not a database save.

The native Anthropic request forces a named structured tool, and the reply must contain its
object input. A text-only answer is refused even if it contains valid JSON.
Google requests ask for JSON using the provider's response schema and parse the returned text.
The Responses API path also parses text, but is not selected for this reminder call.
The minimal parser change covers those text formats using the existing wrapper remover.

## Every false generation result

- Configuration missing: no provider row, no injected command-line adapter, decryption failure,
  or an invalid decrypted credential.
- Unsupported provider kind: provider failure. A missing API-only compatibility provider also
  becomes a configuration failure, but the reminder does not use that compatibility entry point.
- A second execution of the prepared closure: provider failure. The closure is single-use.
- Cancellation before, during or after dispatch: aborted; a recognized timeout carries its reason.
- Unavailable structured transport: unsupported transport.
- Invalid output JSON, missing response text, or a missing required structured tool: JSON parse
  failure after the single attempt. Repair messages are constructed but no retry is made here.
- Output beyond the local byte limit: oversized output. This applies to original command-line
  text and serialized output objects. The API text is parsed before its object-size check.
- An object rejected by the local JSON schema: schema validation, with its schema keyword/path.
- Other provider exceptions: provider failure, or a recognized timeout, invalid response body or
  output-limit reason. HTTP rejection, including schema rejection, reaches this path.

Input bound violations, invalid schema compilation and unexpected preparation errors throw
rather than returning false. They are distinct from a normal false generation result.

## Every reminder field rejection

`validateReminderEdit` rejects:

- Missing/non-object input or an array.
- Unknown property names, or missing required properties. Its direct checker permits omitted
  repeat/destination, but the preceding JSON schema requires all nine fields on this path.
- A non-boolean unsupported flag.
- A destination other than omitted, null, or a nonblank string of at most 500 characters.
- A target other than null or a string of at most 500 characters.
- Replacement text other than null or a nonblank string of at most 500 characters.
- A relative delay other than null or an integer from 1 through 2592000.
- A deadline mode whose string value is not keep, set or remove. The preceding schema additionally
  requires a string, so values merely coercible to those words do not pass generation.
- A non-null local due/deadline value that is not a string in YYYY-MM-DDTHH:mm form.
  This check verifies shape; calendar validity and future-time checks happen when resolving terms.
- Repetition other than omitted, null, remove, an exact daily/weekly object containing only its
  kind, or an interval object containing exactly kind and integer seconds from 60 through 86399.
- Both a local time and a relative delay being supplied.
- Deadline mode set without a non-null local deadline, or a non-set mode with a local deadline.

The existing due-at timestamp is context supplied to the model, not an editable output field.
Returning dueAt or snake-case field names adds unsupported properties and fails the schema.
Local output timestamps must omit seconds, UTC suffixes and offsets.
Unchanged values use JSON null; the string "null" is not a substitute.

After these checks, a non-null target must occur in the owner's request after case, punctuation
and whitespace normalization. A destination must also occur there. Combined destination changes,
unsupported changes, no owned target match and an edit with no changes each have separate refusals.
These safeguards remain in place.

## Changes

- `packages/ai/src/adapters/http-api-structured.ts`: reuse the existing whole-code-block remover
  before parsing API text. Prose around JSON and malformed JSON still fail.
- `packages/chat/src/reminders/prepare-edit.ts`: all returned edit refusals write one warning with
  a fixed reason code. Generation failures retain their existing typed reason; invalid edit terms
  and each subsequent refusal have distinct fixed codes. Logs contain no request or provider text.
- `packages/chat/src/reminders/features.ts`: keep the app map accurate about wrapped valid replies.
- `tests/unit/chat-reminder-edit-refusal.test.ts`: exercise the real prepared API path with fake
  HTTP replies and a recording database driver. No socket or database connection is used.
- This report records the trace and verification.

## Verification

Initial reproduction: the new focused suite had one passing test and seven failing tests.
The plain reply succeeded; the wrapped reply was refused; six diagnostic assertions showed
that refusals previously wrote no warning. The focused suite then passed all eight tests after
applying the fix. Additional negative cases were added before the broader verification.

The first broader run passed 239 files. It caught an overlong app-map description and one
new assertion that expected a field rejection rather than the earlier schema rejection.
Both were corrected. The expanded focused suite then passed all 18 tests.

Completed static checks:

- `pnpm --filter @moss/chat typecheck`: passed.
- `pnpm --filter @moss/ai typecheck`: passed.
- `pnpm exec tsc -p tsconfig.tests.json --noEmit`: passed.

- ESLint on all four changed TypeScript files with `--max-warnings=0`: passed.
- Prettier on all changed files: passed.
- `git diff --check`: passed.

Final broader unit command:

```sh
pnpm test:unit tests/unit/ai- tests/unit/chat- packages/ai/src/structured packages/ai/src/gateway/per-call-resolver.test.ts packages/ai/src/gateway/policy.test.ts packages/chat/src
```

Result: 241 files passed; 3010 tests passed and 4 skipped. Exit status 0.
This includes the final 18-case regression suite and the app-map declaration validation.

The full foundation gate and all database-touching tests were excluded as requested.
Dependencies were installed from the offline cache with lifecycle scripts disabled.
No model, proxy, Docker or real database was used. No credential files were opened.
No server or browser was started. The branch is committed locally and has not been pushed.
The real-model failure remains unverified; only the offline parsing defect is proven fixed.
