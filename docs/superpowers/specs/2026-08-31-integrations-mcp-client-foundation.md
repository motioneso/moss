# Integrations — MCP + OpenAPI Connection Foundation

**Date:** 2026-08-31

**Status:** Draft — needs Ben's approval

**Issue:** _to be filed as a `task` issue after spec approval_

## Context

Moss can act as an MCP *server* for external assistants (`packages/chat/src/mcp-transport.ts`), but
has no way to consume tools or APIs from external services. The existing `packages/connectors`
(Google/IMAP email + calendar) is bespoke per-service code, not a reusable integration pattern.

This spec adds a generic foundation for connecting Moss to external tools and services, so that
adding integration #2, #3, #N is configuration, not code. Two connection kinds at launch:

- **MCP** — for services that ship an MCP server. Proof target: **Home Assistant** (official MCP
  server built in).
- **OpenAPI** — for services that publish an OpenAPI spec, which covers most of the self-hosted
  world (Radarr, Sonarr, Jellyfin, Proxmox, Pi-hole, ...) where API-key auth is the norm and
  native MCP servers are rare. Proof target: **Radarr or Sonarr**.

Brainstormed with Ben 2026-08-31. Direction rulings from that session:

- **Chat assistant first.** The primary consumer of an integration at launch is the chat assistant
  (tools). Module/briefing consumption of integration data is a stated future direction — Moss as
  the control center for all the user's services — but not this milestone.
- **Generic connection kinds, not per-service adapters.** MCP and OpenAPI are the two universal
  sockets. Purpose-built modules for specific services remain the escape hatch for anything deeper
  (event streams, dashboards, APIs with no machine-readable spec).
- **Usability over ceremony.** The connect flow must be light. This foundation deliberately does not
  repeat the security-heavy posture of the initial platform foundation, while still honoring the
  hard invariants (secrets encrypted at rest, never leaked; private by default).

## Goals

1. A user can connect Moss to any network-reachable MCP server **or** OpenAPI-specced service by
   entering a name, a URL, and a credential — no code, no restart.
2. On connect, Moss discovers the service's capabilities (MCP tools, or OpenAPI endpoints converted
   to tools) and the user can see the full discovered list — this is the verification surface for
   "Moss can see everything it needs to."
3. Discovered tools are usable by the chat assistant, namespaced by connection name. Small tool
   sets are live immediately; large OpenAPI surfaces get sensible group-level curation (see Tool
   volume).
4. Both proof paths work end to end on a live instance: Home Assistant over MCP, and Radarr or
   Sonarr over OpenAPI.
5. Adding a future integration that speaks MCP or publishes an OpenAPI spec requires zero Moss code
   changes.

## Non-Goals (this milestone)

- **Stdio (local child-process) MCP servers.** The connection schema carries a `transport` field
  from day one (`http` now, `stdio` reserved) so stdio slots in later without a migration, but only
  network transports are built.
- **OAuth flows.** Credential paste only (bearer token, API key, or basic auth values). Real OAuth
  callbacks remain their own future milestone per the existing scope guardrail.
- **APIs with no machine-readable spec.** "Moss reads the human docs and figures it out" is not
  reliable enough to build on; the escape hatch is a purpose-built module.
- **MCP resources and prompts.** Tools only. Resources/prompts layer on later.
- **Event subscriptions / server-push.** No subscribing to HA state changes yet.
- **Module and briefing consumption of integration data.** Future direction, separate spec.
- **Any catalog/marketplace of integrations.** A connection is a URL the user brings.

## Design Rulings (from brainstorm)

| Question | Ruling |
|---|---|
| Primary consumer | Chat assistant (tools) first; modules/briefings later |
| Plug-in mechanism | Generic connection kinds (`mcp`, `openapi`); modules remain the escape hatch for deeper per-service features |
| Transports | Streamable HTTP + SSE for MCP, plain HTTPS for OpenAPI; `transport` field reserved for stdio |
| Tool surfacing | Connect = live for small tool sets; per-tool mute list, no mandatory review step (consistent with the "installing grants normal use" ruling). Large OpenAPI surfaces default to group-level opt-in — see Tool volume |
| UI location | A section **inside the existing Settings area**, not a standalone page |

## Architecture

New `packages/integrations` package with four parts:

### 1. Connection registry

A DB table (module-owned SQL, per migration rules) holding per-user connection records:

- `id`, `owner_user_id`, `name` (user-chosen, unique per owner), `kind` (`mcp` | `openapi`),
  `transport` (`http` | reserved `stdio`), `url`, `enabled`, timestamps
- `credential` — AES-256-GCM encrypted at rest exactly like connector/AI secrets. Stored with a
  placement descriptor so it can be sent the way the service expects: `Authorization: Bearer`
  (HA), a named header like `X-Api-Key` (Radarr/Sonarr), or a query parameter. The add form offers
  these as simple choices with per-kind defaults.
- `enabled_tools` / `muted_tools` — the user's curation state (see Tool volume)
- Cached discovery state: last discovered tool list (names, descriptions, input schemas, group),
  last successful handshake/fetch time, last error summary (sanitized, human-readable — never a raw
  transport dump)

RLS: owner-only. Connections are private by default; no sharing in this milestone. The credential
never reaches frontend responses, logs, job payloads, exports, or AI prompts (hard invariant). The
frontend sees only "a credential is set."

### 2. MCP client (kind: `mcp`)

Built on the official MCP TypeScript SDK. Speaks streamable HTTP with SSE fallback.
Responsibilities:

- Handshake + capability negotiation on connect and on demand
- Tool discovery (`tools/list`), cached in the registry; a manual "refresh" action re-runs it
- Tool invocation (`tools/call`) with a bounded timeout

### 3. OpenAPI adapter (kind: `openapi`)

- On connect, fetches the service's OpenAPI document (the add form takes the spec URL, with
  per-service conventions like Radarr/Sonarr's self-served spec called out in help text; a spec
  file paste/upload also works for services that serve the spec awkwardly).
- Converts each operation into a tool: operation summary/description becomes the tool description,
  parameters + request body become the input schema, the OpenAPI **tag** becomes the tool's group.
- Invocation renders the tool call back into an HTTP request (path/query/header/body), attaches the
  credential per its placement descriptor, and returns the response body as the tool result
  (truncated at a sane byte cap so a huge JSON payload cannot flood the model).
- The parsed spec is cached; "refresh" re-fetches and re-converts, preserving curation state by
  operation id.

### 4. Chat tool proxy (shared by both kinds)

Discovered, enabled, un-muted tools from enabled connections register into the chat tool registry
at conversation start, namespaced by connection name (e.g. `home-assistant: turn_on`,
`sonarr: get_queue`). A tool call from the model routes through the proxy → the kind's client →
the remote service, and the result returns to the model as a normal tool result.

Notes:

- Tool schemas are the model's only view of the tool (known trap: top-level `anyOf` silently drops
  a tool — the proxy should log-and-skip malformed schemas rather than silently losing the whole
  connection). OpenAPI conversion must produce schemas that survive this constraint.
- Namespacing prevents collisions between connections and with native module tools.
- Only the connection owner's conversations see that connection's tools.

## Tool volume

MCP servers curate their own tool sets (HA exposes a handful). OpenAPI specs do not — Sonarr's has
100+ operations, far too many to hand a model or a settings page as a flat live list. Ruling:

- **At or under a threshold (~30 tools): connect = live**, everything enabled, per-tool mute
  available. This keeps the MCP happy path and small APIs friction-free.
- **Over the threshold: group-level opt-in.** The detail page shows the spec's tag groups
  (Sonarr: Series, Episode, Queue, Calendar, ...) with a toggle per group and per-tool overrides
  inside each group. Nothing is enabled until the user flips groups on — one or two taps, not a
  100-row review.
- The enabled set, not the discovered set, is what registers into chat. Discovery always shows
  everything, so the verification value ("Moss can see it all") is preserved regardless of what's
  enabled.

## UI

A new **Integrations** section inside the existing Settings area (same pattern as other settings
panes — not a standalone page). Three surfaces:

1. **Connection list** — one card per connection: name, kind badge (MCP / API), URL host, status
   (connected / error / disabled), enabled-tool count, last-seen time. An enable/disable toggle per
   connection.
2. **Add connection** — kind choice (MCP server / API with OpenAPI spec), then name, URL, and
   credential (with placement choice for API kind, sensible defaults). On save, Moss immediately
   attempts handshake/spec-fetch + discovery and lands the user on the detail view showing what it
   found. A failed first attempt shows a plain-English error on the form, not a saved-but-broken
   card.
3. **Connection detail** — the discovered tool list (grouped, with descriptions), group and
   per-tool toggles per the Tool volume rules, a "refresh" action, and a "remove connection"
   action. This page doubles as the verification screen: it is how the user confirms Moss sees
   everything the service exposes.

Process gate: front-end mockups of these three surfaces must be agreed with Ben before
implementation (Design System Guardrails). All UI through `jds-*` primitives via the design-system
skill.

## Proof paths

**Home Assistant (MCP):**

1. User enables HA's built-in MCP server integration and creates a long-lived access token in HA.
2. In Moss Settings → Integrations, user adds an MCP connection: name, HA's MCP URL, the token.
3. The detail view lists HA's discovered tools; chat can control and query the house.

Known caveat, stated honestly in docs/UI: HA's MCP server only exposes entities the user has marked
as exposed to Assist, and its tool surface is thinner than HA's full API. If that proves too
shallow, the agreed escape hatch is a purpose-built HA module later.

**Radarr or Sonarr (OpenAPI):**

1. User adds an API connection: name, service URL + spec location, API key (X-Api-Key placement
   default).
2. The detail view shows the operation groups; user enables the groups they care about (e.g. Queue,
   Calendar, Series).
3. Chat can search, add, and check status through those tools.

## Error handling

- Connect-time failures (bad URL, bad credential, non-MCP endpoint, unparseable spec) → immediate
  plain-English message on the add form.
- Runtime tool-call failures → transient drops retried quietly within bounds (matching the #1709
  resilience philosophy); real failures return an honest tool error to the model without transport
  internals.
- A connection that repeatedly fails shows an error status on its card with a sanitized summary and
  a "test connection" retry; it never spams chat.

## Testing

- Unit: registry CRUD + RLS (owner-only), credential encryption round-trip + placement rendering,
  MCP schema pass-through including the malformed-schema skip path, OpenAPI→tool conversion
  (params, body, tags→groups, response truncation), namespacing and curation filtering, threshold
  behavior.
- Integration: an in-repo fixture MCP server and a fixture OpenAPI service exercised over HTTP —
  connect, discover, call, retry-on-drop, honest-failure-on-exhaustion, large-spec group opt-in.
- Live-path gate: real proof on the live dev instance for **both kinds** — HA connected and a real
  entity driven from chat; Radarr/Sonarr connected and a real query answered from chat — recorded
  on the PR per the Live-Path Gate rule.

## Future direction (recorded, not built)

- Stdio transport for local MCP servers.
- OAuth-based connections.
- MCP resources/prompts; event subscriptions.
- Integration data in briefings and available to modules — Moss as the control center for all the
  user's services.
- Purpose-built modules layered on top of connections (e.g. a real HA module with event
  subscriptions and dashboards).
