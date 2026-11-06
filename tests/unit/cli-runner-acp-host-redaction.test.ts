import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AcpHost } from "../../packages/cli-runner/src/acp-host.js";

const LOGIN_TOKEN = "tok_cli-login-3557";
const API_KEY = "localproxy3557neverlog";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: (): void => undefined };
  kill(): boolean {
    return true;
  }
}

async function withHost(
  run: (host: AcpHost, child: FakeChild, dir: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acp-redact-"));
  try {
    const homeBase = join(dir, "homes");
    mkdirSync(homeBase, { recursive: true });
    const child = new FakeChild();
    const host = new AcpHost({
      neutralBase: dir,
      homeBase,
      perUserUid: true,
      allocateUidSlot: () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
      resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
      readTokenFile: async () => LOGIN_TOKEN,
      spawnChild: () => child as never,
      runAgentHomePrepare: async (request) => {
        for (const path of request.dirs) mkdirSync(path, { recursive: true, mode: 0o700 });
      },
      purgePrivateFolder: async (cwd) => {
        await rm(cwd, { recursive: true, force: true });
      }
    });
    await run(host, child, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AcpHost output masking (#3557)", () => {
  it("never delivers the login token an agent prints", async () => {
    await withHost(async (host, child) => {
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat");
      child.stdout.emit(
        "data",
        Buffer.from(
          `{"text":"CLAUDE_CODE_OAUTH_TOKEN=${LOGIN_TOKEN}"}\n{"text":"quote \\"${LOGIN_TOKEN}\\""}\n`
        )
      );
      const read = host.read("chat:user-1:a", 0);
      expect(read.lines).toHaveLength(2);
      expect(read.lines.join("\n")).not.toContain(LOGIN_TOKEN);
      expect(read.lines[0]).toContain("[redacted]");
    });
  });

  it("never delivers the API key an agent prints", async () => {
    await withHost(async (host, child) => {
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat", false, undefined, {
        baseUrl: null,
        apiKey: API_KEY,
        model: "m"
      });
      child.stdout.emit("data", Buffer.from(`{"text":"key is ${API_KEY}"}\n`));
      expect(host.read("chat:user-1:a", 0).lines.join("\n")).not.toContain(API_KEY);
    });
  });
});
