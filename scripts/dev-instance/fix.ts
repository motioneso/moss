import { AiRepository } from "@moss/ai";

import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_ID,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_ID
} from "../../tests/uat/seed/admin.js";
import { resolveActiveAdminUserId, type DoctorDeps, type DoctorReport } from "./doctor.js";

export type FixActionId = "flag-instance-default" | "purge-uat-fixture-rows";

export interface FixOutcome {
  readonly id: FixActionId;
  readonly changed: boolean;
  readonly detail: string;
}

const repository = new AiRepository();

function checkFailed(report: DoctorReport, id: DoctorReport["checks"][number]["id"]): boolean {
  return report.checks.some((check) => check.id === id && !check.ok);
}

async function flagInstanceDefault(deps: DoctorDeps, report: DoctorReport): Promise<FixOutcome> {
  if (!checkFailed(report, "single-instance-default-provider")) {
    return {
      id: "flag-instance-default",
      changed: false,
      detail: "single-instance-default-provider check is already passing; nothing to flag"
    };
  }

  const adminUserId = await resolveActiveAdminUserId(deps.migrationDb);
  if (!adminUserId) {
    return {
      id: "flag-instance-default",
      changed: false,
      detail: "no active instance-admin user to scope the fix to"
    };
  }

  return deps.runner.withDataContext({ actorUserId: adminUserId }, async (scopedDb) => {
    const providers = await repository.listProviders(scopedDb);
    const activeProviders = providers.filter((provider) => provider.status === "active");
    if (activeProviders.length === 0) {
      return {
        id: "flag-instance-default",
        changed: false,
        detail: "no active provider to flag as instance default"
      };
    }

    const target = activeProviders[0]!;
    await repository.setInstanceDefaultProvider(scopedDb, target.id);
    return {
      id: "flag-instance-default",
      changed: true,
      detail: `flagged provider ${target.id} (${target.display_name}) as instance default`
    };
  });
}

async function purgeUatFixtureRows(deps: DoctorDeps, report: DoctorReport): Promise<FixOutcome> {
  if (!checkFailed(report, "no-uat-fixture-rows")) {
    return {
      id: "purge-uat-fixture-rows",
      changed: false,
      detail: "no-uat-fixture-rows check is already passing; nothing to purge"
    };
  }

  const result = await deps.migrationDb
    .deleteFrom("app.users")
    .where((eb) =>
      eb.or([
        eb("id", "in", [UAT_ADMIN_ID, UAT_SECOND_OWNER_ID]),
        eb("email", "in", [UAT_ADMIN_EMAIL, UAT_SECOND_OWNER_EMAIL])
      ])
    )
    .executeTakeFirst();
  const deletedCount = Number(result.numDeletedRows ?? 0);

  return {
    id: "purge-uat-fixture-rows",
    changed: deletedCount > 0,
    detail:
      deletedCount > 0
        ? `deleted ${deletedCount} UAT fixture user row(s)`
        : "no UAT fixture rows were present"
  };
}

/**
 * Acts only on defects the given report actually names — never repairs speculatively. Every
 * action still returns an outcome even when its check already passes, so a healthy report
 * yields outcomes that are all `changed: false` with nothing written.
 */
export async function runFix(deps: DoctorDeps, report: DoctorReport): Promise<readonly FixOutcome[]> {
  return [await flagInstanceDefault(deps, report), await purgeUatFixtureRows(deps, report)];
}
