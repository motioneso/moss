import type { PgBoss } from "./pg-boss.js";
import {
  UPGRADE_CHECK_QUEUE,
  UPGRADE_NOTIFY_QUEUE,
  assertMetadataOnlyPayload,
  sendJob
} from "./pg-boss.js";
import type { Kysely } from "kysely";
import { resolveMossEnv, type MossDatabase } from "@moss/db";
import { compareMossVersions } from "@moss/module-sdk";

const UPGRADE_CHECK_CRON = "0 0 * * *"; // Daily at midnight
const UPGRADE_CHECK_KEY = "system.upgrade-check";

export async function reconcileUpgradeCheckSchedule(boss: PgBoss): Promise<void> {
  const data = { kind: "upgrade-check" as const };
  assertMetadataOnlyPayload(data);
  await boss.schedule(UPGRADE_CHECK_QUEUE, UPGRADE_CHECK_CRON, data, {
    tz: "UTC",
    key: UPGRADE_CHECK_KEY
  });
}

export interface UpgradeNotifyPayload {
  readonly kind: "upgrade-notify";
  readonly actorUserId: string;
  readonly version: string;
}

export async function handleUpgradeCheckJob(
  workerDb: Kysely<MossDatabase>,
  boss?: PgBoss
): Promise<void> {
  const currentVersion = resolveMossEnv(process.env, "JARVIS_APP_VERSION");
  if (!currentVersion) {
    return; // Not running a tagged release, nothing to check
  }

  const res = await fetch("https://api.github.com/repos/motioneso/Jarv1s/releases/latest", {
    headers: {
      "User-Agent": "Jarvis-Upgrade-Checker",
      Accept: "application/vnd.github.v3+json"
    },
    signal: AbortSignal.timeout(10_000)
  });

  if (!res.ok && (res.status === 403 || res.status === 429 || res.status >= 500)) {
    process.stderr.write(
      `${JSON.stringify({ level: "warn", event: "upgrade_check_soft_skip", status: res.status })}\n`
    );
    return;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch latest release: ${res.status}`);
  }

  let release: { tag_name: string; body: string };
  try {
    release = (await res.json()) as { tag_name: string; body: string };
  } catch {
    throw new Error("Invalid release response: unparsable body");
  }
  if (!release.tag_name) {
    throw new Error("Invalid release response: missing tag_name");
  }

  if (compareMossVersions(release.tag_name, currentVersion) > 0) {
    const value = {
      version: release.tag_name,
      notes: release.body || ""
    };

    await workerDb
      .insertInto("app.instance_settings")
      .values({
        key: "latest_release",
        value,
        updated_by_user_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          value,
          updated_at: new Date().toISOString()
        })
      )
      .execute();

    if (!boss) return;
    // #1721: ordered and limited to two so the recipient is the same user on every run and a
    // duplicate-owner database is visible in the log. Unlike the destructive-operation guard in
    // packages/db/src/target-identity-guard.ts, ambiguity here must not refuse: this only decides
    // who gets told an upgrade is available, and staying silent about upgrades is the worse
    // outcome. So it notifies the oldest owner and says plainly that it had to choose.
    const owners = await workerDb
      .selectFrom("app.users")
      .select("id")
      .where("is_bootstrap_owner", "=", true)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(2)
      .execute();
    const owner = owners[0];
    if (owners.length > 1) {
      process.stderr.write(
        `${JSON.stringify({
          level: "warn",
          event: "upgrade_notify_multiple_owners",
          notifiedUserId: owners[0]!.id
        })}\n`
      );
    }
    if (!owner) {
      process.stderr.write(
        `${JSON.stringify({ level: "warn", event: "upgrade_notify_no_owner" })}\n`
      );
      return;
    }

    await sendJob<UpgradeNotifyPayload>(
      boss,
      UPGRADE_NOTIFY_QUEUE,
      { kind: "upgrade-notify", actorUserId: owner.id, version: release.tag_name },
      { singletonKey: `upgrade-notify:${owner.id}:${release.tag_name}` }
    );
  }
}
