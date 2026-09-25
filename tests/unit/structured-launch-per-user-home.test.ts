/**
 * #2674 — with per-user UIDs on, a structured call runs as its owner, in the owner's own home.
 *
 * The shared auth home's token file is owned by the runner and mode 0600, so a CLI running as the
 * owner's UID could never read it through `$(cat ...)`. These tests pin the launch to the owner's
 * home (the one ACP chat uses), the owner's slot identity, and a login token handed over in env.
 */
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as NodeChildProcess from "node:child_process";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";

const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];

const cliChildren: EventEmitter[] = [];

function fakeChild(): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stream = (): EventEmitter & Record<string, unknown> => {
    const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
    s.setEncoding = () => {};
    s.resume = () => {};
    return s;
  };
  child.stdout = stream();
  child.stderr = stream();
  child.stdin = { destroyed: false, write: () => {}, end: () => {}, on: () => {} };
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  child.kill = () => true;
  return child;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command, args, options });
      const child = fakeChild();
      if (command === "setpriv" && args.includes("-e")) {
        // A helper run as the owner succeeds; a stop helper also ends the CLI child it signalled.
        const stopping = Boolean((options.env as Record<string, string>)?.STRUCTURED_STOP_PID);
        setImmediate(() => {
          child.emit("exit", 0);
          child.emit("close", 0);
          if (stopping) cliChildren.at(-1)?.emit("exit", null);
        });
      } else if (args.some((a) => a.includes("claude"))) {
        cliChildren.push(child);
      }
      return child;
    }
  };
});

const { CliChatEngineHost } = await import("../../packages/cli-runner/src/engine-host.js");
const { providerTokenPath } = await import("../../packages/cli-runner/src/provider-token-store.js");

const USER = "33333333-3333-4333-8333-333333333333";
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } };

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  spawnCalls.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeIo(): TmuxIo {
  return {
    run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) as unknown as TmuxIo["run"],
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined)
  };
}

function setup(perUserUid = true) {
  const homeBase = tempDir("struct-home-");
  const neutralBase = tempDir("struct-neutral-");
  const tokenFile = providerTokenPath(homeBase, "anthropic");
  mkdirSync(join(homeBase, ".jarvis", "cli-tokens"), { recursive: true });
  writeFileSync(tokenFile, "sk-ant-oat01-test-token\n", { mode: 0o600 });
  const handedOver: Array<{ uid: number; gid: number }> = [];
  const purged: Array<{ path: string; identity: unknown }> = [];
  const host = new CliChatEngineHost({
    io: fakeIo(),
    neutralBase,
    homeBase,
    perUserUid,
    createSlotIo: () => fakeIo(),
    applyOwnership: async (_handle, uid, gid) => {
      handedOver.push({ uid, gid });
    },
    // Empties the folder as the owner would; the owner cannot unlink it from the runner's parent.
    purgeOwnedPath: async (path, identity) => {
      purged.push({ path, identity });
      if (!existsSync(path)) return;
      for (const name of readdirSync(path)) rmSync(join(path, name), { recursive: true });
    },
    singleUser: false,
    cliPresent: async () => true,
    launchTimeoutMs: 2_000
  });
  return { host, homeBase, neutralBase, handedOver, purged };
}

function cliSpawn() {
  const call = spawnCalls.find((c) => c.args.some((a) => a.includes("claude")));
  if (!call) throw new Error("the CLI was never spawned");
  return call;
}

describe("#2674 a structured call runs in its owner's home", () => {
  it("spawns the CLI as the owner's slot with the owner's home and the login in env", async () => {
    const { host, homeBase, neutralBase, handedOver } = setup();
    const key = "structured-11111111-aaaa-4aaa-8aaa-111111111111";

    await host.launch(key, {
      provider: "anthropic",
      personaText: "You produce structured JSON only.",
      executionMode: "non_interactive",
      needsStructuredOutput: true,
      schema: SCHEMA,
      userId: USER
    });

    const call = cliSpawn();
    const slots = JSON.parse(readFileSync(join(homeBase, "uid-slots.json"), "utf8"));
    const uid = 100_000 + (slots[USER] as number);
    expect(call.command).toBe("setpriv");
    expect(call.args).toContain(`--reuid=${uid}`);
    expect(call.options.cwd).toBeUndefined();
    const env = call.options.env as Record<string, string>;
    expect(env.HOME).toBe(join(homeBase, "agents", USER));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test-token");
    const script = call.args.at(-1) as string;
    expect(script).not.toContain("$(cat");
    expect(script).toContain(`cd '${join(neutralBase, key)}'`);

    // The persona is written before the folder goes to the owner, and every handover is theirs.
    expect(readFileSync(join(neutralBase, key, "persona.md"), "utf8")).toBe(
      "You produce structured JSON only."
    );
    expect(handedOver.length).toBeGreaterThan(0);
    expect(handedOver.every((h) => h.uid === uid)).toBe(true);
  });

  it("refuses a structured call with no owner before touching any home", async () => {
    const { host, homeBase } = setup();
    await expect(
      host.launch("structured-22222222-bbbb-4bbb-8bbb-222222222222", {
        provider: "anthropic",
        personaText: "",
        executionMode: "non_interactive",
        needsStructuredOutput: true,
        schema: SCHEMA
      })
    ).rejects.toThrow(/names no owning user/);
    expect(existsSync(join(homeBase, "agents"))).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it("stops the child as the owner and removes the working folder as the owner", async () => {
    const { host, homeBase, neutralBase, purged } = setup();
    const key = "structured-33333333-cccc-4ccc-8ccc-333333333333";
    await host.launch(key, {
      provider: "anthropic",
      personaText: "",
      executionMode: "non_interactive",
      needsStructuredOutput: true,
      schema: SCHEMA,
      userId: USER
    });
    const cli = cliSpawn();
    const cliChild = spawnCalls.indexOf(cli);
    await host.kill(key);

    const stop = spawnCalls.slice(cliChild + 1).find((c) => c.args.includes("-e"));
    expect(stop?.command).toBe("setpriv");
    expect((stop?.options.env as Record<string, string>).STRUCTURED_STOP_PID).toBe("4242");
    // The call's transcript in the owner's home goes first, then the working folder.
    const owner = expect.objectContaining({ uid: expect.any(Number) });
    expect(purged).toEqual([
      { path: expect.stringContaining(join(homeBase, "agents", USER, ".claude")), identity: owner },
      { path: join(neutralBase, key), identity: owner }
    ]);
    expect(existsSync(join(neutralBase, key))).toBe(false);
  });

  it("runs an ordinary one-shot call as the owner, prompt file included", async () => {
    const { host, homeBase, neutralBase } = setup();
    const key = "structured-55555555-eeee-4eee-8eee-555555555555";
    await host.launch(key, {
      provider: "anthropic",
      personaText: "You produce structured JSON only.",
      executionMode: "non_interactive",
      needsStructuredOutput: true,
      userId: USER
    });
    await Promise.race([
      host.submit(key, { attemptId: "attempt-1", text: "Say hello." }).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1_500))
    ]);

    const slots = JSON.parse(readFileSync(join(homeBase, "uid-slots.json"), "utf8"));
    const uid = 100_000 + (slots[USER] as number);
    const promptWrite = spawnCalls.find(
      (c) => (c.options.env as Record<string, string>)?.OWNER_IO_PATH !== undefined
    );
    expect(promptWrite?.command).toBe("setpriv");
    expect(promptWrite?.args).toContain(`--reuid=${uid}`);
    expect((promptWrite?.options.env as Record<string, string>).OWNER_IO_PATH).toBe(
      join(neutralBase, key, ".jarvis-claude-print-prompt.txt")
    );
    expect(promptWrite?.args.join(" ")).not.toContain("Say hello.");

    const call = cliSpawn();
    expect(call.command).toBe("setpriv");
    expect(call.args).toContain(`--reuid=${uid}`);
    expect(call.options.cwd).toBeUndefined();
    const env = call.options.env as Record<string, string>;
    expect(env.HOME).toBe(join(homeBase, "agents", USER));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test-token");
    await host.kill(key);
  });

  it("keeps the shared home when per-user UIDs are off", async () => {
    const { host, homeBase } = setup(false);
    await host.launch("structured-44444444-dddd-4ddd-8ddd-444444444444", {
      provider: "anthropic",
      personaText: "",
      executionMode: "non_interactive",
      needsStructuredOutput: true,
      schema: SCHEMA,
      userId: USER
    });
    const call = cliSpawn();
    expect(call.command).toBe("bash");
    expect((call.options.env as Record<string, string>).HOME).toBe(homeBase);
  });
});
