import type { DataContextRunner } from "@moss/db";
import { CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY, RuntimeConfigResolver } from "@moss/settings";

import type { GateMode } from "./classifier-gate.js";

/**
 * Reads the admin gate mode as the gate runs it. The stored value is used as is, so a saved or
 * environment `on` runs as `on` with no review or classifier check.
 */
export function createGateModeReader(
  dataContext: Pick<DataContextRunner, "withDataContext">,
  env: NodeJS.ProcessEnv = process.env
): (actorUserId: string) => Promise<GateMode> {
  return (actorUserId) =>
    dataContext.withDataContext({ actorUserId }, (scopedDb) =>
      new RuntimeConfigResolver(scopedDb, env).resolveEnum<GateMode>(
        CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY
      )
    );
}
