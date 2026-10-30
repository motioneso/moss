import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpHost, type AgentHomePrepareRequest } from "../../packages/cli-runner/src/acp-host.js";

// Not shaped like any known key, so only the per-key mask can hide it.
const KEY = "localproxy0003neverlog";
const MODEL = "org/model:tag@v2";
const CREDENTIAL = { baseUrl: "http://proxy.test/v1/", apiKey: KEY, model: MODEL };

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: (): void => undefined };

  kill(): boolean {
    return true;
  }
}

const selfSlot = (): { uid: number; gid: number } => ({
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0
});

function makeHost(dir: string) {
  const homeBase = join(dir, "homes");
  mkdirSync(homeBase, { recursive: true });
  const child = new FakeChild();
  const spawns: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const requests: AgentHomePrepareRequest[] = [];
  const host = new AcpHost({
    neutralBase: dir,
    homeBase,
    perUserUid: true,
    allocateUidSlot: selfSlot,
    resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
    readTokenFile: async () => "tok_cli-login",
    spawnChild: (opts) => {
      spawns.push({ args: opts.args, env: opts.env });
      return child as never;
    },
    runAgentHomePrepare: async (request) => {
      requests.push(request);
      for (const path of request.dirs) mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    purgePrivateFolder: async (cwd) => {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  return { host, child, spawns, requests, agentHome: join(homeBase, "agents", "user-1") };
}

async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acp-api-key-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AcpHost API-key launches", () => {
  it("gives the claude agent the row's address, key and model, and no login token", async () => {
    await inTempDir(async (dir) => {
      const { host, spawns } = makeHost(dir);
      await host.spawn(
        "chat:user-1:a",
        "proj",
        "anthropic",
        "user-1",
        "chat",
        false,
        undefined,
        CREDENTIAL
      );
      const env = spawns[0]!.env;
      expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy.test");
      expect(env.ANTHROPIC_API_KEY).toBe(KEY);
      expect(env.ANTHROPIC_MODEL).toBe(MODEL);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(JSON.stringify(spawns[0]!.args)).not.toContain(KEY);
    });
  });

  it("leaves the claude address unset when the row has none", async () => {
    await inTempDir(async (dir) => {
      const { host, spawns } = makeHost(dir);
      const credential = { ...CREDENTIAL, baseUrl: null };
      await host.spawn(
        "chat:user-1:a",
        "proj",
        "anthropic",
        "user-1",
        "chat",
        false,
        undefined,
        credential
      );
      expect(spawns[0]!.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(spawns[0]!.env.ANTHROPIC_API_KEY).toBe(KEY);
    });
  });

  it("keeps server-level key variables away from a CLI-login claude agent", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "server-level-value");
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://server-level.test");
    vi.stubEnv("ANTHROPIC_MODEL", "server-level-model");
    vi.stubEnv("MOSS_OPENCODE_API_KEY", "server-level-value");
    await inTempDir(async (dir) => {
      const { host, spawns } = makeHost(dir);
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat");
      const env = spawns[0]!.env;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_cli-login");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_MODEL).toBeUndefined();
      expect(env.MOSS_OPENCODE_API_KEY).toBeUndefined();
    });
  });

  it("writes its provider entry into the launch's own settings file, never the key", async () => {
    await inTempDir(async (dir) => {
      const { host, spawns, requests, agentHome } = makeHost(dir);
      await host.spawn(
        "chat:user-1:a",
        "proj",
        "opencode",
        "user-1",
        "chat",
        false,
        undefined,
        CREDENTIAL
      );
      // #3558: the settings a launch writes belong to that launch, not to the person.
      expect(spawns[0]!.env.XDG_CONFIG_HOME).toBeTruthy();
      expect(requests[0]!.opencodeProvider?.path).toBe(
        join(spawns[0]!.env.XDG_CONFIG_HOME!, "opencode", "opencode.json")
      );
      expect(requests[0]!.opencodeProvider?.path).not.toBe(
        join(agentHome, ".config", "opencode", "opencode.json")
      );
      expect(requests[0]!.opencodeProvider?.entry).toEqual({
        baseUrl: "http://proxy.test/v1",
        model: MODEL,
        apiKeyEnv: "MOSS_OPENCODE_API_KEY"
      });
      // The deny settings for chat land in the same per-launch file.
      expect(requests[0]!.denyFile?.path).toBe(requests[0]!.opencodeProvider?.path);
      expect(JSON.stringify(requests)).not.toContain(KEY);
      expect(spawns[0]!.env.MOSS_OPENCODE_API_KEY).toBe(KEY);
      expect(JSON.stringify(spawns[0]!.args)).not.toContain(KEY);
    });
  });

  it("gives each OpenCode launch its own settings, so none can touch another's provider (#3558)", async () => {
    await inTempDir(async (dir) => {
      const { host, spawns, requests } = makeHost(dir);
      await host.spawn(
        "chat:user-1:a",
        "proj",
        "opencode",
        "user-1",
        "chat",
        false,
        undefined,
        CREDENTIAL
      );
      await host.spawn("chat:user-1:b", "proj", "opencode", "user-1", "chat");
      await host.spawn("workshop:user-1:proj", "proj", "opencode", "user-1", "workshop");

      const apiKeyConfig = requests[0]!.opencodeProvider!.path;
      const configDirs = spawns.map((spawn) => spawn.env.XDG_CONFIG_HOME);
      expect(new Set(configDirs).size).toBe(3);
      for (const request of requests.slice(1)) {
        // Nothing a later launch writes names the file the API-key launch depends on.
        expect(request.opencodeProvider?.path).not.toBe(apiKeyConfig);
        expect(request.denyFile?.path).not.toBe(apiKeyConfig);
      }
      // Whatever each launch does write is inside its own settings directory.
      requests.forEach((request, index) => {
        if (!request.opencodeProvider) return;
        expect(request.opencodeProvider.path).toBe(
          join(spawns[index]!.env.XDG_CONFIG_HOME!, "opencode", "opencode.json")
        );
      });
      expect(spawns[1]!.env.MOSS_OPENCODE_API_KEY).toBeUndefined();
      expect(spawns[2]!.env.MOSS_OPENCODE_API_KEY).toBeUndefined();
    });
  });

  it("masks the key in the adapter's logged error output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await inTempDir(async (dir) => {
      const { host, child } = makeHost(dir);
      await host.spawn(
        "chat:user-1:a",
        "proj",
        "anthropic",
        "user-1",
        "chat",
        false,
        undefined,
        CREDENTIAL
      );
      child.stderr.emit("data", Buffer.from(`upstream said ${KEY} is not valid\n`));
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("[redacted]");
      expect(logged).not.toContain(KEY);
    });
  });

  it("masks a key split across stderr chunks, through the final flush", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await inTempDir(async (dir) => {
      const { host, child } = makeHost(dir);
      await host.spawn(
        "chat:user-1:a",
        "proj",
        "anthropic",
        "user-1",
        "chat",
        false,
        undefined,
        CREDENTIAL
      );
      const half = Math.floor(KEY.length / 2);
      child.stderr.emit("data", Buffer.from(`upstream said ${KEY.slice(0, half)}`));
      const rest = `${KEY.slice(half)} is not valid\nfatal: ${KEY.slice(0, 6)}`;
      child.stderr.emit("data", Buffer.from(rest));
      child.stderr.emit("end");
      // The redactor releases text as soon as it cannot start the key, so one stderr line can
      // span several log calls. Rejoin the logged stderr text to read the stream as written.
      const logged = warn.mock.calls
        .map((call) => String(call[0]).replace(/^\[acp-host\] \S+ stderr: /, ""))
        .join("");
      expect(logged).toContain("upstream said [redacted] is not valid");
      expect(logged).toContain("fatal: [redacted]");
      expect(logged).not.toContain(KEY.slice(0, 6));
      expect(logged).not.toContain(KEY.slice(half));
    });
  });
});
