# Meeting summaries through the configured default provider

Approved intent: summaries should use the configured default provider when no separate Meeting
model setting exists. The current runtime already selects the effective default, including admin
locks and explicit user overrides, but rejects every subscription provider except Anthropic.

## Behavior

Keep the existing effective-default selection; do not add another model picker. No provider or
model name belongs in Meeting routing. Keep capability checks and reject unavailable explicit
routes rather than substituting a provider. API-key models keep the existing shared structured
adapter. CLI models use the constrained structured port and a probe for the selected provider.

Extend that port with a Codex one-shot profile alongside Claude. Keep each provider's launch
configuration inside its transport. Use the configured model verbatim, a fresh owner-scoped home,
bounded stdin/stdout, schema output, cancellation and process-group cleanup. Do not reuse coding
chat or attach Moss tools. Preserve signed shared-login refresh reconciliation before removing
per-call files. Unimplemented CLI profiles report transport unavailability, without fallback.

## Verification

Exercise the pinned native Codex artifact against a loopback Responses fixture, observing its
outgoing tool set, JSON result and session persistence. Removal controls must expose the missing
protection. Cover provider-aware readiness, the exact selected Codex model, unsupported CLI
profiles, API-key/Claude regressions, configuration-change rejection and output validation.
Run the repository checks and record live UI proof on a disposable instance before merge.

This change does not reimport recordings, alter existing Meeting notes, attach recovered audio,
or deploy automatically. Long-input chunking remains a separate concern from provider routing.
