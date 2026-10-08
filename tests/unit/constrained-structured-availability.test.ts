import { createHmac, randomBytes } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CONSTRAINED_CLAUDE_VERSION } from "../../packages/chat/src/live/constrained-claude-profile.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import * as tokenStore from "../../packages/cli-runner/src/provider-token-store.js";
import { serveConnection, type ByteChannel } from "../../packages/cli-runner/src/connection.js";
import { TerminalHost } from "../../packages/cli-runner/src/terminal-host.js";
import {
  decodeFrame,
  encodeFrame,
  HELLO_PROOF_TAG_CLIENT,
  type RpcHelloChallenge,
  type RpcOk
} from "../../packages/chat/src/live/rpc-contract.js";

const SECRET = "synthetic-constrained-probe-handshake";
let dir: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

type Installation =
  | "ready"
  | "missing"
  | "stale"
  | "wrong-package"
  | "malformed"
  | "not-executable";
async function fixture(installation: Installation, perUserUid = true) {
  dir = await mkdtemp(join(tmpdir(), "constrained-probe-"));
  const root = dir;
  const executed = join(root, "executed");
  vi.stubEnv("PATH", root);
  if (installation !== "missing") {
    // Deliberately not a model binary. Execution would leave a tripwire, so this test cannot
    // accidentally contact a provider even if the cheap metadata-only probe regresses.
    await writeFile(join(root, "claude"), `#!/bin/sh\nprintf ran > '${executed}'\n`, {
      mode: 0o700
    });
    if (installation === "not-executable") await chmod(join(root, "claude"), 0o600);
    await writeFile(
      join(root, "package.json"),
      installation === "malformed"
        ? "{"
        : JSON.stringify({
            name:
              installation === "wrong-package"
                ? "unrelated-package"
                : `@anthropic-ai/claude-code-linux-${process.arch}`,
            version: installation === "stale" ? "0.0.0" : CONSTRAINED_CLAUDE_VERSION
          })
    );
  }
  const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const readFile = vi.fn(async () => "");
  const write = vi.fn(async () => {});
  const cliPresent = vi.fn(async () => true);
  const multiplexerUsable = vi.fn(async () => true);
  const resolveUserRuntime = vi.fn(async () => {
    throw new Error("must not resolve an owner runtime");
  });
  const credentialRead = vi.spyOn(tokenStore, "readProviderCredentialEnv").mockResolvedValue({});
  const host = new CliChatEngineHost({
    io: { run, readFile, writeFile: write, sleep: async () => {} } as TmuxIo,
    neutralBase: join(root, "neutral"),
    homeBase: join(root, "credentials-must-not-be-read"),
    singleUser: true,
    perUserUid,
    cliPresent,
    multiplexerUsable,
    resolveUserRuntime
  });
  const assertReadOnly = async () => {
    for (const spy of [
      run,
      readFile,
      write,
      cliPresent,
      multiplexerUsable,
      resolveUserRuntime,
      credentialRead
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(host.liveEngineCount()).toBe(0);
    await expect(access(executed)).rejects.toMatchObject({ code: "ENOENT" });
  };
  return { host, root, assertReadOnly };
}

/** Real framed server dispatch over an in-memory transport, including the HMAC handshake. */
class ProbeChannel implements ByteChannel {
  readonly written: Buffer[] = [];
  closed = false;
  private dataListener?: (chunk: Buffer) => void;
  private closeListener?: () => void;
  write(buffer: Buffer): void {
    if (!this.closed) this.written.push(buffer);
  }
  end(): void {
    this.closed = true;
    this.closeListener?.();
  }
  on(event: "data" | "close" | "error" | "drain", listener: (chunk: Buffer) => void): void {
    if (event === "data") this.dataListener = listener;
    else if (event === "close" || event === "error") this.closeListener = listener as () => void;
  }
  feed(buffer: Buffer): void {
    this.dataListener?.(buffer);
  }
  frames(): unknown[] {
    let buffer = Buffer.concat(this.written);
    const frames: unknown[] = [];
    for (;;) {
      const decoded = decodeFrame(buffer);
      if (decoded.kind !== "frame") return frames;
      frames.push(JSON.parse(decoded.body.toString("utf8")));
      buffer = buffer.subarray(decoded.consumed);
    }
  }
  authenticate(): void {
    this.feed(encodeFrame({ t: "hello", clientNonce: randomBytes(32).toString("hex") }));
    const challenge = this.frames().find(
      (frame) => (frame as { t?: string }).t === "hello-challenge"
    ) as RpcHelloChallenge;
    expect(challenge).toBeDefined();
    this.feed(
      encodeFrame({
        t: "hello-response",
        clientProof: createHmac("sha256", SECRET)
          .update(HELLO_PROOF_TAG_CLIENT + challenge.serverNonce)
          .digest("hex")
      })
    );
  }
}

describe("constrained structured availability is an advisory metadata-only probe", () => {
  it("rejects shared-account runners even when the pinned binary is present", async () => {
    const { host, assertReadOnly } = await fixture("ready", false);
    await expect(
      host.probeProvider("anthropic", "synthetic-owner", { constrainedStructured: true })
    ).resolves.toEqual({
      status: "error",
      constrainedUnavailableReason: "per_user_isolation_required"
    });
    await assertReadOnly();
  });
  it.each(["ready", "missing", "stale", "wrong-package", "malformed", "not-executable"] as const)(
    "reports %s without credentials, tmux or execution",
    async (installation) => {
      const { host, assertReadOnly } = await fixture(installation);
      await expect(
        host.probeProvider("anthropic", "synthetic-owner", {
          constrainedStructured: true,
          forceFresh: true
        })
      ).resolves.toEqual({ status: installation === "ready" ? "ready" : "not_installed" });
      await assertReadOnly();
    }
  );

  it.each(["openai-compatible", "google"] as const)(
    "rejects unsupported %s without probing its login",
    async (provider) => {
      const { host, assertReadOnly } = await fixture("ready");
      await expect(
        host.probeProvider(provider, "synthetic-owner", { constrainedStructured: true })
      ).resolves.toEqual({ status: "not_installed" });
      await assertReadOnly();
    }
  );

  it.each(["ready", "stale", "shared-account"] as const)(
    "forwards the constrained marker through authenticated RPC for %s",
    async (installation) => {
      const { host, root, assertReadOnly } = await fixture(
        installation === "shared-account" ? "ready" : installation,
        installation !== "shared-account"
      );
      const probe = vi.spyOn(host, "probeProvider");
      const channel = new ProbeChannel();
      serveConnection(channel, {
        host,
        bootId: "synthetic-probe-boot",
        secret: SECRET,
        terminalHost: new TerminalHost({ homeBase: root, toolsBinDir: root })
      });
      try {
        channel.authenticate();
        channel.feed(
          encodeFrame({
            t: "req",
            id: 19,
            method: "probeProvider",
            sessionKey: "synthetic-owner",
            params: { provider: "anthropic", constrainedStructured: true, forceFresh: true }
          })
        );
        await vi.waitFor(() => {
          const result = channel.frames().find((frame) => (frame as RpcOk).id === 19);
          expect(result).toMatchObject({
            t: "ok",
            id: 19,
            bootId: "synthetic-probe-boot",
            result:
              installation === "shared-account"
                ? { status: "error", constrainedUnavailableReason: "per_user_isolation_required" }
                : { status: installation === "ready" ? "ready" : "not_installed" }
          });
        });
        expect(probe).toHaveBeenCalledExactlyOnceWith("anthropic", "synthetic-owner", {
          forceFresh: true,
          constrainedStructured: true
        });
        expect(channel.closed).toBe(false);
        await assertReadOnly();
      } finally {
        channel.end();
      }
    }
  );
});
