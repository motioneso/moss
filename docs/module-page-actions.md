# Actions from an external module page

The host passes an optional `tools: ExternalModuleToolsHandleV1` prop to the module's Root.
Import its type from `@moss/module-web-sdk`. Call it from a deliberate user action and await the
outcome before showing saved state. The host binds the module identity, so a page cannot use this
handle to invoke another module's tools. The matching tool must be declared in the installed,
enabled module manifest. Give it a short, plain `actionLabel` for confirmation copy.

```tsx
import type { ExternalModuleToolsHandleV1 } from "@moss/module-web-sdk";

async function save(
  tools: ExternalModuleToolsHandleV1 | undefined,
  input: Record<string, unknown>
) {
  if (!tools) return { message: "Update Moss before saving changes from this page." };
  const outcome = await tools.invoke("example.entry.save", input);
  switch (outcome.status) {
    case "succeeded":
      return { result: outcome.result };
    case "cancelled":
      return { message: "Cancelled. Your entries are still here." };
    case "rejected":
      return { message: "Check your entries before saving.", code: outcome.moduleCode };
    case "invalid_input":
      return { message: "Check the required fields." };
    case "failed":
      return { message: "Refresh and check whether the change saved before trying again." };
  }
}
```

Use actual module schemas and domain result checks in the caller. Keep the draft visible on any
non-success. Module rejection exposes only a vetted identifier code; map known codes to useful
local copy and never display raw transport errors. A missing handle means an older host; do not
fall back to the read route or present a queue acknowledgment as a completed write.

The host snapshots JSON input when invoked and owns the shared confirmation dialog. Ordinary
page writes follow the tool's confirmation hook; destructive and outbound tools always confirm.
Cancel and Escape do not resubmit the operation. One operation can be pending per mounted module;
disable conflicting controls until the promise resolves. Navigation or an actor change abandons
the pending UI. The server also checks owner, input digest, expiry and single use.

The handle does not automatically retry a failed transport. A worker may have committed before
the response failed. Use stable operation identities and replay-safe domain writes where a user
may retry. Keep the same identity and original fields until the result can be checked. Confirming
is a single retry of the original validated input with the host-issued confirmation ID, not a
second independent user operation.

Inputs must be finite JSON objects, at most 900,000 UTF-8 bytes and 64 levels deep. Functions,
Date objects and undefined values are rejected. Put financial/free-text inputs in this direct
request body; metadata-only job queues are not a substitute. Executed writes record metadata in
Activity with source Module page. Worker writes and the platform activity insert are separate
transactions; a missing response or activity record alone does not prove that nothing changed.

Verification examples live in `tests/unit/module-tools-controller.test.ts`,
`scripts/module-tools-ui-check.ts` (explicit HTTP fixture) and
`tests/integration/finance-page-live.test.ts` (opt-in actual installed app, throwaway database).
The installed proof module's outbound recipient is an explicitly synthetic stand-in; no real
message is sent. Run database checks only through the repository's verify-gate procedure.
