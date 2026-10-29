import { join } from "node:path";
import {
  codexNoToolsConfig,
  getAcpProviderRow,
  type AcpProfile,
  type AcpProviderKind
} from "@moss/acp";

export function assertAcpSpawnProfile(profile: AcpProfile, providerKind: AcpProviderKind): void {
  if (profile !== "chat" && profile !== "workshop" && profile !== "no-tools")
    throw new Error("acpSpawn.profile must be chat, workshop or no-tools");
  const row = getAcpProviderRow(providerKind);
  if (profile === "chat" && !row.chatReady)
    throw new Error(`Not logged in (${row.chatBlockReason ?? "provider not ready"})`);
  if (profile === "no-tools" && !row.noToolsReady)
    throw new Error(
      `Not logged in (${row.noToolsBlockReason ?? "provider not ready for the no-tools profile"})`
    );
}

export function agentHomeForProfile(
  profile: AcpProfile,
  sessionDir: string,
  persistentHome: string
): string {
  return profile === "no-tools" ? join(sessionDir, ".private-home") : persistentHome;
}

export function codexNoToolsConfigFile(
  profile: AcpProfile,
  providerKind: AcpProviderKind,
  agentHome: string
): readonly { path: string; content: string }[] {
  return providerKind === "openai" && profile === "no-tools"
    ? [{ path: join(agentHome, ".codex", "config.toml"), content: codexNoToolsConfig() }]
    : [];
}
