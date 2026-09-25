/**
 * #2687 — the instance owner connects Codex once and every user runs with that connection, in
 * their own home, as their own account. Codex rewrites its login file when it refreshes, so a
 * user's copy is re-seeded from the shared login on every launch, and a copy Codex refreshed more
 * recently for the same account becomes the shared login. A different account never replaces it.
 */
import { generateKeyPairSync, sign, type JsonWebKeyInput, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  instanceCodexAuthPath,
  planCodexLoginSync,
  promoteCodexLogin,
  publishNewestCodexLogin,
  syncCodexLoginIntoHome,
  type CodexHomeAccess
} from "../../packages/cli-runner/src/codex-shared-login.js";
import { createCodexTokenVerifier } from "../../packages/cli-runner/src/codex-token-verify.js";
import { preparePerUserStructuredLaunch } from "../../packages/cli-runner/src/per-user-structured.js";

const openAi = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const NOW = Date.parse("2026-09-25T00:00:00Z");
const verify = createCodexTokenVerifier({
  fetchKeys: async () => [
    { ...(openAi.publicKey.export({ format: "jwk" }) as JsonWebKeyInput["key"]), kid: "k1" }
  ],
  now: () => NOW
});

function jwt(claims: Record<string, unknown>, key: KeyObject = openAi.privateKey): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = `${part({ alg: "RS256", kid: "k1" })}.${part({ iss: "https://auth.openai.com", ...claims })}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), key).toString("base64url")}`;
}

/** A login file whose access token names `account`, issued at `issuedAt`. */
function login(account: string, token: string, issuedAt: string, key?: KeyObject): string {
  const iat = Math.floor(Date.parse(issuedAt) / 1000);
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id",
      access_token: jwt(
        {
          jti: token,
          iat,
          "https://api.openai.com/auth": { chatgpt_account_id: account }
        },
        key
      ),
      refresh_token: `refresh-${token}`,
      account_id: account
    },
    last_refresh: issuedAt
  });
}

const OLD = "2026-09-18T14:31:26Z";
const NEW = "2026-09-22T20:25:18Z";
const FUTURE = "2030-01-01T00:00:00Z";

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

  it("keeps a copy Codex refreshed more recently for the same account", () => {
    const refreshed = login("acct-owner", "refreshed-token", NEW);
    expect(planCodexLoginSync(owner, refreshed)).toEqual({ action: "keep" });
  });

  it("never lets a different account replace the shared login", () => {
    const other = login("acct-other", "other-token", NEW);
    expect(planCodexLoginSync(owner, other)).toEqual({ action: "seed", raw: owner });
  });

  it("never promotes another account's tokens relabelled as the shared account", () => {
    // The file claims the owner's account and a far-future refresh, but its token says otherwise.
    const forged = JSON.parse(login("acct-attacker", "attacker-token", FUTURE)) as {
      tokens: { account_id: string };
    };
    forged.tokens.account_id = "acct-owner";
    expect(planCodexLoginSync(owner, JSON.stringify(forged))).toEqual({
      action: "seed",
      raw: owner
    });
  });

  it("judges freshness by the token's issue time, not the file's editable refresh time", () => {
    const relabelled = JSON.parse(login("acct-owner", "older-token", "2026-09-01T00:00:00Z")) as {
      last_refresh: string;
    };
    relabelled.last_refresh = FUTURE;
    expect(planCodexLoginSync(owner, JSON.stringify(relabelled))).toEqual({
      action: "seed",
      raw: owner
    });
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
    expect(await syncCodexLoginIntoHome(homeBase, user, [], verify)).toBe("seeded");
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
    expect(await syncCodexLoginIntoHome(homeBase, access, [], verify)).toBe("promoted");
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(refreshed);
    expect(statSync(instanceCodexAuthPath(homeBase)).mode & 0o777).toBe(0o600);
    expect(writes).toBe(0);

    // The next user now gets the refreshed login, not the one it replaced.
    const next = memoryHome(null);
    await syncCodexLoginIntoHome(homeBase, next, [], verify);
    expect(next.current).toBe(refreshed);
  });

  it("hands a user another user's newer refresh, so nobody starts from a retired token", async () => {
    const homeBase = tempHome();
    writeInstance(homeBase, login("acct-owner", "owner-token", OLD));
    const refreshed = login("acct-owner", "refreshed-token", NEW);
    const userA = memoryHome(refreshed);
    const userB = memoryHome(null);
    const unreadable: CodexHomeAccess = {
      read: async () => {
        throw new Error("home not ready");
      },
      write: async () => undefined
    };
    expect(await syncCodexLoginIntoHome(homeBase, userB, [unreadable, userA], verify)).toBe(
      "seeded"
    );
    expect(userB.current).toBe(refreshed);
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(refreshed);
  });

  it("ignores another user's copy of a different account", async () => {
    const homeBase = tempHome();
    const owner = login("acct-owner", "owner-token", OLD);
    writeInstance(homeBase, owner);
    const other = memoryHome(login("acct-other", "other-token", NEW));
    const user = memoryHome(null);
    await syncCodexLoginIntoHome(homeBase, user, [other], verify);
    expect(user.current).toBe(owner);
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(owner);
  });

  it("never promotes a copy OpenAI did not sign, however new it claims to be", async () => {
    const homeBase = tempHome();
    const owner = login("acct-owner", "owner-token", OLD);
    writeInstance(homeBase, owner);
    const forged = memoryHome(login("acct-owner", "forged-token", NEW, attacker.privateKey));
    const user = memoryHome(null);
    expect(await syncCodexLoginIntoHome(homeBase, user, [forged], verify)).toBe("seeded");
    expect(user.current).toBe(owner);
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(owner);
  });

  it("never promotes a copy issued in the future", async () => {
    const homeBase = tempHome();
    const owner = login("acct-owner", "owner-token", OLD);
    writeInstance(homeBase, owner);
    const ahead = memoryHome(login("acct-owner", "ahead-token", FUTURE));
    const user = memoryHome(null);
    await syncCodexLoginIntoHome(homeBase, user, [ahead], verify);
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(owner);
    expect(user.current).toBe(owner);
  });

  it("falls back to the newest signed copy when a newer one is forged", async () => {
    const homeBase = tempHome();
    writeInstance(homeBase, login("acct-owner", "owner-token", OLD));
    const signed = login("acct-owner", "signed-token", "2026-09-20T00:00:00Z");
    const homes = [
      memoryHome(login("acct-owner", "forged-token", NEW, attacker.privateKey)),
      memoryHome(signed)
    ];
    expect(await publishNewestCodexLogin(homeBase, homes, verify)).toBe(true);
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(signed);
  });

  it("reads other users' copies a few at a time", async () => {
    const homeBase = tempHome();
    writeInstance(homeBase, login("acct-owner", "owner-token", OLD));
    let inFlight = 0;
    let most = 0;
    const slow: CodexHomeAccess = {
      read: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return null;
      },
      write: async () => undefined
    };
    await syncCodexLoginIntoHome(homeBase, memoryHome(null), Array(20).fill(slow), verify);
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(4);
  });

  it("reports none when nobody has connected Codex", async () => {
    const homeBase = tempHome();
    const user = memoryHome(null);
    expect(await syncCodexLoginIntoHome(homeBase, user, [], verify)).toBe("none");
    expect(user.current).toBeNull();
  });
});

describe("publishNewestCodexLogin", () => {
  it("carries the newest refresh any user holds back to the shared login", async () => {
    const homeBase = tempHome();
    writeInstance(homeBase, login("acct-owner", "owner-token", OLD));
    const newest = login("acct-owner", "newest-token", NEW);
    const homes = [
      memoryHome(login("acct-owner", "middle-token", "2026-09-20T00:00:00Z")),
      memoryHome(newest)
    ];
    expect(await publishNewestCodexLogin(homeBase, homes, verify)).toBe(true);
    expect(readFileSync(instanceCodexAuthPath(homeBase), "utf8")).toBe(newest);
    expect(await publishNewestCodexLogin(homeBase, homes, verify)).toBe(false);
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

describe("createCodexTokenVerifier", () => {
  const token = jwt({ iat: Math.floor(Date.parse(OLD) / 1000) });

  it("accepts a token OpenAI signed", async () => {
    expect(await verify(token)).toBe(true);
  });

  it.each([
    ["an extra segment", `${token}.garbage`],
    ["a stray character in the signature", `${token}!`],
    ["padding on the signature", `${token}=`],
    ["an empty segment", token.replace(/\.[^.]+\./, "..")]
  ])("rejects a signed token with %s", async (_label, altered) => {
    expect(await verify(altered)).toBe(false);
  });
});
