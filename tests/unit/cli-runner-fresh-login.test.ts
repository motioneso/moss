import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TmuxIo } from "@moss/ai";
import { LOGIN_ADAPTERS } from "../../packages/cli-runner/src/login-adapters.js";
import { LoginService } from "../../packages/cli-runner/src/login-service.js";
import { providerTokenPath } from "../../packages/cli-runner/src/provider-token-store.js";
import {
  publishFreshClaudeToken,
  scopedClaudeTokenPath,
  validateFreshClaudeToken
} from "../../packages/cli-runner/src/fresh-cli-login.js";

const scope = { actorUserId: "actor-a", providerConfigId: "config-a" };
const token = `sk-ant-oat01-${"synthetic".repeat(8)}`;
const homes: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture(
  validate: (home: string, token: string, signal: AbortSignal) => Promise<boolean> = async () =>
    true
) {
  const home = await mkdtemp(path.join(tmpdir(), "wf-"));
  homes.push(home);
  const sessions = new Set<string>();
  const submitted = new Set<string>();
  const run = vi.fn(async (_cmd: string, args: readonly string[]) => {
    const socket = args[1]!;
    const verb = args[2] === "-f" ? args[4] : args[2];
    if (verb === "new-session") sessions.add(socket);
    if (verb === "send-keys" && args.includes("Enter")) submitted.add(socket);
    if (verb === "kill-session" || verb === "kill-server") sessions.delete(socket);
    const stdout =
      verb === "capture-pane"
        ? submitted.has(socket)
          ? token
          : "https://claude.ai/oauth/authorize?code=fixture"
        : verb === "list-sessions" && sessions.has(socket)
          ? "jarv1s-login-anthropic"
          : "";
    return { code: 0, stdout, stderr: "" };
  });
  const io: TmuxIo = {
    run,
    readFile: async () => "",
    writeFile: async () => {},
    sleep: async () => {}
  };
  const probe = vi.fn(async () => ({ status: "ready" as const }));
  const validator = vi.fn(validate);
  const service = new LoginService({
    io,
    adapters: LOGIN_ADAPTERS,
    probe,
    homeBase: home,
    validateFreshToken: validator,
    settleMs: 0,
    surfaceTimeoutMs: 1,
    loginTimeoutMs: 1000
  });
  return { home, sessions, run, probe, validator, service };
}

const read = (file: string) => readFile(file, "utf8").catch(() => undefined);

describe("fresh actor/config Claude credentials", () => {
  it("ignores global ready, isolates setup-token, and publishes only the freshly validated capture", async () => {
    const f = await fixture();
    await publishFreshClaudeToken(
      f.home,
      scope,
      "previous-synthetic",
      () => true,
      () => {}
    );
    const id = f.service.reserve("anthropic", scope);
    const started = await f.service.start(id);
    expect(started.status).toBe("awaiting_token");
    expect((await f.service.poll("anthropic", id, scope)).status).toBe("awaiting_token");
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.validator).not.toHaveBeenCalled();
    expect(await read(scopedClaudeTokenPath(f.home, scope))).toBe("previous-synthetic");
    const launch = f.run.mock.calls.find(([, args]) => args.includes("new-session"))![1];
    expect(launch).toContain("-f");
    expect(await readFile(launch[launch.indexOf("-f") + 1]!, "utf8")).toBe(
      "set -g remain-on-exit on\n"
    );
    expect(launch).toContain("/usr/bin/env");
    expect(launch).toContain("-i");
    expect(launch).not.toContain(`HOME=${f.home}`);
    expect(launch.some((arg) => arg.startsWith("CLAUDE_CODE_OAUTH_TOKEN="))).toBe(false);
    expect(launch.slice(-2)).toEqual(["claude", "setup-token"]);
    const result = await f.service.submitToken("anthropic", id, "synthetic-code", scope);
    expect(result).toEqual({ loginId: id, status: "ready" });
    const [freshHome, captured] = f.validator.mock.calls[0]!;
    expect(freshHome).not.toBe(f.home);
    expect(captured).toBe(token);
    expect(await read(scopedClaudeTokenPath(f.home, scope))).toBe(token);
    expect(await read(providerTokenPath(f.home, "anthropic"))).toBe(token);
    expect(
      await read(scopedClaudeTokenPath(f.home, { ...scope, actorUserId: "actor-b" }))
    ).toBeUndefined();
    expect(
      await read(scopedClaudeTokenPath(f.home, { ...scope, providerConfigId: "config-b" }))
    ).toBeUndefined();
    expect((await stat(scopedClaudeTokenPath(f.home, scope))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(token);
    await f.service.startupSweep();
    expect(f.sessions.size).toBe(0);
  });

  it.each(["rejected", "cancelled", "timed-out"])(
    "does not replace a credential after %s validation",
    async (mode) => {
      let resolve!: (valid: boolean) => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((done) => {
        entered = done;
      });
      const f = await fixture(async () => {
        entered();
        return new Promise((done) => {
          resolve = done;
        });
      });
      await publishFreshClaudeToken(
        f.home,
        scope,
        "previous-synthetic",
        () => true,
        () => {}
      );
      const id = f.service.reserve("anthropic", scope);
      await f.service.start(id);
      if (mode === "timed-out") vi.useFakeTimers();
      // Arm a fresh hard lifetime under fake timers, without extending it on subsequent polls.
      if (mode === "timed-out") {
        await f.service.cancel("anthropic", id, scope);
      }
      const activeId = mode === "timed-out" ? f.service.reserve("anthropic", scope) : id;
      if (mode === "timed-out") await f.service.start(activeId);
      const pending = f.service.submitToken("anthropic", activeId, "synthetic-code", scope);
      await enteredPromise;
      if (mode === "cancelled") await f.service.cancel("anthropic", activeId, scope);
      if (mode === "timed-out") {
        await vi.advanceTimersByTimeAsync(500);
        await f.service.poll("anthropic", activeId, scope);
        await vi.advanceTimersByTimeAsync(501);
      }
      resolve(mode !== "rejected");
      expect((await pending).status).toBe("error");
      expect(await read(scopedClaudeTokenPath(f.home, scope))).toBe("previous-synthetic");
      expect(await read(providerTokenPath(f.home, "anthropic"))).toBe("previous-synthetic");
      await f.service.startupSweep();
    }
  );

  it("reaps a cancelled late start without touching a newer flow", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const entering = new Promise<void>((done) => {
      entered = done;
    });
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementationOnce(async (cmd, args) => {
      entered();
      await gate;
      return original(cmd, args);
    });
    const firstId = f.service.reserve("anthropic", scope);
    const pending = f.service.start(firstId);
    await entering;
    await f.service.cancel("anthropic", firstId, scope);
    const other = { ...scope, providerConfigId: "new-config" };
    const nextId = f.service.reserve("anthropic", other);
    expect((await f.service.start(nextId)).status).toBe("awaiting_token");
    release();
    expect((await pending).status).toBe("error");
    expect(f.service.activeLoginId("anthropic", other)).toBe(nextId);
    expect(f.sessions.size).toBe(1);
    expect(await read(scopedClaudeTokenPath(f.home, scope))).toBeUndefined();
    await f.service.cancel("anthropic", nextId, other);
  });

  it("cannot turn an echoed pasted credential into fresh provenance", async () => {
    const f = await fixture();
    const id = f.service.reserve("anthropic", scope);
    await f.service.start(id);
    expect((await f.service.submitToken("anthropic", id, token, scope)).status).toBe("error");
    expect(f.validator).not.toHaveBeenCalled();
    expect(await read(scopedClaudeTokenPath(f.home, scope))).toBeUndefined();
    await f.service.startupSweep();
  });

  it("rechecks the flow immediately before publication and leaves no scoped file when stale", async () => {
    const f = await fixture();
    const committed = vi.fn();
    await expect(
      publishFreshClaudeToken(f.home, scope, token, () => false, committed)
    ).rejects.toThrow("no longer active");
    expect(committed).not.toHaveBeenCalled();
    expect(await read(scopedClaudeTokenPath(f.home, scope))).toBeUndefined();
    expect(await read(providerTokenPath(f.home, "anthropic"))).toBeUndefined();
  });

  it("restores the previous chat token if scoped publication fails", async () => {
    const f = await fixture();
    await publishFreshClaudeToken(
      f.home,
      scope,
      "previous-synthetic",
      () => true,
      () => {}
    );
    const other = { ...scope, providerConfigId: "blocked-config" };
    await mkdir(scopedClaudeTokenPath(f.home, other), { recursive: true });
    await expect(
      publishFreshClaudeToken(
        f.home,
        other,
        token,
        () => true,
        () => {}
      )
    ).rejects.toThrow();
    expect(await read(providerTokenPath(f.home, "anthropic"))).toBe("previous-synthetic");
    expect(await read(scopedClaudeTokenPath(f.home, scope))).toBe("previous-synthetic");
  });

  it.each(["abort", "timeout", "overflow", "failure", "success"])(
    "cleans only its validation process group after %s",
    async (mode) => {
      const f = await fixture();
      const executable = path.join(f.home, "validation-tree");
      const ready = path.join(f.home, "descendant.pid");
      const descendantSource = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.send('ready'); setTimeout(() => {}, 35000);`;
      const outcome =
        mode === "success"
          ? "require('node:fs').writeFileSync(1, 'OK'); process.exit(0);"
          : mode === "failure"
            ? "process.exit(1);"
            : mode === "overflow"
              ? "require('node:fs').writeFileSync(2, 'x'.repeat(70000));"
              : "";
      await writeFile(
        executable,
        `#!${process.execPath}\nconst child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']}); child.once('message', () => { ${outcome} }); setTimeout(() => {}, 35000);\n`,
        { mode: 0o700 }
      );
      const peer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 35000)"], {
        stdio: "ignore"
      });
      const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
      const controller = new AbortController();
      const pending = validateFreshClaudeToken(executable, f.home, token, controller.signal);
      let pid: number | undefined;
      try {
        await vi.waitFor(async () => {
          pid = Number(await readFile(ready, "utf8"));
          expect(pid).toBeGreaterThan(1);
        });
        if (mode === "abort") controller.abort();
        expect(await pending).toBe(mode === "success");
        expect(peer.exitCode).toBeNull();
        expect(() => process.kill(peer.pid!, 0)).not.toThrow();
        await vi.waitFor(
          async () => {
            const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
            expect(status === "" || status.split(") ")[1]?.startsWith("Z ")).toBe(true);
          },
          { timeout: 1000 }
        );
      } finally {
        controller.abort();
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
        peer.kill("SIGKILL");
        await peerClosed;
        await pending;
      }
    },
    30_000
  );

  it("validates using an actual synthetic executable with only the fresh credential/context", async () => {
    const f = await fixture();
    const executable = path.join(f.home, "synthetic-cli");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst a = process.argv.slice(2);\nconst ok = process.env.CLAUDE_CODE_OAUTH_TOKEN === ${JSON.stringify(token)} && !process.env.ANTHROPIC_API_KEY && !process.env.WORKSHOP_SYNTHETIC_SECRET && process.cwd() === process.env.HOME && process.env.CLAUDE_CONFIG_DIR === process.env.HOME + '/config' && a[a.indexOf('--tools') + 1] === '' && a.includes('--strict-mcp-config') && a.includes('--no-session-persistence');\nrequire('node:fs').writeFileSync(1, ok ? 'OK' : 'bad environment');\n`,
      { mode: 0o700 }
    );
    vi.stubEnv("ANTHROPIC_API_KEY", "global-synthetic");
    vi.stubEnv("WORKSHOP_SYNTHETIC_SECRET", "must-not-inherit");
    expect(
      await validateFreshClaudeToken(executable, f.home, token, new AbortController().signal)
    ).toBe(true);
    expect(
      await validateFreshClaudeToken(
        executable,
        f.home,
        "wrong-synthetic",
        new AbortController().signal
      )
    ).toBe(false);
    expect(
      await validateFreshClaudeToken(
        path.join(f.home, "missing-cli"),
        f.home,
        token,
        new AbortController().signal
      )
    ).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    expect(await validateFreshClaudeToken(executable, f.home, token, aborted.signal)).toBe(false);
  });
});
