/**
 * #2674 — per-user UID slots belong to people, never to sessions.
 *
 * Background structured calls launch under a fresh `structured-<uuid>` key each time. Keying the
 * slot by that key took a new slot per call and never freed it, so the 1000-slot table filled and
 * every worker AI call failed admission. These tests pin the slot to the launch's owning user and
 * cover the startup prune that recovers installs already at the cap.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import { allocateUidSlot, pruneUidSlots } from "../../packages/cli-runner/src/uid-allocator.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeIo(): TmuxIo {
  return {
    run: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) as unknown as TmuxIo["run"],
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined)
  };
}

function okIo(): TmuxIo {
  return {
    ...fakeIo(),
    run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) as unknown as TmuxIo["run"]
  };
}

function makeHost(homeBase: string, neutralBase: string, io: TmuxIo = fakeIo()): CliChatEngineHost {
  return new CliChatEngineHost({
    io,
    neutralBase,
    homeBase,
    perUserUid: true,
    createSlotIo: () => fakeIo(),
    // A non-root test cannot hand folders to another UID or remove them as that UID.
    applyOwnership: async () => undefined,
    purgeOwnedPath: async () => undefined,
    prepareOwnerHome: async (base, owner) => {
      mkdirSync(join(base, "agents", owner), { recursive: true });
      return join(base, "agents", owner);
    },
    singleUser: false,
    cliPresent: async () => true,
    launchTimeoutMs: 2_000
  });
}

function readSlots(homeBase: string): Record<string, number> {
  return JSON.parse(readFileSync(join(homeBase, "uid-slots.json"), "utf8")) as Record<
    string,
    number
  >;
}

describe("#2674 structured launches share their owner's UID slot", () => {
  it("leaves exactly one slot after many structured calls for one user", async () => {
    const homeBase = tempDir("uid-2674-home-");
    const neutralBase = tempDir("uid-2674-neutral-");
    const host = makeHost(homeBase, neutralBase);

    for (let i = 0; i < 5; i += 1) {
      const key = `structured-${randomUUID()}`;
      await host.launch(key, {
        provider: "anthropic",
        personaText: "You produce structured JSON only.",
        executionMode: "non_interactive",
        needsStructuredOutput: true,
        userId: USER_A
      });
      await host.kill(key);
    }

    expect(readSlots(homeBase)).toEqual({ [USER_A]: 1 });
  });

  it("runs a structured call as the same UID the user's chat agent gets", async () => {
    const homeBase = tempDir("uid-2674-home-");
    const neutralBase = tempDir("uid-2674-neutral-");
    // Chat (the agent spawn and the login flow) allocates by the raw user id.
    const chatSlot = allocateUidSlot(homeBase, USER_B);
    const host = makeHost(homeBase, neutralBase);

    const key = `structured-${randomUUID()}`;
    await host.launch(key, {
      provider: "anthropic",
      personaText: "You produce structured JSON only.",
      executionMode: "non_interactive",
      needsStructuredOutput: true,
      userId: USER_B
    });
    await host.kill(key);

    expect(readSlots(homeBase)).toEqual({ [USER_B]: chatSlot.uid - 100_000 });
  });

  it("refuses a structured launch that names no owner instead of keying by session", async () => {
    const homeBase = tempDir("uid-2674-home-");
    const neutralBase = tempDir("uid-2674-neutral-");
    const host = makeHost(homeBase, neutralBase);

    await expect(
      host.launch(`structured-${randomUUID()}`, {
        provider: "anthropic",
        personaText: "You produce structured JSON only.",
        executionMode: "non_interactive",
        needsStructuredOutput: true
      })
    ).rejects.toThrow(/owning user/);
    expect(existsSync(join(homeBase, "uid-slots.json"))).toBe(false);
  });
});

describe("#2674 startup prune of per-call slot entries", () => {
  it("keeps user entries at their numbers and drops structured and settings-check ones", () => {
    const homeBase = tempDir("uid-2674-home-");
    const slots: Record<string, number> = {};
    let n = 1;
    for (let i = 0; i < 997; i += 1) slots[`structured-${randomUUID()}`] = n++;
    slots[USER_A] = n++;
    slots[`settings-check-${randomUUID().replaceAll("-", "")}`] = n++;
    slots[USER_B] = n;
    writeFileSync(join(homeBase, "uid-slots.json"), JSON.stringify(slots));

    expect(pruneUidSlots(homeBase)).toBe(998);

    expect(readSlots(homeBase)).toEqual({ [USER_A]: 998, [USER_B]: 1000 });
  });

  it("lets a new user allocate again once a full table is pruned", () => {
    const homeBase = tempDir("uid-2674-home-");
    const slots: Record<string, number> = {};
    for (let i = 1; i <= 999; i += 1) slots[`structured-${randomUUID()}`] = i;
    slots[USER_A] = 1000;
    writeFileSync(join(homeBase, "uid-slots.json"), JSON.stringify(slots));
    expect(() => allocateUidSlot(homeBase, USER_B)).toThrow(/UID slot overflow/);

    pruneUidSlots(homeBase);

    expect(allocateUidSlot(homeBase, USER_A).uid).toBe(101_000);
    expect(allocateUidSlot(homeBase, USER_B).uid).toBe(100_001);
  });

  it("is a no-op when there is no slot file", () => {
    const homeBase = tempDir("uid-2674-home-");
    expect(pruneUidSlots(homeBase)).toBe(0);
    expect(existsSync(join(homeBase, "uid-slots.json"))).toBe(false);
  });
});

describe("#2674 the runner prunes per-call slots during its startup sweep", () => {
  it("prunes after the neutral clean-out, keeping user slots", async () => {
    const homeBase = tempDir("uid-2674-home-");
    const neutralBase = tempDir("uid-2674-neutral-");
    mkdirSync(join(neutralBase, "leftover"), { recursive: true });
    writeFileSync(
      join(homeBase, "uid-slots.json"),
      JSON.stringify({ [`structured-${randomUUID()}`]: 1, [USER_A]: 2 })
    );
    const host = makeHost(homeBase, neutralBase, okIo());

    await host.startupSweep();

    expect(readSlots(homeBase)).toEqual({ [USER_A]: 2 });
  });

  it("leaves per-call slots alone when the neutral clean-out fails", async () => {
    const homeBase = tempDir("uid-2674-home-");
    const neutralBase = tempDir("uid-2674-neutral-");
    const slots = { [`structured-${randomUUID()}`]: 1, [USER_A]: 2 };
    writeFileSync(join(homeBase, "uid-slots.json"), JSON.stringify(slots));
    const host = makeHost(homeBase, neutralBase, fakeIo());

    await host.startupSweep();

    expect(readSlots(homeBase)).toEqual(slots);
  });
});
