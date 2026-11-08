# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Moss static-web image (ghcr.io/motioneso/moss-web) — deployable-stack §4.
# Build the Vite SPA bundle, then serve it from nginx with /api + /health proxy.
# Built from the repo root context (so the workspace + lockfile are available).
# ---------------------------------------------------------------------------

# ---- build: produce apps/web/dist -----------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.6.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY . .
# #1059: node-pty (packages/cli-runner) is a workspace dependency with no linux
# prebuild, so `pnpm install` compiles it from source via node-gyp — which needs
# python3/make/g++. bookworm-slim lacks them, so the web build's install fails on
# node-pty exactly like the root image did (fixed in ../../Dockerfile). This build
# stage is discarded (runtime is FROM nginx below), so the toolchain never reaches
# the shipped image — no purge needed. The web bundle itself doesn't use node-pty;
# the compile is an unavoidable side-effect of installing the full workspace.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# Skip onnxruntime's optional CUDA download from GitHub releases; nothing uses it.
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install --frozen-lockfile
RUN pnpm build:web

# ---- runtime: nginx serving the static bundle -----------------------------
FROM nginx:1.27-bookworm AS runtime
COPY infra/nginx/jarv1s-web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
