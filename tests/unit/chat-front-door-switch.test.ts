import { describe, expect, it, vi } from "vitest";

import {
  createFrontDoorSwitchReader,
  withFrontDoorSwitch
} from "../../packages/chat/src/live/classifier-gate-mode.js";
import type { GateMode } from "../../packages/chat/src/live/classifier-gate.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function reader(rows: Record<string, unknown>, fail = false) {
  const dataContext = {
    withDataContext: async <T>(
      access: { actorUserId: string },
      work: (db: never) => Promise<T>
    ) => {
      if (fail) throw new Error("db down");
      return work(access.actorUserId as never);
    }
  };
  const preferences = { get: vi.fn(async (actor: never) => rows[actor as string]) };
  return createFrontDoorSwitchReader(dataContext as never, preferences as never);
}

describe("front door personal switch", () => {
  const rows = { [A]: { responseStyle: "balanced", frontDoorDisabled: true } };

  it("3.a reads each person's own switch and gives the other person the front door", async () => {
    const mode = withFrontDoorSwitch(async () => "on" as GateMode, reader(rows));
    expect(await mode(A)).toBe("off");
    expect(await mode(B)).toBe("on");
  });

  it("turns shadow off for a person who opted out too", async () => {
    const mode = withFrontDoorSwitch(async () => "shadow" as GateMode, reader(rows));
    expect(await mode(A)).toBe("off");
    expect(await mode(B)).toBe("shadow");
  });

  it("3.c the admin mode changing does not alter the personal switch", async () => {
    const read = reader(rows);
    for (const admin of ["off", "on"] as const) {
      await withFrontDoorSwitch(async () => admin, read)(A);
      expect(await read(A)).toEqual({ disabled: true });
    }
  });

  it("does not read the switch when the admin has the gate off", async () => {
    const readSwitch = vi.fn(async () => ({ disabled: false }));
    expect(await withFrontDoorSwitch(async () => "off", readSwitch)(A)).toBe("off");
    expect(readSwitch).not.toHaveBeenCalled();
  });

  it("3.e a failed read counts as switched off", async () => {
    expect(await reader(rows, true)(B)).toEqual({ disabled: true });
  });

  it("a missing row leaves the front door available", async () => {
    expect(await reader({})(B)).toEqual({ disabled: false });
  });
});
