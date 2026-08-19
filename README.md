# Moss

A self-hosted AI home base. Chat with an assistant that actually knows your notes, calendar, email, tasks and goals — because all of it lives on your own machine, in your own database.

Moss is in active alpha. Expect rough edges.

## What it does

Moss is a chat interface with a set of modules behind it. The assistant can read from and write to any module you have enabled, so "what's on for tomorrow, and did I ever reply to Sarah?" is one question, not four apps.

**Your stuff**

- **Notes** — point Moss at a Markdown or Obsidian folder and it indexes and searches it
- **Tasks**, **Lists**, **Goals**, **Commitments** — things to do and things you said you'd do
- **People** — who you know and what you last talked about
- **Calendar** and **Email** — read-only context from connected accounts

**The day**

- **Briefings** — a morning summary built from everything above
- **Weather**, **News**, **Sports** — the ambient stuff, filtered to what you follow
- **Notifications** and **Proactive monitoring** — Moss tells you when something changed instead of waiting to be asked
- **Wellness** — check-ins and trends

**Under the hood**

- **Memory** — the assistant remembers across conversations
- **Web** — fetch and read pages during a conversation
- **Connectors** — link external accounts
- **Settings** — configure all of it from the UI

## Bring your own AI

Moss has no built-in model and no bundled API key. You configure a provider in Settings and every feature routes to it. Nothing in the codebase hardcodes a provider or a model name, so switching is a settings change, not a migration.

## Modules

Every feature above is a module with a manifest — its own database tables, background jobs, permissions, UI, and tools the assistant can call. Modules talk to each other only through declared APIs, so you can enable the ones you want and ignore the rest. The same interface is how you'd add your own.

## Install

Moss is deployed using Docker Compose. The setup process generates your unique encryption keys and database passwords automatically.

```sh
mkdir moss && cd moss

# Download the production Compose file
curl -O https://raw.githubusercontent.com/motioneso/Jarv1s/main/infra/docker-compose.prod.yml

# 1. Generate your boot secrets (creates env.production.local)
JARVIS_IMAGE_TAG=stable docker compose -f docker-compose.prod.yml --profile setup run --rm setup

# 2. Start the stack
docker compose -f docker-compose.prod.yml --env-file env.production.local up -d
```

Open `http://localhost:1533`. To upgrade later, run `docker compose pull` then the `up -d` command again.

For detailed configuration (including mounting a notes folder), see the [Deploy Guide](docs/operations/deploy.md).

## Notes

Mounting a notes folder is optional. If you mount one at `/data/external-notes`, Moss indexes the Markdown in it and the assistant can search it. Mount it read-only unless you want Moss writing back.

## Backups

Two volumes hold everything: `moss-postgres` (the database) and `moss-data` (app state, provider CLI auth, caches, local files).

```sh
docker compose down
docker run --rm -v moss-postgres:/data -v "$PWD":/backup alpine \
  tar czf /backup/moss-postgres.tar.gz -C /data .
docker run --rm -v moss-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/moss-data.tar.gz -C /data .
docker compose up -d
```

## Your data stays yours

Everything runs on your hardware. Data is private by default and owner-only unless you explicitly share it. Credentials are encrypted at rest and never reach the frontend, the logs, or an AI prompt.

## Development

Setup lives in [CLAUDE.md](CLAUDE.md) and [docs/operations/dev-environment.md](docs/operations/dev-environment.md).

```sh
pnpm install
pnpm db:up
pnpm verify:foundation
```
