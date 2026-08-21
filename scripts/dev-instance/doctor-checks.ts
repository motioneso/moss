import { sql } from "kysely";

import { AiRepository } from "@moss/ai";
import { readMigrationStatus, type DataContextDb } from "@moss/db";
import { resolveMossEnv } from "@moss/db";

import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_ID,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_ID
} from "../../tests/uat/seed/admin.js";
import { RUN_DIR_REPAIR_COMMAND, probeCliRunner } from "./cli-runner.js";
import type { DoctorCheck, DoctorDeps } from "./doctor.js";

const repository = new AiRepository();

const NEEDS_ADMIN_DETAIL =
  "the active-instance-admin check must pass before this check can run — no admin id to scope the query to";

async function withAdmin(
  deps: DoctorDeps,
  adminUserId: string | null,
  run: (scopedDb: DataContextDb) => Promise<{ ok: boolean; detail: string }>
): Promise<{ ok: boolean; detail: string }> {
  if (!adminUserId) {
    return { ok: false, detail: NEEDS_ADMIN_DETAIL };
  }
  return deps.runner.withDataContext({ actorUserId: adminUserId }, run);
}

const databaseReachable: DoctorCheck = {
  id: "database-reachable",
  repair: "pnpm db:up",
  async run(deps) {
    try {
      await sql`select 1`.execute(deps.migrationDb);
      return { ok: true, detail: "database connection and `select 1` succeeded" };
    } catch (error) {
      return { ok: false, detail: `database connection failed: ${(error as Error).message}` };
    }
  }
};

const migrationsCurrent: DoctorCheck = {
  id: "migrations-current",
  repair: "pnpm db:migrate",
  async run(deps) {
    const status = await readMigrationStatus(deps.migrationDb, deps.migrationDirectories);
    if (status.drifted.length > 0) {
      return {
        ok: false,
        detail: `${status.drifted.length} migration(s) drifted from disk (run pnpm db:reset instead): ${status.drifted.map((d) => d.name).join(", ")}`
      };
    }
    if (status.pending.length > 0) {
      return {
        ok: false,
        detail: `${status.pending.length} migration(s) pending: ${status.pending.map((p) => p.name).join(", ")}`
      };
    }
    return { ok: true, detail: "no pending or drifted migrations" };
  }
};

const activeInstanceAdmin: DoctorCheck = {
  id: "active-instance-admin",
  repair: "pnpm dev:instance provision",
  async run(_deps, adminUserId) {
    if (!adminUserId) {
      return { ok: false, detail: "no active instance-admin user found" };
    }
    return { ok: true, detail: `active instance-admin found: ${adminUserId}` };
  }
};

const singleInstanceDefaultProvider: DoctorCheck = {
  id: "single-instance-default-provider",
  repair: "pnpm dev:instance fix",
  async run(deps, adminUserId) {
    return withAdmin(deps, adminUserId, async (scopedDb) => {
      const providerId = await repository.resolveDefaultProviderId(scopedDb);
      if (!providerId) {
        return {
          ok: false,
          detail:
            "no single instance-default assistant provider resolves (zero providers, or " +
            "more than one active admin-owned provider with none flagged default)"
        };
      }
      return { ok: true, detail: `instance-default provider resolves: ${providerId}` };
    });
  }
};

const chatModelResolves: DoctorCheck = {
  id: "chat-model-resolves",
  repair: "pnpm dev:instance provision",
  async run(deps, adminUserId) {
    return withAdmin(deps, adminUserId, async (scopedDb) => {
      const model = await repository.selectChatModelForUser(scopedDb);
      if (!model) {
        return { ok: false, detail: "no model with the chat capability resolves for the admin" };
      }
      return { ok: true, detail: `chat model resolves: ${model.display_name}` };
    });
  }
};

const providerCredentialDecrypts: DoctorCheck = {
  id: "provider-credential-decrypts",
  repair: "key/NODE_ENV mismatch; re-run provision with NODE_ENV unset",
  async run(deps, adminUserId) {
    return withAdmin(deps, adminUserId, async (scopedDb) => {
      const providerId = await repository.resolveDefaultProviderId(scopedDb);
      if (!providerId) {
        return {
          ok: false,
          detail: "no instance-default provider to check a credential against"
        };
      }
      const row = await scopedDb.db
        .selectFrom("app.ai_provider_configs")
        .select("encrypted_credential")
        .where("id", "=", providerId)
        .executeTakeFirst();
      if (!row) {
        return { ok: false, detail: "instance-default provider row disappeared" };
      }
      try {
        deps.cipher.decryptJson(deps.cipher.parseEnvelope(row.encrypted_credential));
        return { ok: true, detail: "default provider credential decrypts" };
      } catch (error) {
        return {
          ok: false,
          detail: `default provider credential does not decrypt: ${(error as Error).message}`
        };
      }
    });
  }
};

const NO_UAT_FIXTURE_IDS = [UAT_ADMIN_ID, UAT_SECOND_OWNER_ID] as const;
const NO_UAT_FIXTURE_EMAILS = [UAT_ADMIN_EMAIL, UAT_SECOND_OWNER_EMAIL] as const;

const noUatFixtureRows: DoctorCheck = {
  id: "no-uat-fixture-rows",
  repair: "pnpm dev:instance fix",
  async run(deps) {
    const row = await deps.migrationDb
      .selectFrom("app.users")
      .select("id")
      .where((eb) =>
        eb.or([eb("id", "in", NO_UAT_FIXTURE_IDS), eb("email", "in", NO_UAT_FIXTURE_EMAILS)])
      )
      .executeTakeFirst();
    if (row) {
      return { ok: false, detail: "a UAT fixture user row is present on this instance" };
    }
    return { ok: true, detail: "no UAT fixture rows present" };
  }
};

const cliRunnerReachable: DoctorCheck = {
  id: "cli-runner-reachable",
  repair: `pnpm dev:instance provision (if the socket directory itself is missing: ${RUN_DIR_REPAIR_COMMAND})`,
  async run(deps) {
    // Delegates to probeCliRunner rather than driving RpcConnection here: that probe carries the
    // deadline (ensureConnected retries forever, which would hang the checkup) and the
    // missing-socket-directory message a fresh machine needs.
    const rpcSecret = resolveMossEnv(deps.env, "JARVIS_CLI_RUNNER_RPC_SECRET") ?? "";
    const status = await probeCliRunner(deps.config.cliRunnerSocketPath, rpcSecret);
    return { detail: status.detail, ok: status.reachable };
  }
};

export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  databaseReachable,
  migrationsCurrent,
  activeInstanceAdmin,
  singleInstanceDefaultProvider,
  chatModelResolves,
  providerCredentialDecrypts,
  noUatFixtureRows,
  cliRunnerReachable
];
