import type { Kysely } from "kysely";

import type { AiSecretCipher } from "@moss/ai";
import type { DataContextRunner, MossDatabase } from "@moss/db";

import type { DevInstanceConfig } from "./config.js";
import { DOCTOR_CHECKS } from "./doctor-checks.js";

export type DoctorCheckId =
  | "database-reachable"
  | "migrations-current"
  | "active-instance-admin"
  | "single-instance-default-provider"
  | "chat-model-resolves"
  | "provider-credential-decrypts"
  | "no-uat-fixture-rows"
  | "cli-runner-reachable";

export interface DoctorCheckResult {
  readonly id: DoctorCheckId;
  readonly ok: boolean;
  readonly detail: string;
  readonly repair: string | null;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheckResult[];
}

export interface DoctorDeps {
  readonly migrationDb: Kysely<MossDatabase>;
  readonly runner: DataContextRunner;
  readonly cipher: AiSecretCipher;
  readonly config: DevInstanceConfig;
  readonly migrationDirectories: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly repair: string;
  run(deps: DoctorDeps, adminUserId: string | null): Promise<{ ok: boolean; detail: string }>;
}

export async function resolveActiveAdminUserId(
  migrationDb: Kysely<MossDatabase>
): Promise<string | null> {
  const row = await migrationDb
    .selectFrom("app.users")
    .select("id")
    .where("is_instance_admin", "=", true)
    .where("status", "=", "active")
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const adminUserId = await resolveActiveAdminUserId(deps.migrationDb);

  const checks: DoctorCheckResult[] = [];
  for (const check of DOCTOR_CHECKS) {
    const { ok, detail } = await check.run(deps, adminUserId);
    checks.push({ id: check.id, ok, detail, repair: ok ? null : check.repair });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => {
    const status = check.ok ? "PASS" : "FAIL";
    const base = `${status} ${check.id}: ${check.detail}`;
    return check.repair ? `${base}\n  repair: ${check.repair}` : base;
  });
  return lines.join("\n");
}
