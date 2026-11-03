import type { DataContextRunner, PreferencesPort } from "@moss/db";
import { CHAT_SETTINGS_PREFERENCE_KEY, normalizeChatSettings } from "@moss/shared";
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

/**
 * Reads the signed-in person's own front-door switch under their own data context, so the read
 * cannot return another account's row. A failed read reports the switch as set.
 */
export function createFrontDoorSwitchReader(
  dataContext: Pick<DataContextRunner, "withDataContext">,
  preferences: Pick<PreferencesPort, "get">
): (actorUserId: string) => Promise<{ readonly disabled: boolean }> {
  return async (actorUserId) => {
    try {
      const raw = await dataContext.withDataContext({ actorUserId }, (db) =>
        preferences.get(db, CHAT_SETTINGS_PREFERENCE_KEY)
      );
      return { disabled: normalizeChatSettings(raw).frontDoorDisabled };
    } catch {
      return { disabled: true };
    }
  };
}

/**
 * Applies the personal switch on top of the admin mode. A person who turned the front door off
 * gets `off`, so neither the live gate nor the shadow runner calls a model or writes a record.
 */
export function withFrontDoorSwitch(
  readMode: (actorUserId: string) => Promise<GateMode>,
  readSwitch: (actorUserId: string) => Promise<{ readonly disabled: boolean }>
): (actorUserId: string) => Promise<GateMode> {
  return async (actorUserId) => {
    const mode = await readMode(actorUserId);
    if (mode === "off") return mode;
    return (await readSwitch(actorUserId)).disabled ? "off" : mode;
  };
}
