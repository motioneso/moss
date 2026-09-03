import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveTrustedOrigins } from "../../scripts/setup-prod-origins.js";
import { UAT_ADMIN_ID } from "./seed/admin.js";

export interface UatEnvFile {
  readonly path: string;
  readonly cleanup: () => void;
}

// #1024/#1000: single source of truth for the two dev-only secrets that BOTH get written into the
// env file (container env, via docker-compose.prod.yml's `env_file:`) AND must be exported as real
// process.env vars for compose-file `${...:?}` interpolation (see uatComposeInterpolationEnv below)
// — `env_file:` alone never feeds interpolation, only container env. Same trap as
// scripts/smoke-compose.ts's ensureProdSmokeEnv.
export const UAT_POSTGRES_PASSWORD = "postgres";
export const UAT_CLI_RUNNER_RPC_SECRET = "uat-only-not-real";

/**
 * #1024/#1000: same shape as scripts/smoke-compose.ts's ensureProdSmokeEnv (throwaway
 * env.production.local + dev-only secrets), but scoped to the UAT subnet/port and pinned to the
 * `stub` embed provider for the `bare` level (no users → nothing to embed → no reason to pull the
 * real embedding model into a per-run, per-project model-cache volume; spec §3.3).
 */
export function writeUatEnvFile(input: {
  readonly webPort: number;
  readonly subnet: string;
  // #1306 Task 22: opt-in, absent by default. When set, activates
  // apps/worker/src/external-module-job-handler.ts's host-side createFetch bypass so the
  // job-search module's crawl hits a fixture origin instead of the real LinkedIn/freehire.me —
  // provisioner-only, per the ruling that neither JARVIS_RUNTIME_MODE nor
  // JARVIS_E2E_MODULE_FETCH_BASE may appear in any checked-in compose file, .env.example, or dev
  // script. See provisionForUat's jobSearchFixture wiring.
  readonly jobSearchFixtureBaseUrl?: string;
  // #1121: the scripted provider (tests/uat/fixtures/scripted-provider/claude-main.ts) reads
  // JARVIS_UAT_SEED_CHAT_SCRIPT from its OWN process env at app runtime, inside the jarv1s
  // container — so it has to be here, not only on composeSeedHook's `docker -e` args. Same
  // runtime-vs-seed-time split as JARVIS_UAT_NEWS_TRANSIENT_INPUT below.
  readonly chatScript?: string;
}): UatEnvFile {
  const dir = mkdtempSync(join(tmpdir(), "jarv1s-uat-"));
  const path = join(dir, "env.production.local");
  try {
    writeFileSync(
      path,
      [
        "NODE_ENV=production",
        `JARVIS_WEB_PORT=${input.webPort}`,
        // #1026: Playwright drives this instance at http://127.0.0.1:<webPort> (see baseURL
        // below), which is a DIFFERENT origin than better-auth's "http://localhost:<port>"
        // default (resolveAuthOriginConfig, packages/auth/src/runtime-config.ts) — 127.0.0.1 and
        // localhost are distinct origins for its exact-string check, so login was rejected with
        // "Invalid origin" until this was added. Reuses the same deriveTrustedOrigins helper
        // scripts/setup-prod.ts uses for real deploys (#379) rather than hand-rolling the list.
        `JARVIS_AUTH_TRUSTED_ORIGINS=${deriveTrustedOrigins({ webPort: String(input.webPort), publicOrigin: "127.0.0.1" })}`,
        `JARVIS_DOCKER_SUBNET=${input.subnet}`,
        `POSTGRES_PASSWORD=${UAT_POSTGRES_PASSWORD}`,
        "JARVIS_BOOTSTRAP_DATABASE_URL=postgres://postgres:postgres@postgres:5432/jarv1s",
        // #1024/#1000: jarvis_migration_owner is NOSUPERUSER/NOBYPASSRLS but schema-owner + a
        // member of jarvis_auth_runtime (infra/postgres/bootstrap/0000_roles.sql) — this is the
        // seam #1025's seed script plugs a privileged connection into. NEVER grant BYPASSRLS to
        // jarvis_app_runtime / jarvis_worker_runtime — that would violate the project's hard "no
        // BYPASSRLS on runtime roles" invariant.
        "JARVIS_MIGRATION_DATABASE_URL=postgres://jarvis_migration_owner:uat-migration-pw@postgres:5432/jarv1s",
        "JARVIS_APP_DATABASE_URL=postgres://jarvis_app_runtime:uat-app-pw@postgres:5432/jarv1s",
        "JARVIS_AUTH_DATABASE_URL=postgres://jarvis_auth_runtime:uat-auth-pw@postgres:5432/jarv1s",
        "JARVIS_WORKER_DATABASE_URL=postgres://jarvis_worker_runtime:uat-worker-pw@postgres:5432/jarv1s",
        "BETTER_AUTH_SECRET=uat-only-not-a-real-secret-00000000000",
        "JARVIS_CONNECTOR_SECRET_KEY=00000000000000000000000000000000",
        "JARVIS_AI_SECRET_KEY=11111111111111111111111111111111",
        // #1024/#1000: required in any non-development/test NODE_ENV since #918 Slice 2
        // (resolveKeyring enforces >=32 bytes) — matches .github/workflows/ci.yml's convention.
        // Caught live by Task 7 (this plan predates #918 landing on main).
        "JARVIS_MODULE_CREDENTIAL_SECRET_KEY=22222222222222222222222222222222",
        // #2005 — same boot-crash class as the line above: resolveKeyring throws at
        // startup when this is missing outside development/test.
        "JARVIS_NEWS_CREDENTIAL_SECRET_KEY=22222222222222222222222222222222",
        // #2173: same boot-crash class — resolveKeyring throws at startup when this is missing
        // outside development/test. Real crash caught by the cached-image UAT repro.
        "JARVIS_INTEGRATIONS_SECRET_KEY=33333333333333333333333333333333",
        `JARVIS_CLI_RUNNER_RPC_SECRET=${UAT_CLI_RUNNER_RPC_SECRET}`,
        // #1883: this one chat script needs a real, local embedding provider so notes.search
        // actually calls out over the network and can hit a real connection failure — every other
        // chat script keeps the stub lines below unchanged (see the #1313 comment on why `bare`
        // depends on staying on stub). Only one of these two provider lines is ever written.
        ...(input.chatScript === "1883-vault-search-dependency-failure"
          ? [
              "JARVIS_EMBED_PROVIDER=local",
              "NODE_OPTIONS=--import=/app/tests/uat/fixtures/embedding-refused.mjs"
            ]
          : [
              "JARVIS_EMBED_PROVIDER=stub",
              // #1313: this instance runs NODE_ENV=production above (not the vitest
              // NODE_ENV=test signal), so without this explicit escape hatch
              // createEmbeddingProvider would now refuse "stub" and silently fall back to
              // "local" -- reintroducing exactly the real-model download into a per-run cache
              // volume this UAT `bare` level exists to avoid.
              "JARVIS_ALLOW_STUB_EMBEDDINGS=1"
            ]),
        `JARVIS_NOTES_ROOTS=/data/vaults/${UAT_ADMIN_ID}`,
        // #1110: module-registry's buildUatNewsPreviewOverride() reads these at app runtime (not
        // seed-time) to deterministically fake a transient News preview error for one sentinel
        // input — hence env_file: here, not the seed container's docker -e args below.
        "JARVIS_UAT_SEED_CONFIRM=1",
        "JARVIS_UAT_NEWS_TRANSIENT_INPUT=uat-transient.invalid",
        // #1121: absent unless a spec declares uatLevel.chatScript. Omitted rather than written
        // empty so a stack with no scripted chat never hands the provider a "" it would reject.
        ...(input.chatScript ? [`JARVIS_UAT_SEED_CHAT_SCRIPT=${input.chatScript}`] : []),
        // #1659 defect 4: a dedicated PATH entry for the scripted provider's own bin/claude,
        // read by Dockerfile:72's profile.d script — deliberately NOT JARVIS_CLI_TOOLS_PREFIX,
        // which is also the production installer's toolsPrefix (install-service.ts's
        // reconcileInstalledProviders clobbers whatever sits at ${toolsPrefix}/bin/claude with
        // the real CLI on every boot). Same absent-unless-set shape as the line above.
        ...(input.chatScript
          ? ["JARVIS_UAT_SCRIPTED_PROVIDER_BIN=/app/tests/uat/fixtures/scripted-provider/bin"]
          : []),
        // #1306 Task 22: absent unless a caller passes jobSearchFixtureBaseUrl — see this
        // function's param doc. JARVIS_RUNTIME_MODE alone (without the base URL) would throw at
        // host boot per resolveE2eFetchOverride's fail-closed guard, so these two are written
        // together or not at all.
        ...(input.jobSearchFixtureBaseUrl
          ? [
              "JARVIS_RUNTIME_MODE=e2e",
              `JARVIS_E2E_MODULE_FETCH_BASE=${input.jobSearchFixtureBaseUrl}`
            ]
          : []),
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
  } catch (error) {
    rmSync(dir, { force: true, recursive: true });
    throw error;
  }
  return { path, cleanup: () => rmSync(dir, { force: true, recursive: true }) };
}
