# Workshop D5a/U1 — real project entry

Task #2306, part of #2023. The parent spec/prototype and A1 supplementary states are approved;
Ben's subsequent blanket authorization covers implementation. Keep the existing worktree.

## Verified seams

- D1/D2 repositories own projects/feed and enforce actor RLS; 11 integration assertions pass.
- `packages/db/src/data-context.ts:63` provides a transaction whose principal is host-resolved.
- `packages/module-registry/src/index.ts:2353` registers Workshop migrations but has no routes yet.
  Add routes through this existing built-in composition, matching the adjacent workflow registration.
- `packages/workshop/src/web/index.tsx` registers `/workshop`; add detail/new routes there.
- `packages/chat/src/module-build-start-impl.ts:49` owns the current tool's create/plan/queue flow;
  `gateway-services.ts:176` injects it. Replace the flow, not a second automatic-build branch.
- `apps/web/src/chat/message-row.tsx:244` parses the old plan result/card. Update this real caller
  and its response schema with the saved-project handoff.
- `packages/chat/src/live/notes-tool-trust.ts:16` shows how to resolve an owned surface's current
  thread and incognito state. Private/unknown sources must not persist implicitly.

## API and service

Export one create-only operation returning `{project,created,destination}` from Workshop.
Destination is `/workshop/` plus the database UUID, never model-authored. UI and Moss call this
operation. It only persists D1 input; no model, job, approval, source execution or installation.
Admin status is checked in code against the resolved actor before every project/feed operation.
All repository work remains inside the same actor transaction; missing and foreign return 404.

Shared schemas cover POST/GET `/api/workshop/projects`, GET `/api/workshop/projects/:projectId`,
and GET/POST `/api/workshop/projects/:projectId/messages`. Lists return `{projects,nextCursor}`;
detail `{project}`; messages `{entries,nextCursor}` / `{entry,created}`. Creation returns 201 or
200 for replay, changed-key payload 409, invalid UUID/bytes/cursors 400. Error responses expose
only curated recovery text. Cursor pairs preserve the D1 time/id contract; feed uses decimal
sequence strings. Response schemas omit owner/request-key internals.

## Screens and handoff

Use the approved list, native labeled create form, and conversation/detail layout. Button,
ButtonLink, Card and EmptyState plus existing jds form primitives; layout-only module CSS.
Retain the same request key on a retry and retain text on failure; after a failed submission,
editing its payload generates a new key. Do not show failed fetch as empty. Reconnect invalidates
and reloads server state before state-changing controls re-enable. Keep unsent text on mobile
pane changes. Report saved/pending from real rows; no fake assistant/planning/build completion.

Preserve an explicit link to legacy installed/build records while projects become the entry
surface, until their lifecycle consumers are migrated. Old tool name may remain for compatibility,
but its successful response uses the same create-only service and real destination. Verify the
host request identifier's retry semantics before choosing the tool idempotency key. Incognito
handoff requires explicit persistence authority; if the current host cannot attest that, direct
users to the create form to choose what to save, without silently copying private chat.

## Verification and release

HTTP integration tests use real app roles: create/replay/conflict, no build creation, admin denial,
foreign 404 for all five operations, byte limits and serializer fields. UI checks exercise actual
create → detail → save message → reload plus failed create/send text retention, retry, owner denial,
keyboard and 320/375/414/768 widths. Verify tool and direct entry use the same operation and that
YOLO cannot start a build. Update app-map routes/features/errors in the same slice. Run scoped
lint/format/types and isolated integration, then full foundation plus actual assembled browser
proof. Keep the issue open until the real UI proof exists. No provider/runtime acceptance gate is
weakened to make the shell look complete.

Kill gate: if project entry cannot attest the source actor/privacy state, reject that handoff;
do not infer consent from model text. D3/D4/M3 and execution lifecycle remain the later owners of
planning, approval and builder messages; this slice must expose unavailable operations honestly.
