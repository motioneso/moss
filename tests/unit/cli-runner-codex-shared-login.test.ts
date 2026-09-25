/**
 * #2687 — the instance owner connects Codex once and every user runs with that connection, in
 * their own home, as their own account. Codex rewrites its login file when it refreshes, so a
 * user's copy is re-seeded from the shared login on every launch, and a copy Codex refreshed more
 * recently for the same account becomes the shared login. A different account never replaces it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  instanceCodexAuthPath,
  planCodexLoginSync,
  promoteCodexLogin,
  syncCodexLoginIntoHome,
  type CodexHomeAccess
} from "../../packages/cli-runner/src/codex-shared-login.js";
import { preparePerUserStructuredLaunch } from "../../packages/cli-runner/src/per-user-structured.js";

function login(account: string, token: string, lastRefresh: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id",
      access_token: token,
      refresh_token: `refresh-${token}`,
      account_id: account
    },
    last_refresh: lastRefresh
  });
}

const OLD = "2026-09-18T14:31:26.650657596Z";
const NEW = "2026-09-22T20:25:18.802308327Z";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-shared-login-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeInstance(homeBase: string, raw: string): void {
  mkdirSync(join(homeBase, ".codex"), { recursive: true });
  writeFileSync(instanceCodexAuthPath(homeBase), raw, { mode: 0o600 });
}

function memoryHome(initial: string | null): CodexHomeAccess & { current: string | null } {
  const home = {
    current: initial,
    read: async () => home.current,
    write: async (raw: string) => {
      home.current = raw;
    }
  };
  return home;
}

describe("planCodexLoginSync", () => {
  const owner = login("acct-owner", "owner-token", OLD);

  it("seeds a user with no login from the shared login", () => {
    expect(planCodexLoginSync(owner, null)).toEqual({ action: "seed", raw: owner });
  });

  it("replaces a user's stale copy of the same account", () => {
    const stale = login("acct-owner", "old-token", "2026-09-01T00:00:00Z");
    expect(planCodexLoginSync(owner, stale)).toEqual({ action: "seed", raw: owner });
  });

  it("promotes a copy Codex refreshed more recently for the same account", () => {
    const refreshed = login("acct-owner", "refreshed-token", NEW);
    expect(planCodexLoginSync(owner, refreshed)).toEqual({ action: "promote", raw: refreshed });
  });

  it("never lets a different account replace the shared login", () => {
    const other = login("acct-other", "other-token", NEW);
    expect(planCodexLoginSync(owner, other)).toEqual({ action: "seed", raw: owner });
  });

  it("leaves a user's own login alone while no shared login exists", () => {
    const own = login("acct-own", "own-token", OLD);
    expect(planCodexLoginSync(null, own)).toEqual({ action: "keep" });
    expect(planCodexLoginSync(null, null)).toEqual({ action: "none" });
  });

  it("keeps a copy that already matches", () => {
    expect(planCodexLoginSync(owner, owner)).toEqual({ action: "keep" });
  });

  it("treats an unusable file as no login", () => {
    expect(planCodexLoginSync("{broken", "null")).toEqual({ action: "none" });
    expect(planCodexLoginSync(owner, "{broken")).toEqual({ action: "seed", raw: owner });
  });
});

describe("syncCodexLoginIntoHome", () => {
  it("gives a user who never signed in the owner's login, leaving the owner's file as it was", async () => {
    const homeBase = tempHome();
    const owner = login("acct-owner", "owner-token", OLD);
    writeInstance(homeBase, owner);
    const user = memoryHome(null);
    expect(await syncCodexLoginIntoHome(homeBase, user)).toBe("seeded");
    expect(user.current).toBe(owner);
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(owner);
  });

  it("carries a refreshed copy back to the shared login, 0600, without writing the user's copy", async () => {
    const homeBase = tempHome();
    writeInstance(homeBase, login("acct-owner", "owner-token", OLD));
    const refreshed = login("acct-owner", "refreshed-token", NEW);
    const user = memoryHome(refreshed);
    let writes = 0;
    const access: CodexHomeAccess = {
      read: user.read,
      write: async (raw) => {
        writes += 1;
        await user.write(raw);
      }
    };
    expect(await syncCodexLoginIntoHome(homeBase, access)).toBe("promoted");
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(refreshed);
    expect(statSync(instanceCodexAuthPath(homeBase)).mode & 0o777).toBe(0o600);
    expect(writes).toBe(0);

    // The next user now gets the refreshed login, not the one it replaced.
    const next = memoryHome(null);
    await syncCodexLoginIntoHome(homeBase, next);
    expect(next.current).toBe(refreshed);
  });

  it("reports none when nobody has connected Codex", async () => {
    const homeBase = tempHome();
    const user = memoryHome(null);
    expect(await syncCodexLoginIntoHome(homeBase, user)).toBe("none");
    expect(user.current).toBeNull();
  });
});

describe("promoteCodexLogin", () => {
  it("makes a completed sign-in the shared login, whatever the account", async () => {
    const homeBase = tempHome();
    writeInstance(homeBase, login("acct-owner", "owner-token", NEW));
    const fresh = login("acct-new", "new-token", OLD);
    await promoteCodexLogin(homeBase, fresh);
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(fresh);
    expect(statSync(instanceCodexAuthPath(homeBase)).mode & 0o777).toBe(0o600);
  });

  it("refuses an unusable file without echoing it", async () => {
    const homeBase = tempHome();
    const err = await promoteCodexLogin(homeBase, '{"secret-ish":').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("secret-ish");
  });
});

describe("structured Codex launch", () => {
  it("seeds the owner's Codex login into a second user's home before a background call", async () => {
    const homeBase = tempHome();
    const neutralBase = tempHome();
    const owner = login("acct-owner", "owner-token", OLD);
    writeInstance(homeBase, owner);
    const agentHome = join(homeBase, "agents", "user-b");
    const user = memoryHome(null);
    const seenHomes: string[] = [];
    await preparePerUserStructuredLaunch(
      {
        homeBase,
        neutralBase,
        applyOwnership: async () => undefined,
        prepareOwnerHome: async () => agentHome,
        codexHomeAccess: (home) => {
          seenHomes.push(home);
          return user;
        }
      },
      "structured-key",
      { provider: "openai-compatible", userId: "user-b", needsStructuredOutput: true }
    );
    expect(seenHomes).toEqual([agentHome]);
    expect(user.current).toBe(owner);
  });

  it("does not touch Codex logins for other providers", async () => {
    const homeBase = tempHome();
    const neutralBase = tempHome();
    writeInstance(homeBase, login("acct-owner", "owner-token", OLD));
    let asked = false;
    await preparePerUserStructuredLaunch(
      {
        homeBase,
        neutralBase,
        applyOwnership: async () => undefined,
        prepareOwnerHome: async () => join(homeBase, "agents", "user-b"),
        codexHomeAccess: () => {
          asked = true;
          return memoryHome(null);
        }
      },
      "structured-key-2",
      { provider: "anthropic", userId: "user-b", needsStructuredOutput: true }
    );
    expect(asked).toBe(false);
  });
});
