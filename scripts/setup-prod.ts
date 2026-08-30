import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveMossEnv } from "@moss/db";

import { TlsConfigError, deriveTrustedOrigins, resolveTlsSettings } from "./setup-prod-origins.js";
import { deriveNotesEnvLines } from "./setup-prod-notes.js";

// First-run boot-secret generator. Runs INSIDE the api image as
// `tsx scripts/setup-prod.ts [OUT_DIR]` (the prod Compose `setup` service).
// It generates every boot secret the stack needs into a single operator-owned
// env file, so an operator never hand-writes raw secret material. Non-interactive
// (TTY-through-compose is fragile); localhost defaults cover the common
// single-operator household case. See infra/docker-compose.prod.yml header.

const OUT_DIR = process.argv[2] ?? resolveMossEnv(process.env, "JARVIS_SETUP_OUT") ?? "/deploy";
const OUT_FILE = join(OUT_DIR, "env.production.local");

// CRITICAL — idempotency guard. Regenerating BETTER_AUTH_SECRET / the *_SECRET_KEY
// orphans encrypted connector/AI data and invalidates every session; regenerating
// POSTGRES_PASSWORD after first init is silently ignored (Postgres reads it only on
// volume init). So this script REFUSES to overwrite an existing file — the operator
// must back it up + remove it to regenerate. Never silently rotate from here.
if (existsSync(OUT_FILE)) {
  console.error(
    `ERROR: ${OUT_FILE} already exists — refusing to overwrite.\n` +
      "Regenerating the auth secret / *_SECRET_KEY orphans sessions + encrypted " +
      "connector/AI data, and a new POSTGRES_PASSWORD is ignored by an existing " +
      "data volume. To regenerate (DATA LOSS): back this file up, remove it, then " +
      "re-run setup."
  );
  process.exit(1);
}

// --- Host-specifics (LOCALHOST defaults; override via the setup container env). -
const apiPort = process.env.JARVIS_API_PORT ?? "3000";
const webPort = process.env.JARVIS_WEB_PORT ?? "1533";
// JARVIS_AUTH_BASE_URL is the API process's own in-container URL. Browser origins
// belong in JARVIS_AUTH_TRUSTED_ORIGINS below and are derived from JARVIS_WEB_PORT
// plus JARVIS_PUBLIC_ORIGIN unless explicitly overridden.
const authBaseUrl = resolveMossEnv(process.env, "JARVIS_AUTH_BASE_URL") ?? "http://localhost:3000";
const embedProvider = process.env.JARVIS_EMBED_PROVIDER ?? "local";
const hostUid = process.env.JARVIS_HOST_UID ?? "1000";
const hostGid = process.env.JARVIS_HOST_GID ?? "1000";
const imageTag = process.env.JARVIS_IMAGE_TAG ?? "v0.1.0";
// Subnet default matches env.production.example, but it is OVERRIDABLE: docker
// network subnets are globally unique, so an operator whose host already has a
// network on 10.251.0.0/24 (e.g. the dev compose `infra_jarv1s`, or any other
// stack) would otherwise hit a "Pool overlaps" error at `up`.
const dockerSubnet = process.env.JARVIS_DOCKER_SUBNET ?? "10.251.0.0/24";

// --- TLS (opt-in, #1505) + trusted origins. Validated BEFORE any secret is generated -----
// or written, so a bad JARVIS_TLS_HOST / JARVIS_TLS_ISSUER never leaves a partially-built
// file behind (D8). Exit code 3 is reserved for this class of error (1 and 2 are taken by
// the no-overwrite guard and the bootstrap-password assertion below).
let tlsSettings;
let authTrustedOrigins: string;
try {
  tlsSettings = resolveTlsSettings({
    // Deliberately NOT resolveMossEnv: Docker Compose host-side interpolation and the
    // Caddyfile read JARVIS_TLS_HOST/JARVIS_TLS_ISSUER directly and cannot see a MOSS_*
    // rename, so these two names must stay literal (#1505 review).
    host: process.env.JARVIS_TLS_HOST,
    issuer: process.env.JARVIS_TLS_ISSUER,
    dockerSubnet
  });
  // #379: build the better-auth trusted-origins list. localhost:<webPort> always (on-box /
  // port-forward reach), PLUS the host public origin supplied through JARVIS_PUBLIC_ORIGIN
  // so signup works from the real LAN/tailnet/domain URL, PLUS the TLS HTTPS origin when TLS
  // is on. An explicit JARVIS_AUTH_TRUSTED_ORIGINS override still wins verbatim, but must
  // include the HTTPS origin when TLS is on or setup refuses to write the file (D9). A
  // non-default JARVIS_WEB_PORT is honored (never falls back to :1533).
  authTrustedOrigins = deriveTrustedOrigins({
    webPort,
    publicOrigin: resolveMossEnv(process.env, "JARVIS_PUBLIC_ORIGIN"),
    override: resolveMossEnv(process.env, "JARVIS_AUTH_TRUSTED_ORIGINS"),
    httpsOrigin: tlsSettings?.httpsOrigin
  });
} catch (error) {
  const message = error instanceof TlsConfigError ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(3);
}

// --- Generate boot secrets once (node:crypto). ------------------------------
// BETTER_AUTH_SECRET drives session + JWT signing (48 bytes -> base64).
const betterAuthSecret = randomBytes(48).toString("base64");
// Connector / AI secret keys are the at-rest encryption keys for connector creds
// and AI provider config — 32 bytes -> hex.
const connectorSecretKey = randomBytes(32).toString("hex");
const aiSecretKey = randomBytes(32).toString("hex");
// POSTGRES_PASSWORD is the superuser password for FIRST volume init. base64url
// (18 bytes) keeps it URL-safe since it is also embedded in the bootstrap URL below.
const postgresPassword = randomBytes(18).toString("base64url");
// Four DISTINCT runtime-role passwords (base64url so they survive the DB URLs).
const migrationPassword = randomBytes(18).toString("base64url");
const appPassword = randomBytes(18).toString("base64url");
const authPassword = randomBytes(18).toString("base64url");
const workerPassword = randomBytes(18).toString("base64url");
// cli-runner socket auth secret (#342): shared between api + cli-runner for the
// connection auth hello (RPC-contract §3.6/§6.6). Known ONLY to those two
// processes; excluded from the CLI-subprocess env allowlist. 32 bytes -> hex.
const cliRunnerRpcSecret = randomBytes(32).toString("hex");

// --- DB role URLs (embed the generated per-role passwords). ------------------
// Host/port are the in-compose service names (postgres:5432), NOT localhost.
const DB_HOST = "postgres";
const DB_PORT = "5432";
const DB_NAME = "jarv1s";
const bootstrapDatabaseUrl = `postgres://postgres:${postgresPassword}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
const migrationDatabaseUrl = `postgres://jarvis_migration_owner:${migrationPassword}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
const appDatabaseUrl = `postgres://jarvis_app_runtime:${appPassword}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
const authDatabaseUrl = `postgres://jarvis_auth_runtime:${authPassword}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
const workerDatabaseUrl = `postgres://jarvis_worker_runtime:${workerPassword}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;

// Assert the superuser password embedded in the bootstrap URL is EXACTLY
// POSTGRES_PASSWORD — they are two views of the SAME secret (POSTGRES_PASSWORD
// sets the superuser on first volume init; the bootstrap URL authenticates
// migrate as that superuser). A divergence makes migrate fail fast on auth, so
// fail closed here before a bogus file is written.
const bootstrapPassword = new URL(bootstrapDatabaseUrl).password;
if (bootstrapPassword !== postgresPassword) {
  console.error(
    "ERROR: JARVIS_BOOTSTRAP_DATABASE_URL password does not match POSTGRES_PASSWORD " +
      `(bootstrap=${bootstrapPassword}, postgres=${postgresPassword}). Aborting.`
  );
  process.exit(2);
}

// --- Render the env file (same key set + ordering as env.production.example). -
const generatedAt = new Date().toISOString();
const content = [
  `# Generated by scripts/setup-prod.ts on ${generatedAt}.`,
  "# Operator-owned — BACK THIS UP. Losing the auth secret / *_SECRET_KEY",
  "# orphans sessions + encrypted connector/AI data. To regenerate (DATA LOSS):",
  "# back this file up, remove it, then re-run setup (it refuses to overwrite).",
  "",
  "NODE_ENV=production",
  "",
  "# Public service URL and host bindings (localhost defaults).",
  `JARVIS_API_PORT=${apiPort}`,
  `JARVIS_WEB_PORT=${webPort}`,
  `JARVIS_DOCKER_SUBNET=${dockerSubnet}`,
  `MOSS_AUTH_BASE_URL=${authBaseUrl}`,
  `MOSS_AUTH_TRUSTED_ORIGINS=${authTrustedOrigins}`,
  "",
  ...(tlsSettings
    ? [
        "# TLS reverse proxy (opt-in; the `tls` Compose profile). Non-secret values.",
        `JARVIS_TLS_HOST=${tlsSettings.host}`,
        `JARVIS_TLS_ISSUER=${tlsSettings.issuer}`,
        "# Exact static Caddy address on the jarv1s network — never the bridge CIDR or gateway.",
        `MOSS_TRUST_PROXY=${tlsSettings.trustProxyIp}`,
        ""
      ]
    : []),
  "# Database role URLs (distinct generated passwords per role).",
  `MOSS_BOOTSTRAP_DATABASE_URL=${bootstrapDatabaseUrl}`,
  `MOSS_MIGRATION_DATABASE_URL=${migrationDatabaseUrl}`,
  `MOSS_APP_DATABASE_URL=${appDatabaseUrl}`,
  `MOSS_AUTH_DATABASE_URL=${authDatabaseUrl}`,
  `MOSS_WORKER_DATABASE_URL=${workerDatabaseUrl}`,
  "",
  "# Required production secrets (generate once; keep stable across restarts).",
  `BETTER_AUTH_SECRET=${betterAuthSecret}`,
  `MOSS_CONNECTOR_SECRET_KEY=${connectorSecretKey}`,
  `MOSS_AI_SECRET_KEY=${aiSecretKey}`,
  "",
  "# The image tag this deploy runs (pin a concrete version; never :edge/:latest).",
  `JARVIS_IMAGE_TAG=${imageTag}`,
  "",
  "# Postgres superuser password (first volume init only). MUST equal the password",
  "# in JARVIS_BOOTSTRAP_DATABASE_URL above (asserted at generation time).",
  `POSTGRES_PASSWORD=${postgresPassword}`,
  "",
  "# Runtime env_file the prod Compose loads into each container. Resolves relative",
  "# to the compose file's dir, so ./env.production.local lands next to it.",
  "JARVIS_ENV_FILE=./env.production.local",
  "",
  "# Embedding model cache (named volume mounts here so weights survive restarts).",
  "HF_HOME=/app/.cache/huggingface",
  "",
  "# Container runtime user == host operator uid/gid (owns the init-chowned volumes).",
  `JARVIS_HOST_UID=${hostUid}`,
  `JARVIS_HOST_GID=${hostGid}`,
  "",
  "# Containerized multiplexer = tmux only (the cli-runner forks its own server).",
  "MOSS_MULTIPLEXER=tmux",
  "",
  "# cli-runner RPC (#342). The socket selects the in-container CLI-chat path; the",
  "# secret authenticates API calls to the cli-runner over the socket auth hello",
  "# (never reaches a launched CLI). The gate keeps cli-runner single-active-user",
  "# until UID-separation (issue #347).",
  "JARVIS_CLI_RUNNER_SOCKET=/run/jarv1s/cli-runner.sock",
  `JARVIS_CLI_RUNNER_RPC_SECRET=${cliRunnerRpcSecret}`,
  "JARVIS_CLI_RUNNER_SINGLE_USER=1",
  "",
  '# Embedding provider: "local" downloads the model on first use; "stub" skips.',
  `JARVIS_EMBED_PROVIDER=${embedProvider}`,
  ""
];

// --- Notes Source host-folder bind mount (#449). -----------------------------
// Only emitted when the operator set JARVIS_NOTES_VAULT_HOST_PATH before setup.
// The mount target
// is a FIXED neutral path; the app reads it via JARVIS_NOTES_ROOTS regardless of
// the operator's host path. Read-only in v1; :rw reserved for write-back (#2).
content.push(...deriveNotesEnvLines(process.env.JARVIS_NOTES_VAULT_HOST_PATH));

const renderedContent = content.join("\n");

mkdirSync(OUT_DIR, { recursive: true });
// mode 0o600: operator-only read/write — this file is all the boot secrets.
writeFileSync(OUT_FILE, renderedContent, { mode: 0o600 });

console.log(`Wrote ${OUT_FILE} (mode 0600) with all boot secrets.`);
console.log("");
console.log("Next steps:");
console.log(`  1. Sign-in is trusted for these origins: ${authTrustedOrigins}`);
console.log("     (set JARVIS_PUBLIC_ORIGIN=https://your.host before setup to add another, or set");
console.log("     JARVIS_AUTH_TRUSTED_ORIGINS=<comma,list> to control the list yourself, then");
console.log("     redeploy — no need to re-run setup.)");
if (tlsSettings) {
  console.log(`     TLS is on — the stack will be reachable at ${tlsSettings.httpsOrigin}.`);
}
console.log("  2. BACK THIS FILE UP. It is the only copy of your auth/encryption keys;");
console.log("     losing it orphans sessions + encrypted connector/AI data.");
console.log("  3. Bring the stack up:");
console.log(
  "     docker compose -p jarv1s-prod -f docker-compose.prod.yml " +
    "--env-file ./env.production.local up -d --build"
);
