import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const verification = vi.hoisted(() => ({
  mode: "unavailable" as "unavailable" | "throws" | "available"
}));
vi.mock("../../packages/cli-runner/src/codex-token-verify.js", async (original) => ({
  ...(await original<object>()),
  openAiCodexTokenVerifier: () => async () => {
    if (verification.mode === "throws") throw new Error("keys unavailable");
    return verification.mode === "available";
  }
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<object>()),
  spawn: () => {
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

const { promoteCodexLogin } = await import("../../packages/cli-runner/src/codex-shared-login.js");
const { preparePerUserStructuredLaunch } =
  await import("../../packages/cli-runner/src/per-user-structured.js");
const roots: string[] = [];
afterEach(() => {
  verification.mode = "unavailable";
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function login(issuedAt: number, account = "test"): string {
  const claims = Buffer.from(
    JSON.stringify({
      iat: issuedAt,
      "https://api.openai.com/auth": { chatgpt_account_id: account }
    })
  ).toString("base64url");
  return JSON.stringify({
    tokens: {
      account_id: account,
      access_token: `header.${claims}.signature`,
      refresh_token: `synthetic-refresh-${issuedAt}`
    }
  });
}

const { readRetainedCodexLogins } =
  await import("../../packages/cli-runner/src/codex-login-recovery.js");

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "codex-refresh-recovery-"));
  roots.push(root);
  mkdirSync(join(root, "calls"));
  const ownerHome = join(root, "agents", "owner");
  const old = login(1);
  const homes = new Map<string, string>([[ownerHome, old]]);
  const failures = { ownerWrite: false, ownerRead: false };
  await promoteCodexLogin(root, old);
  const deps = {
    homeBase: root,
    neutralBase: join(root, "calls"),
    applyOwnership: async () => undefined,
    prepareOwnerHome: async () => ownerHome,
    codexHomeAccess: (home: string) => ({
      read: async () => {
        if (home === ownerHome && failures.ownerRead) throw new Error("owner read unavailable");
        return homes.get(home) ?? null;
      },
      write: async (raw: string) => {
        if (home === ownerHome && failures.ownerWrite) throw new Error("owner write unavailable");
        homes.set(home, raw);
      }
    }),
    purgeOwnedPath: async (path: string) => {
      for (const home of homes.keys()) if (home.startsWith(`${path}/`)) homes.delete(home);
      rmSync(path, { recursive: true, force: true });
    }
  };
  const params = {
    provider: "openai-compatible",
    userId: "owner",
    needsStructuredOutput: true,
    constrainedStructured: true
  };
  const launch = (key: string) => preparePerUserStructuredLaunch(deps, key, params);
  return { root, ownerHome, homes, failures, launch, old };
}

it.each(["unavailable", "throws"] as const)(
  "recovers a refreshed login on the next launch when verification %s",
  async (mode) => {
    const { root, homes, ownerHome, launch } = await setup();
    verification.mode = mode;
    const first = await launch("first");
    homes.set(first.agentHome, login(2));
    await first.childIdentity.release?.();
    expect(homes.has(first.agentHome)).toBe(false);
    expect(existsSync(first.neutralDir)).toBe(false);
    expect(homes.get(ownerHome)).toBe(login(2));
    expect(await readRetainedCodexLogins(root)).toEqual([]);

    verification.mode = "available";
    const second = await launch("second");
    expect(homes.get(second.agentHome)).toBe(login(2));
    await second.childIdentity.release?.();
  }
);

it.each(["ownerWrite", "ownerRead"] as const)(
  "retains auth only after %s fails, removes call content, then recovers on next launch",
  async (failure) => {
    const { root, homes, ownerHome, launch, failures, old } = await setup();
    const first = await launch("first");
    homes.set(first.agentHome, login(2));
    failures[failure] = true;
    await first.childIdentity.release?.();
    expect(existsSync(first.neutralDir)).toBe(false);
    expect(homes.has(first.agentHome)).toBe(false);
    expect(homes.get(ownerHome)).toBe(old);
    expect((await readRetainedCodexLogins(root)).map((entry) => entry.raw)).toEqual([login(2)]);
    const dir = join(root, ".codex", "refresh-recovery");
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    failures[failure] = false;
    verification.mode = "available";
    const second = await launch("second");
    expect(homes.get(second.agentHome)).toBe(login(2));
    expect(await readRetainedCodexLogins(root)).toEqual([]);
    await second.childIdentity.release?.();
  }
);

it("retains refresh during shared-login I/O failure and recovers after it is repaired", async () => {
  const { root, homes, launch } = await setup();
  const first = await launch("first");
  homes.set(first.agentHome, login(2));
  const shared = join(root, ".codex", "auth.json");
  renameSync(shared, `${shared}.saved`);
  mkdirSync(shared);
  await first.childIdentity.release?.();
  expect(existsSync(first.neutralDir)).toBe(false);
  expect((await readRetainedCodexLogins(root)).map((entry) => entry.raw)).toEqual([login(2)]);
  rmSync(shared, { recursive: true });
  renameSync(`${shared}.saved`, shared);
  verification.mode = "available";
  const next = await launch("next");
  expect(homes.get(next.agentHome)).toBe(login(2));
  await next.childIdentity.release?.();
});

it("keeps the newest owner refresh when concurrent calls finish out of order", async () => {
  const { homes, ownerHome, launch } = await setup();
  const older = await launch("older");
  const newer = await launch("newer");
  homes.set(older.agentHome, login(2));
  homes.set(newer.agentHome, login(3));
  await Promise.all([newer.childIdentity.release?.(), older.childIdentity.release?.()]);
  expect(homes.get(ownerHome)).toBe(login(3));
  verification.mode = "available";
  const next = await launch("next");
  expect(homes.get(next.agentHome)).toBe(login(3));
  await next.childIdentity.release?.();
});

it("honors an administrator account change made during a call", async () => {
  const { root, homes, ownerHome, launch } = await setup();
  const first = await launch("first");
  homes.set(first.agentHome, login(2));
  await promoteCodexLogin(root, login(1, "replacement"));
  await first.childIdentity.release?.();
  expect(homes.get(ownerHome)).toBe(login(1, "replacement"));
  expect(await readRetainedCodexLogins(root)).toEqual([]);
});

it.each(["{invalid", login(2, "other-account")])(
  "does not preserve an invalid or different-account refresh",
  async (raw) => {
    const { root, homes, ownerHome, launch, old } = await setup();
    const first = await launch("first");
    homes.set(first.agentHome, raw);
    await first.childIdentity.release?.();
    expect(homes.get(ownerHome)).toBe(old);
    expect(existsSync(first.neutralDir)).toBe(false);
    expect(await readRetainedCodexLogins(root)).toEqual([]);
  }
);

it("refuses destructive cleanup when neither durable destination can be written, and supports retry", async () => {
  const { root, homes, launch, failures } = await setup();
  const first = await launch("first");
  homes.set(first.agentHome, login(2));
  failures.ownerWrite = true;
  const recovery = join(root, ".codex", "refresh-recovery");
  writeFileSync(recovery, "unavailable");
  await expect(first.childIdentity.release?.()).rejects.toThrow();
  expect(existsSync(first.neutralDir)).toBe(true);
  expect(homes.get(first.agentHome)).toBe(login(2));
  rmSync(recovery);
  await first.childIdentity.release?.();
  expect(existsSync(first.neutralDir)).toBe(false);
  expect((await readRetainedCodexLogins(root)).map((entry) => entry.raw)).toEqual([login(2)]);
});
