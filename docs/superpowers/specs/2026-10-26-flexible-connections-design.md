# Flexible connections: sign-in flows and Moss-led setup

Status: draft for Ben's approval. Date: 2026-10-26.

## Intent

Connecting an outside service (an MCP server or an API described by an OpenAPI spec) is too
basic today. The user pastes a URL and optionally one secret. A service that needs a sign-in
through its own login page, such as the Circleback MCP server, cannot be connected, and the app
reports "Could not reach an MCP server at that URL" because every connect failure is swallowed
into that one message.

Moss must also be able to set a connection up when the user passes it a link. Ben ruled this
vitally important on 2026-10-26.

## Goals

- Connect any remote MCP server that supports the standard MCP authorization flow (OAuth 2.1
  with metadata discovery and dynamic client registration), with no per-service code.
- Keep the three existing secret placements (bearer, custom header, query parameter) working.
- Report specific connect failures: needs sign-in, wrong address, service down, secret rejected.
- Moss can add a connection from a link in chat: probe the URL, pick the auth method, and walk
  the user through the one step that needs them (approving sign-in).
- Moss asks the user before adding a connection (Ben, 2026-10-26).
- Stored access is refreshed automatically and survives restarts.
- The same flexibility applies to OpenAPI connections where the service offers OAuth.

## Non-goals

- A marketplace or catalog of services.
- Running our own OAuth provider.
- Per-service integrations written for Circleback or anyone else.
- Changing the existing Google connectors' OAuth.
- Local (stdio) MCP servers.

## Anti-goals

- Any secret, token or refresh token appearing in chat, logs, job payloads, exports or prompts.
- A hardcoded list of services that decides how sign-in works.
- A connection that looks healthy while its access has expired.

## Today (verified 2026-10-26)

- `packages/integrations/src/mcp-client.ts` connects with `StreamableHTTPClientTransport`, falls
  back to SSE, and maps every failure to "Could not reach an MCP server at that URL." There is
  no handling of 401 or `WWW-Authenticate`.
- `packages/integrations/src/credentials.ts` `applyCredential` supports bearer, header and query
  placement of one static secret.
- Credentials are one AES-256-GCM envelope per connection holding `{ secret }`.
- The add-connection route (`routes.ts`) calls discovery with the pasted credential.
- Moss has no tool for adding a connection; connections are added in Settings only. This is the
  result of a single search and the builder must confirm it.

## Behavior

### Specific failures

Connect and call failures are classified, not collapsed. At minimum: needs sign-in, secret
rejected, address not an MCP server or API, service unreachable, timeout. Each has a plain
message and, where it applies, a next step. Raw server text never reaches the user unfiltered.

### Sign-in through the service's login page

1. The user adds a connection by URL. Discovery gets a 401 with a resource-metadata challenge.
2. Moss reads the server's authorization metadata, registers itself as a client if the server
   allows dynamic registration, and sends the user to the service's login page.
3. The service returns the user to Moss at a fixed callback address. Moss exchanges the code,
   stores the tokens as an encrypted secret on the connection, and discovers tools.
4. Moss refreshes the access token before it expires and on a 401. If refresh fails, the
   connection shows "Sign in again" and Moss tells the user in chat when it next needs it.

The callback needs a secure address the service accepts. The builder decides the exact redirect
handling; the app must show a clear error when the deployment has no usable address.

### Moss sets up a connection from a link

- The user gives Moss a URL in chat. Moss probes it, decides MCP or API, and picks the auth
  method from what the service says.
- Moss asks the user before creating the connection, naming the service and what access it gives.
- When sign-in is needed, Moss hands the user a link to approve it and continues once approved.
- When a pasted key is needed, Moss points the user to the secure field in Settings. The key
  never passes through chat.
- Moss can report why a connection is failing using the specific failure classes above.

### Screens

Settings gains: auth method choice on the add form (detected automatically, overridable), a
"Sign in" step and state, and a "Sign in again" state. Per Ben's rules, mockups of each screen
are agreed before the build.

## Constraints

- Secrets obey the repo invariants: encrypted at rest, never in logs, job payloads, exports,
  frontend responses or prompts. Token and refresh-token values count as secrets.
- Provider-agnostic and module-isolated: other modules reach this through its declared API.
- The change must not break prod. Anything newly required (a public callback address, a key) is
  added to every deployment config in the same PR, and has an in-app way to be set.
- App map entries for every new screen, setting and error are updated in the same PR.
- Release-note section filled in. Live end-to-end proof on a secure test copy is required before
  merge, with a real service, not an intercepted one.

## Decisions by Ben

- Scope covers MCP and API connections together.
- Moss must be able to set up a connection from a link.
- Moss asks before adding a connection.
- Prod has a secure (https) address, so sign-in is expected to work there. The callback address
  is derived from the deployment's public address.
- Testing does not need to work on the dev copy. A secure test copy is needed for the live proof.

## Calls made while drafting (Claude, not yet confirmed by Ben)

- Services that do not allow dynamic registration get an optional client ID field on the add
  form. Dynamic registration is tried first.
- Moss gives the user a sign-in link, the callback page returns them to the chat, and Moss checks
  the connection state on its next turn. There is no live resumption of a paused tool call.
- "Ask before adding" uses the existing approval system, so it behaves like every other action
  under YOLO mode (adding a connection is not destructive, so YOLO skips the ask).
- New connections store tokens in a new envelope shape. Existing key-only connections stay as
  they are. Refresh is single-flight per connection, and a 401 mid-call refreshes once and
  retries once.
- OpenAPI sign-in is limited to the OAuth schemes the spec itself declares.
- Moss's probe of a user-given URL goes through the same address guard as the add route. If none
  exists, the build adds one that refuses private and internal targets, with an owner-controlled
  allowance for local servers.

## Left to the builder

- The OAuth library or hand-rolled client, and token storage layout.
- How the callback address is configured and shown.
- Failure class names and exact copy.
- Whether the add-connection route becomes a multi-step flow or a short-lived pending record.
- Which test copy provides the secure address (the existing proof copy on port 5181 is a
  candidate and is unverified for this).

## Open items

- A GitHub task issue for the build.
- Mockups for the add form, sign-in step, sign-in-again state and Moss's ask-before-adding prompt.
- A real account on a sign-in-protected MCP server for the live proof (Circleback is the case
  that prompted this).
