# Deploy Guide

Moss should deploy like a small self-hosted appliance: one Postgres container for durable data, and one Moss container for everything Moss owns.

The operator-facing path is a commented Docker Compose file. No installer script, host CLI preflight, or UID/GID prompt should be required.

## Installation

Download the production Compose file, generate your unique encryption keys, and start the stack. No installer script or host CLI preflight is required.

```sh
mkdir moss && cd moss

# Download the production Compose file
curl -O https://raw.githubusercontent.com/motioneso/Jarv1s/main/infra/docker-compose.prod.yml

# 1. Generate your boot secrets (creates env.production.local)
JARVIS_IMAGE_TAG=stable docker compose -f docker-compose.prod.yml --profile setup run --rm setup

# 2. Start the stack
docker compose -f docker-compose.prod.yml --env-file env.production.local up -d
```

Open `http://localhost:1533`.

For an optional HTTPS front end (internal-CA or public ACME certificates), see
[self-hosted-tls.md](./self-hosted-tls.md).

## Upgrade

```sh
docker compose pull
docker compose up -d
```

The default image channel should be `ghcr.io/motioneso/moss:stable`. Version tags remain useful for rollback and debugging, but users should not have to edit a tag for routine upgrades.

### CLI tool version drift (#1081)

Bumping a bundled CLI provider's version (claude/codex) only rebakes the recipe **catalog**
into the image — the installed binary itself lives in the persistent `jarv1s-cli-tools`
named volume, which survives `docker compose pull && up -d` untouched. As of #1081, the
cli-runner sidecar reconciles every already-installed provider against the fresh catalog
during its own boot sequence (before it accepts a request), so a routine upgrade now
self-heals: a version-matched provider is a cheap no-op, a drifted one is reinstalled
automatically, and any live chat session on that provider is dropped and relaunched (against
the fresh binary) the next time it's used.

If a session ever behaves as if it's still on the old provider version after an upgrade
(the historical #1079 symptom), the manual fallback is still available — POST
`/api/onboarding/provider-install` for the affected provider, then `POST /api/chat/clear` to
drop any session that predates the reinstall.

## Downloaded Modules

Moss has one module model with two delivery paths: **bundled modules** ship in the app image,
while **downloaded modules** are installed separately from Settings → Instance modules. The
runtime may call the latter `external` internally because they cross a package-loading and trust
boundary; that is an implementation detail, not a second product concept.

Downloading or updating a module stages its validated package on the persistent modules volume.
Restart the Moss container to run module reconciliation and activate the staged version:

```sh
docker compose -p jarv1s-prod \
  --env-file env.production.local \
  -f docker-compose.prod.yml \
  restart jarv1s
```

Include `-f docker-compose.notes.yml` when the deployment enables the notes mount.

After readiness returns, confirm the module says **Installed** in Settings and that its declared
navigation entry is visible. A downloaded module intentionally remains inactive when validation
fails, its package hash changes outside the installer, an administrator disables it, or the user
turns it off.

Downloaded-module discovery is always available; there is no
`JARVIS_ENABLE_EXTERNAL_MODULES` feature flag. `JARVIS_MODULES_DIR` is an advanced path override,
not an enable switch.

## Production Compose

The committed production artifact is `infra/docker-compose.prod.yml`. It keeps Postgres separate and runs API, web serving, worker, migrations, and provider CLIs inside the `jarv1s` container.

## Secrets

Moss does not require you to manually generate secrets. The `setup` service automatically generates `env.production.local` with all the cryptographically secure passwords and keys needed for the stack.

If you are generating secrets manually or running `setup` via a script, the following environment variables are typically customized:

- `POSTGRES_PASSWORD` (used by setup to populate the database URLs)
- `JARVIS_IMAGE_TAG`
- optional notes bind mount (`JARVIS_NOTES_VAULT_HOST_PATH`)

UID/GID should not be part of the happy path. The Moss image should handle ownership of its managed `/data` volume internally. If writable host bind mounts later need custom ownership, document that under advanced permissions.

## Notes Mount

Notes are optional. If a Markdown or Obsidian folder is mounted at `/data/external-notes`, Moss can index it and expose note excerpts to chat through the notes search tool.

Use a read-only mount by default:

```yaml
- /Users/you/Obsidian:/data/external-notes:ro
```

Only use `:rw` if a future write-back feature explicitly requires it.

## Backups

Back up both volumes:

- `jarv1s-postgres-data`: database
- `jarv1s-cli-auth`, `jarv1s-vault-data`, `jarv1s-modules`: app state, provider CLI auth, caches, and local files

Stop the stack before raw volume snapshots:

```sh
docker compose down
docker run --rm -v jarv1s-postgres-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/jarv1s-postgres-data.tar.gz -C /data .
docker run --rm -v jarv1s-cli-auth:/data -v "$PWD":/backup alpine \
  tar czf /backup/jarv1s-cli-auth.tar.gz -C /data .
docker run --rm -v jarv1s-vault-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/jarv1s-vault-data.tar.gz -C /data .
docker compose up -d
```

For logical database dump/restore procedures, see [backup.md](./backup.md).

## Repository Compose

For a checkout-based deploy, generate `infra/env.production.local` with the setup service, then start the single-container production stack:

```sh
JARVIS_IMAGE_TAG=v0.1.0 POSTGRES_PASSWORD=setup JARVIS_CLI_RUNNER_RPC_SECRET=setup \
  docker compose -p jarv1s-prod -f infra/docker-compose.prod.yml --profile setup run --rm setup

docker compose -p jarv1s-prod \
  -f infra/docker-compose.prod.yml \
  --env-file infra/env.production.local \
  up -d
```

If notes are enabled, set `JARVIS_NOTES_VAULT_HOST_PATH` and include the notes override on both commands:

```sh
JARVIS_NOTES_VAULT_HOST_PATH=/Users/you/Obsidian \
JARVIS_IMAGE_TAG=v0.1.0 POSTGRES_PASSWORD=setup JARVIS_CLI_RUNNER_RPC_SECRET=setup \
  docker compose -p jarv1s-prod \
  -f infra/docker-compose.prod.yml \
  -f infra/docker-compose.notes.yml \
  --profile setup run --rm setup

docker compose -p jarv1s-prod \
  -f infra/docker-compose.prod.yml \
  -f infra/docker-compose.notes.yml \
  --env-file infra/env.production.local \
  up -d
```

## Restart And Cold Chat Check

For a checkout-style prod instance such as `~/JarvisProd`, restart the app container without touching
Postgres:

```sh
docker compose -p jarv1s-prod \
  --env-file env.production.local \
  -f docker-compose.prod.yml \
  -f docker-compose.notes.yml \
  restart jarv1s
```

Then wait for readiness:

```sh
curl -fsS http://127.0.0.1:1533/health/ready
```

Before testing a true cold chat turn, `tmux list-sessions` inside the app container should be empty:

```sh
docker exec -u 1000 jarv1s-prod-jarv1s-1 tmux list-sessions
```

Do not attach to tmux or send keys to make chat work. If the first chat turn after restart needs
manual tmux intervention, treat that as a product failure: fix code, restart Docker, and test again.

### Chat smoke check (run this after every deploy that touches chat)

A ready health check and a 200 from the chat endpoint prove almost nothing about chat. Both #1361
and #1363 shipped with green CI, a 200 from `/api/mcp`, a 200 from `/api/chat/turn`, and a fluent
reply the assistant had composed without reaching a single tool. Run the smoke check:

```sh
scripts/smoke-chat-prod.sh you@example.com
```

It posts one turn that can only be answered with a tool and asserts a real `mcp__jarvis__*` tool
call reaches the live transcript before the reply. Exit `0` pass · `1` chat is degraded · `2` the
check could not run at all (bad URL, no such user — not a chat verdict).

Run it after any deploy touching chat, the permission hook, the CLI runner, or a module's assistant
tools. It mints a ten-minute session for the account you name, talks to its own throwaway chat
surface rather than that user's real conversation, and revokes the session and deletes the surface
on exit — including on failure and on Ctrl-C. Mint it for an account you own: the session can read
that user's private data.

A failure names the tools it did and did not see. Check, in order: the permission hook (does it
still allow `ToolSearch`? #1361), the CLI's MCP client log for a tool the API rejected and the CLI
therefore dropped (#1363), then the gateway.
