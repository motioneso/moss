# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Moss image (ghcr.io/motioneso/moss).
# One multi-stage image runs the supervisor, which migrates then starts API,
# worker, and cli-runner; the API serves the built web assets.
# ---------------------------------------------------------------------------

# ---- deps: install the full workspace (incl. native binaries) -------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate
# Install from manifests before copying source so source-only edits reuse this layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY --parents apps/*/package.json packages/*/package.json ./
# onlyBuiltDependencies (onnxruntime-node, sharp, node-pty) in pnpm-workspace.yaml
# ensures the embedding native binaries are fetched (the worker needs them, §3) and
# node-pty is allowed to run its install script.
# node-pty (#1059, packages/cli-runner) has no linux prebuild → it compiles from source via
# node-gyp during `pnpm install`. bookworm-slim lacks the toolchain, so install python3/make/g++
# for the compile, then purge in the SAME layer so the runtime image (FROM build ← FROM deps)
# doesn't carry the ~200MB toolchain — the built pty.node is all runtime needs.
RUN --mount=type=cache,id=moss-pnpm,target=/pnpm/store \
  apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && pnpm install --frozen-lockfile \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY . .

# ---- build: compile resident entrypoints to dist/ -------------------------
FROM deps AS build
WORKDIR /app
RUN pnpm build:api && pnpm build:worker && pnpm build:web

# ---- runtime: FROM build (full, self-consistent deps incl. tsx + source) ---
# DECISION (Codex R2): we do NOT prune to prod-deps and we do NOT cherry-pick
# tsx/esbuild out of node_modules' .pnpm virtual store. pnpm lays node_modules out
# as symlinks into .pnpm with transitive deps; copying individual dirs (node_modules/tsx, etc.)
# produces a broken, non-self-consistent tree and `tsx scripts/migrate.ts` fails.
# Instead the runtime IS the build stage with: tmux client added, source pruned to
# what the three roles need, writable mount points, and a non-root user. This keeps
# ONE image for all three roles (api/worker bundled `node dist/...`; migrate
# `tsx scripts/migrate.ts`) with a fully consistent node_modules. The cost is a
# larger image (dev deps included) — an accepted tradeoff for correctness in a
# single-operator household deploy; the bundled dist/ still gives fast api/worker
# startup.
FROM build AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Default cache location for the embedding model weights (§3); the prod Compose
# mounts a named volume here so weights survive restarts.
ENV HF_HOME=/app/.cache/huggingface
ENV JARVIS_WEB_DIST_DIR=/app/apps/web/dist
# tmux + git (#342 in-container CLI chat): the cli-runner sidecar forks its OWN
# tmux SERVER inside the container and runs the provider CLIs (claude/codex/agy)
# there — no host tmux socket (ADR 0008 reversed by ADR 0010). The same image
# runs api/worker/migrate (which don't use tmux) AND the cli-runner; bundling the
# tmux server here keeps ONE image for every role. git is commonly required by the
# provider CLIs. ca-certificates is REQUIRED for codex auth/model HTTPS calls
# (without it codex login fails: `no native root CA certificates found`).
# bubblewrap lets codex use its native sandbox instead of falling back to the
# bundled helper. --no-install-recommends keeps the layer small.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux git ca-certificates bubblewrap \
  && rm -rf /var/lib/apt/lists/*
# Put the installed provider CLIs (tools volume bin) on PATH for the tmux PANE shells
# the cli-runner opens for chat + login (#342). The entrypoint exports PATH for the
# cli-runner PROCESS, but tmux launches each pane as a login shell that re-runs
# /etc/profile and RESETS PATH — so without this snippet a bare `claude`/`codex` in a
# pane is "command not found" (login surfaces no OAuth URL; chat can't launch the CLI).
# #1659 defect 4: JARVIS_UAT_SCRIPTED_PROVIDER_BIN (when set) is prepended ahead of the
# real tools bin — a dedicated PATH entry for the UAT scripted-provider fixture, kept
# deliberately separate from JARVIS_CLI_TOOLS_PREFIX so the production installer's
# reconcileInstalledProviders() (which also owns that var) can never clobber the fixture.
RUN printf '%s\n' 'export PATH="${JARVIS_UAT_SCRIPTED_PROVIDER_BIN:+$JARVIS_UAT_SCRIPTED_PROVIDER_BIN:}${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}/bin:$PATH"' \
  > /etc/profile.d/jarvis-cli-path.sh \
  && chmod 0644 /etc/profile.d/jarvis-cli-path.sh
# The full workspace src + node_modules (tsx, esbuild, workspace symlinks) and the
# SQL tree (infra/postgres, packages/*/sql) are ALREADY present from the build
# stage at their real repo-relative paths, so `tsx scripts/migrate.ts` resolves the
# workspace and every module's import.meta.url-relative ../sql correctly. The
# .dockerignore must NOT exclude packages, apps, scripts, or infra/postgres (Task 4).
# Writable mount points for an arbitrary runtime uid (the prod Compose runs as the
# host operator uid, which may differ from the image node uid — High UID finding).
RUN mkdir -p "$HF_HOME" /data/vaults /data/cli-tools /data/cli-auth /run/jarv1s \
  && chown -R node:node /data /run/jarv1s \
  && chmod -R 0777 "$HF_HOME" /data/vaults /data/cli-tools /data/cli-auth \
  && chmod 0700 /run/jarv1s
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "scripts/start-jarv1s.ts"]
