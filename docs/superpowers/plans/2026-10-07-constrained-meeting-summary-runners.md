# Default-model meeting summaries with constrained subscription runners

## Approved scope

Meeting summaries use the signed-in person's effective default model, through the same
canonical resolver as chat. Administrator locks remain authoritative. An unavailable enabled
user override fails closed; no alternate model or provider is chosen. API-key providers retain
the existing bounded structured request. Claude subscriptions receive a separate, explicitly selected constrained profile. Codex
subscriptions fail plainly before credentials or transcript dispatch; there is no fallback.

The threat is untrusted transcript and note text inducing extra model actions. Organization
administrator policy is trusted configuration outside that threat model. This work does not
classify accounts, fetch account profiles, suppress organization-managed Claude policy, add a
container, or relax deployment capabilities/seccomp. It does not migrate other background
structured callers.

## Implementation boundary

1. Prepare an exact, schema-bound, single-use request inside short actor transactions, then run
   the provider outside those transactions. Recheck the selected model/provider fingerprint
   before dispatch and before releasing output.
2. Carry an explicit constrained-profile marker through the existing authenticated runner RPC.
   Require the runner's owner identity; never fall back to an ordinary engine. Launch preparation
   receives the fixed schema and model, not the transcript. Submission starts a fresh child and
   returns promptly so cancellation is not queued behind inference.
3. Use bounded stdin/stdout/stderr, fixed error messages, and original-process-group termination.
   Termination and stopper helpers have their own deadlines. Cleanup follows confirmed close;
   uncertain termination retains working files rather than deleting beneath a live process.
   This is not a cgroup guarantee against deliberately detached processes.
4. Claude uses the published, integrity-checked pinned binary, fresh per-call HOME/config,
   empty native tools, strict MCP configuration, local customization suppression and
   no-session-persistence. The existing token is passed only through the credential environment.
   Organization-managed hooks may still apply. See the constrained Claude source-evidence file.
5. Codex remains unsupported for summaries. The pinned CLI's configuration flags do not expose
   its internal empty-tool policy, and the existing exec path is not a cancellable tool-free
   transport. The pinned helper proposal is tracked in [#3092](https://github.com/motioneso/moss/issues/3092), not a new language, toolchain,
   binary, image stage or runtime dependency in this PR.
6. The shared parser accepts one complete JSON-fenced reply, rejects surrounding prose/multiple
   values, bounds bytes before parsing, then validates the original schema and exact evidence.

## Packaging and compatibility

The existing managed Claude installation supplies the exact verified Linux x64 or arm64 binary.
Missing binaries, unsupported versions or unavailable credentials fail plainly without fallback.
No new environment setting, container, capability, toolchain or deployment topology is required.

Commit order is runner infrastructure first, meeting routing/behavior second. The new PR is
based on current main. The later meetings-stack reconciliation must preserve its additional
capture-gap notices, automatic-summary behavior and settings. Product Settings wording is a
separate commit on the existing settings branch; the matching original mockup is another
separate commit. Neither change imports the feature stack into this PR.

## Verification requirements

- API-key and subscription synthetic transports, exact default/override/admin behavior, route
  mutation/revocation, aborts, schema/source/size limits, and no provider fallback
- Real pinned Claude binary against local synthetic fixtures: tool exposure, local hooks,
  session files, and lifecycle controls, with corresponding removed-protection failures
- Codex unsupported metadata, disabled generation, and zero credential/provider/CLI dispatch
- Scoped and root types/lint/format, app map, file-size and available repository gates
- Independent security review and exact-commit CI before claiming verification

No real provider request, credential inspection, audio capture or production operation is
part of this implementation work. Local test success does not establish live subscription
login or model quality. The new native-CLI CI job repeats the same credential-free Claude fixtures using the committed
package-integrity recipe.

## Existing callers deliberately left on their current profile

News/Sports extraction and sorting questions; connector/email ingestion and refresh;
commitment/email-thread judgement; briefing synthesis and source context; classifier
preparation and focus judgement; model-native web search; persona preview; Workshop
structured work; and the external-module structured-generation bridge. Their migration
requires separate review and is not implied by this summary-specific change.
