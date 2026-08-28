import type { DataContextDb } from "@moss/db";
import type { HostDiagnosticsDto } from "@moss/shared";

import { buildHostDiagnostics, type HostDiagnosticsProvider } from "./host-diagnostics.js";
import type { GetChatMultiplexerStatus } from "./routes.js";
import type { SettingsRepository } from "./repository.js";

export interface HostDiagnosticsCollectorDependencies {
  readonly repository: Pick<SettingsRepository, "pingDatabase" | "getChatMultiplexerSetting">;
  readonly hostDiagnostics: HostDiagnosticsProvider;
  readonly getChatMultiplexerStatus?: GetChatMultiplexerStatus;
}

export async function collectHostDiagnostics(
  dependencies: HostDiagnosticsCollectorDependencies,
  scopedDb: DataContextDb
): Promise<HostDiagnosticsDto> {
  let dbOk = true;
  try {
    await dependencies.repository.pingDatabase(scopedDb);
  } catch {
    dbOk = false;
  }
  const { multiplexer } = await dependencies.repository.getChatMultiplexerSetting(scopedDb);

  const latestReleaseRaw = await scopedDb.db
    .selectFrom("app.instance_settings")
    .select("value")
    .where("key", "=", "latest_release")
    .executeTakeFirst();

  let latestAvailableVersion: string | null = null;
  let releaseNotes: string | null = null;
  if (latestReleaseRaw?.value) {
    const value = latestReleaseRaw.value as Record<string, unknown>;
    if (typeof value.version === "string") latestAvailableVersion = value.version;
    if (typeof value.notes === "string") releaseNotes = value.notes;
  }

  const pgBossOk = await dependencies.hostDiagnostics.pgBossInstalled().catch(() => false);
  const status = (await dependencies.getChatMultiplexerStatus?.(multiplexer)) ?? {
    available: { tmux: false, herdr: false },
    herdrInstalled: false,
    active: null,
    activeSource: null,
    envOverride: null
  };

  return buildHostDiagnostics({
    info: dependencies.hostDiagnostics.info(),
    multiplexer,
    available: status.available,
    dbOk,
    pgBossOk,
    latestAvailableVersion,
    releaseNotes
  });
}
