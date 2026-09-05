# Workshop create-only handoff seams — September 5

Discovery only; implementation remains D5a/U1 under the approved parent spec. D1 projects and
D2 user messages now have real role-based integration proof. Preserve the same worktree.

- `packages/chat/src/module-build-start-impl.ts:49`: current factory assembles model planning,
  settings build persistence, YOLO approval and queue dispatch. Replace this flow at the shared
  service boundary; a second project-creation path would leave the old automatic-build path alive.
- `packages/chat/src/gateway-services.ts:176`: service injection depends on `boss` and uses AI
  repository plus YOLO settings. A create-only handoff should not require queue/model availability.
- `packages/workshop/src/assistant-tools.ts`: tool calls host service with actor, surface ID,
  description and excerpt. Current result is build ID, plan and awaitingApproval. Replace its
  schema and manifest semantics together with the caller. Never trust model-generated destinations.
- `apps/web/src/chat/message-row.tsx:244` and `module-build-plan-record.tsx:14`: current structured
  result parser/card expects an actual plan and offers Build it. A new project result needs the
  actual project detail consumer before emitting `/workshop/:id` as a working destination.
- `packages/module-sdk/src/index.ts:95`: ToolContext supplies requestId and chatSessionId, but
  no explicit privacy mode or tool invocation ID. Verify request ID replay stability and the
  host privacy/confirmation path before deciding how to bind the project idempotency key or
  persist conversation excerpts. A drawer surface ID is not a database thread UUID.

The parent spec explicitly forbids silently persisting incognito content. Trace the existing
persistence authorization seam before changing the tool. No need to ask Ben to repeat the approved
product design; preserve his blanket authorization while enforcing end-user privacy at runtime.
