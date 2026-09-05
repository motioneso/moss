# Response to Fable’s Workshop spec review

Date: 2026-09-04. Source checked at `cd0468307` in `~/Jarv1s`.
Responds to [Fable’s review](2026-09-04-workshop-spec-adversarial-review.md).
Changes are in the [implementation spec](../superpowers/specs/2026-09-04-workshop-projects-and-supervised-builds.md).
The original review is preserved unchanged.

**Verdict:** agree that the spec was too early to call ready for implementation planning. The
product design remains approved. The revised spec is explicitly not build-ready until the
execution-boundary design and missing UI state review are complete. Two findings need correction:
storage is implemented, and retaining settings-owned build records does not inherently violate
isolation when accessed through its public API. Neither correction proves the full Workshop works.

| Finding                              | Decision                                                                 | Action/status                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Saved-word storage                | Push back on cited evidence; accept an integration prerequisite.         | Executed the real validator with a user-scoped namespace: accepted. Spec now names the full queue → worker KV → read-tool path and the actual draft-status rejection that needs fixing/proving.                                      |
| 2. Cross-module persistence          | Clarify; no table move required.                                         | Settings already exports build operations publicly. Spec explicitly keeps its table/migrations there and forbids Workshop’s direct table access. Add expected-state/lease operations to that public API.                             |
| 3. Confinement                       | Agree; unresolved prerequisite.                                          | Separate design and deployment feasibility proof comes before builder coding. No assumption that a nested sandbox or standalone worker container exists. Dev/prod configuration remains part of the same capability PR.              |
| 4. Design coverage and mockup format | Agree on missing states and format; disagree with class-count reasoning. | Added named host primitives and a required supplementary state sheet. Chose a bounded raster MockupV1 artifact manifest, avoiding a new executable UI language. New states still need review.                                        |
| 5. Private-finish impact             | Agree.                                                                   | Added the concrete persistence, SQL, resolver, asset, queue, worker, serializer, navigation, export/removal consumer checklist. Centralize policy; do not paste filters into every file.                                             |
| 6. Planning recovery                 | Agree; found a further service-key issue.                                | Existing settings page lacks a Workshop service row. Specify that row, its valid namespace/key/API, binding migration, pin recovery, and same-project retry.                                                                         |
| 7. Failure proof                     | Agree.                                                                   | Named the isolated test mechanisms for check/install failure, route unavailability, supervised worker restart, real cancellation, browser disconnection, and separate authenticated actors. Test injection stays outside production. |
| 8. Session-sized tasks               | Agree.                                                                   | Reclassified five slices as workstreams and added bounded ownership/exit tasks, with prerequisite ordering and a split-before-execution rule. No child issues or estimates are claimed.                                              |
| Permission copy                      | Agree.                                                                   | Record required owner-scoped `workshop.view`/app-map correction in the product change.                                                                                                                                               |
| Release notes                        | Agree.                                                                   | Added the repository’s required product PR Release note section.                                                                                                                                                                     |
| Evidence revision                    | Agree, minor.                                                            | Recorded follow-up baseline `cd0468307`; retained the historical assessment baseline rather than rewriting its evidence.                                                                                                             |

## Storage: the rejection comment is stale, but the draft bridge is broken

`packages/module-sdk/src/external-module.ts:318` still describes Slice 1. The current
`packages/module-registry/src/external/validate.ts:533` positively validates namespaces/scopes,
and Finance’s manifest declares multiple user-scoped namespaces. A standalone assertion against
the actual validator accepted this declaration for `word-of-the-day`:

```json
{ "storage": [{ "namespace": "word-of-the-day.saved", "scopes": ["user"] }] }
```

The page does not need a direct `kv` browser API. Finance’s `src/web/api.ts` already sends writes
through `POST /api/modules/:moduleId/queues/:queueName/run`; read tools use the assistant-tool
invoke endpoint. `apps/api/src/external-module-jobs.ts` validates the declared manual queue;
the worker invokes the declared handler; `worker-rpc-host.ts:443` checks storage declaration,
actor scope, and mutation risk before calling settings-owned KV operations. The sample needs
only a bundled word ID in queue metadata, not a private text payload.

However, `apps/worker/src/external-module-invoke.ts:175` rejects every status other than `enabled`.
Settings SQL `0188_list_active_external_module_users_draft.sql` includes a draft’s owner, but the
shared invoker subsequently denies that draft. This is the concrete missing integration, not a
need to invent storage. The spec now requires owner-authorized, hash-verified draft invocation and
an installed read/write proof before the generated refinement milestone.

The existing queue endpoint also deduplicates for five seconds per module/queue/actor and rate
limits manual runs. Those constraints must be reflected in pending/error behavior; HTTP 202 is
not proof of persistence. Do not copy the prototype’s immediate in-memory Save behavior into
production and pretend the asynchronous path is synchronous.

## Public APIs and ownership

`packages/settings/src/index.ts:29` already exports `module-builds-repository.ts`, and current
chat/worker composition consumes settings through package exports. The initial spec should have
said explicitly that lease/revision changes remain settings-owned and go through its public API.
It did not require direct Workshop SQL against `app.module_builds`; calling this an unavoidable
isolation violation overstates the evidence.

I choose the smaller of Fable’s alternatives: retain the table and formalize/extend the existing
public API. Moving the table and its legacy jobs would add migration risk without helping the
first working journey. Workshop owns only its own project/revision/feed tables.

## Model recovery is not currently available as described

The existing route is `/settings?section=aiproviders`, **Administration → AI providers**.
`settings-ai-admin-pane.tsx:78` defines only Chat & briefing and Email extraction in `SERVICE_ROWS`.
The API supports dynamic installed-module services, but the UI does not automatically list them.

The planner’s current `module.moss.workshop-build-plan` also does not identify the installed
`workshop` module. `packages/ai/src/capability-route-routes.ts` checks the namespace against
installed IDs before accepting a binding. The revised spec uses `module.workshop.plan`, adds a
Workshop planning row using the existing control, and migrates a legacy binding without clobbering
an explicit new one. This is an extension of the existing settings screen, not a new settings app.
It also names the account pin control and a real configuration-save → project-retry acceptance test.

## What remains unresolved

The confinement design needs deployment evidence; it cannot be selected honestly from the fact
that the development machine supports a particular tool. The production Compose service bundles
API, worker, and CLI runner. Its actual mounts, process privileges, auth conduit, and network
requirements decide what confinement is feasible. The revised spec makes this a prerequisite,
not a discretionary implementation detail buried inside a large worker task.

The approved prototype already includes empty, failed, waiting, stopped, model-unavailable, and
finish/share states. It does not include all list/detail fetch failures, pending writes, stale
approval, reconnect, preview, and persistence errors. Those additions need a concrete state sheet.
The local class count is not the right test: there are no `ws-*` classes in this prototype, and
prototype layout hooks are not forbidden invented `jds-*` primitives. Production must nonetheless
use the authored controls and layout-only module CSS; the revised spec names them.

No production code, infrastructure configuration, database, or GitHub status changed during this
response. The only executable code check was the standalone manifest-validator assertion. Links,
formatting, and whitespace were checked for the documentation changes. This review did not run a
live draft, prove confinement, or approve the missing screen states.
