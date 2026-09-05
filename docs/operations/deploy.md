# Deploy Moss

Moss runs with Docker Compose: PostgreSQL with pgvector stores the database, the Moss container runs the API, web app, worker, migrations, and provider CLIs, and a supporting container renders sports sources. HTTPS is optional.

## Installation

Follow the [README installation steps](../../README.md#install-with-docker-compose) to download the production Compose file, generate secrets, set your first account's email, and start Moss.

All commands below run from **your installation directory**, containing `docker-compose.prod.yml` and `env.production.local`. They use `moss` as the Compose project name for a new installation. **If you already run Moss, retain your existing project name in every command.** Changing it selects a different set of volumes.

The published image is `ghcr.io/motioneso/moss`. The app container is named `moss`; its Compose service is still `jarv1s`. Existing service names, database names, volume keys, and `JARVIS_*` settings remain valid for compatibility.

## Configuration and secrets

The setup service generates `env.production.local` with unique database passwords, authentication and encryption keys, and the selected image tag. Keep this file private and include it in encrypted backups. Setup refuses to overwrite an existing file: replacing its keys can make stored credentials unreadable.

Use `--env-file env.production.local` on every subsequent Compose command. The service's `env_file` entry supplies the container environment, but does not supply Compose's own `${...}` interpolation.

Useful settings in `env.production.local`:

| Setting                              | Purpose                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `JARVIS_IMAGE_TAG`                   | `stable` for promoted releases, or a published version tag to pin a release.                                                  |
| `JARVIS_WEB_PORT`                    | Host HTTP port; defaults to `1533`.                                                                                           |
| `MOSS_AUTH_TRUSTED_ORIGINS`          | Comma-separated browser origins permitted to sign in.                                                                         |
| `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL` | Exact email of the first account; required for module reconciliation once an owner exists.                                    |
| `JARVIS_DOCKER_SUBNET`               | Docker network subnet; change it if it overlaps another network. Consult the HTTPS guide before changing it with TLS enabled. |

After editing configuration, recreate the services:

```sh
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local \
  up -d --no-build
```

A plain `restart` does not load changed environment variables.

To run another instance on the same host, also set a unique `MOSS_CONTAINER_NAME`, web port, and Docker subnet, and use a different Compose project name. The default app container name is `moss`.

## Access from another device

The default URL is `http://localhost:1533`. To access Moss through another hostname or address, add that exact origin to `MOSS_AUTH_TRUSTED_ORIGINS` in `env.production.local`. For example:

```dotenv
MOSS_AUTH_TRUSTED_ORIGINS=http://localhost:1533,http://moss.lan:1533
```

Replace `moss.lan` with a hostname or address reachable from your device. Origins contain the scheme, hostname, and port, with no path or wildcard. If you change `JARVIS_WEB_PORT`, update the origins to match.

For HTTPS, follow [Self-hosted TLS](./self-hosted-tls.md). That optional setup also needs the repository's `infra/caddy/Caddyfile`, placed at `caddy/Caddyfile` beside your downloaded Compose file. HTTPS enables browser features that require a secure context, such as microphone access from another device.

## Mount a Markdown or Obsidian folder

Moss can use an existing notes folder mounted at `/data/external-notes` inside the container. This is a container path, independent of where you store your notes on the host.

Download the optional override beside your Compose file:

```sh
curl -fL https://raw.githubusercontent.com/motioneso/moss/main/infra/docker-compose.notes.yml \
  -o docker-compose.notes.yml
```

Add these settings to `env.production.local`, replacing the example host path with your notes folder's absolute path:

```dotenv
JARVIS_NOTES_VAULT_HOST_PATH=/path/to/your/notes
JARVIS_NOTES_ROOTS=/data/external-notes
```

The supplied override mounts the folder **read-write**, allowing note edits and chat archiving. For search-only use, change its mount suffix from `:rw` to `:ro`. Writable mounts also need host filesystem permissions that allow the container user to write; advanced installations can set `JARVIS_HOST_UID` and `JARVIS_HOST_GID` to match the folder's owner.

Include both files whenever managing this deployment:

```sh
docker compose -p moss -f docker-compose.prod.yml -f docker-compose.notes.yml \
  --env-file env.production.local up -d --no-build
```

Use the same two `-f` flags for updates and maintenance. Back up the host notes folder separately from Docker volumes.

## Updates and module changes

Back up before updating, then pull and recreate:

```sh
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local pull
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local \
  up -d --no-build
```

Migrations and module reconciliation run during startup. Provider CLI installations are also reconciled against the image's bundled catalog, so persistent tools can update with the image. See [What's New](../WHATS_NEW.md) for release details.

Bundled modules ship in the image. Additional modules can be downloaded through **Settings → Instance modules**. Downloading or updating stages a package on the modules volume; restart the app to reconcile and activate it:

```sh
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local restart jarv1s
```

After readiness returns, confirm the module is installed and its navigation is visible. Invalid, disabled, or unapproved packages remain inactive.

## Backups

Back up these items together:

- `env.production.local`, your Compose files, and any proxy configuration.
- The database volume (`jarv1s-postgres-data`).
- App files (`jarv1s-vault-data`), provider authentication (`jarv1s-cli-auth`), and downloaded modules (`jarv1s-modules`).
- Any host-mounted notes folder.
- If using TLS, `caddy-data` and `caddy-config`, including the local certificate authority.

The `jarv1s-cli-tools` and `jarv1s-model-cache` volumes contain reinstallable tools and model downloads; include them if you want to avoid downloading them again. Socket volumes hold transient runtime files.

These are **Compose volume keys**, not necessarily their Docker names. With the README's `-p moss`, the database volume is normally `moss_jarv1s-postgres-data`. Inspect the mounted volumes before choosing backup targets:

```sh
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local config --volumes
docker volume ls --filter label=com.docker.compose.project=moss
```

For raw volume snapshots, stop services first to obtain a consistent database copy:

```sh
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local stop
# Snapshot the identified volumes and back up configuration and host-mounted files.
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local \
  up -d --no-build
```

Store backups securely off the Docker host and test restoring them into a separate installation. Docker Compose does not schedule backups automatically. **Do not use `down -v` to perform maintenance**: it deletes the stack's volumes.

## Troubleshooting

```sh
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local ps
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local \
  logs --tail=100 jarv1s postgres
curl -fsS http://localhost:1533/health/ready
```

If startup fails after creating your first account, check that `MOSS_RECONCILE_CONFIRM_OWNER_EMAIL` matches that account and recreate the app. If sign-in fails from another device, check the exact origin allowlist. Review logs locally before sharing them.

For manual migration recovery, after reviewing the failure and taking a backup:

```sh
docker compose -p moss -f docker-compose.prod.yml --env-file env.production.local \
  --profile ops run --rm --no-deps migrate
```

## Deploying from a source checkout

You can also use `infra/docker-compose.prod.yml` directly from a checkout. In the commands above, use `-f infra/docker-compose.prod.yml` and `--env-file infra/env.production.local`; setup writes its output beside that Compose file. If using notes, include `-f infra/docker-compose.notes.yml` too.

Use `up -d --build` when you intentionally want to build the image from that checkout. For development rather than deployment, see the [development environment guide](./dev-environment.md).
