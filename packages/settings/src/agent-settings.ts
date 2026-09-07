import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { ACP_AGENT_DEFAULT, isKnownAcpAgentId } from "@moss/shared";

import { CHAT_AGENT_SETTING, WORKSHOP_AGENT_SETTING } from "./instance-settings-keys.js";

export { CHAT_AGENT_SETTING, WORKSHOP_AGENT_SETTING };

async function readAgentSetting(scopedDb: DataContextDb, key: string): Promise<string> {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .selectFrom("app.instance_settings")
    .select(["value"])
    .where("key", "=", key)
    .executeTakeFirst();
  const val = (row?.value as { value?: unknown } | null)?.value;
  // Unknown or empty values fall back to today's engine, never to an agent.
  if (typeof val !== "string" || !isKnownAcpAgentId(val)) return ACP_AGENT_DEFAULT;
  return val;
}

/** The Workshop answering agent id, `default` when unset or unknown. */
export async function readWorkshopAgentSetting(scopedDb: DataContextDb): Promise<string> {
  return readAgentSetting(scopedDb, WORKSHOP_AGENT_SETTING);
}

/** The chat answering agent id, `default` when unset or unknown. */
export async function readChatAgentSetting(scopedDb: DataContextDb): Promise<string> {
  return readAgentSetting(scopedDb, CHAT_AGENT_SETTING);
}
