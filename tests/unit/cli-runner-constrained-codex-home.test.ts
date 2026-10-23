import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

// Shared-login signature/freshness rules have separate real-crypto coverage. Here keep that
// operation as a seam to assert which home is reconciled, and when cleanup removes it.
const { sync, commands } = vi.hoisted(() => ({
  sync: vi.fn(async () => "seeded"),
  commands: [] as { args: string[]; env: NodeJS.ProcessEnv }[]
}));
vi.mock("../../packages/cli-runner/src/codex-shared-login.js", async (original) => ({
  ...(await original<object>()),
  syncCodexLoginIntoHome: sync
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<object>()),
  spawn: (_command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    commands.push({ args, env: opts.env });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true
    });
    setImmediate(() => child.emit("close", 0));
    return child;
  }
}));
const { preparePerUserStructuredLaunch } =
  await import("../../packages/cli-runner/src/per-user-structured.js");
const roots: string[] = [];
afterEach(() => {
  sync.mockClear();
  commands.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("seeds a fresh constrained home and reconciles its refresh before removing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "constrained-codex-home-"));
  roots.push(root);
  mkdirSync(join(root, "calls"));
  const ownerHome = join(root, "agents", "owner");
  const ownerAccess = { read: async () => "owner-login", write: async () => undefined };
  const privateAccess = { read: async () => "refreshed-login", write: async () => undefined };
  const seen: string[] = [];
  const cleanupCalls: number[] = [];
  const purge = vi.fn(async (path: string) => {
    if (path === join(root, "calls", "constrained-call")) cleanupCalls.push(sync.mock.calls.length);
  });
  const launch = await preparePerUserStructuredLaunch(
    {
      homeBase: root,
      neutralBase: join(root, "calls"),
      applyOwnership: async () => undefined,
      prepareOwnerHome: async () => ownerHome,
      codexHomeAccess: (home) => {
        seen.push(home);
        return home === ownerHome ? ownerAccess : privateAccess;
      },
      purgeOwnedPath: purge
    },
    "constrained-call",
    {
      provider: "openai-compatible",
      userId: "owner",
      needsStructuredOutput: true,
      constrainedStructured: true
    }
  );
  const privateHome = join(launch.neutralDir, "constrained-home");
  expect(seen).toEqual([ownerHome, privateHome]);
  expect(launch.agentHome).toBe(privateHome);
  expect(sync).toHaveBeenNthCalledWith(2, root, privateAccess, [ownerAccess]);
  commands.length = 0;
  await launch.io.run("node", ["-e", "0"]);
  expect(commands[0]!.env.HOME).toBe(privateHome);
  expect(commands[0]!.env.CODEX_HOME).toBe(join(privateHome, ".codex"));
  await launch.childIdentity.release?.();
  expect(purge).toHaveBeenCalledWith(launch.neutralDir, expect.any(Object));
  expect(cleanupCalls).toEqual([3]);
  expect(sync).toHaveBeenLastCalledWith(root, ownerAccess, [privateAccess]);
});
