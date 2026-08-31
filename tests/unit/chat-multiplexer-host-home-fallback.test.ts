/**
 * #1612 follow-up (Codex arbitration on PR #2147): when `JARVIS_CLI_HOME_BASE` is not configured,
 * both HOME-resolution sites in `chat-multiplexer.ts` (the provider-check probe and
 * `resolveChatEngineFactory`'s tmux io) must fall back to the real OS home directory, not a fresh
 * empty `tmpdir()`. A `tmpdir()` fallback is indistinguishable from a scratch dir with no
 * credentials and reproduces the original bug on any host that never sets the env var.
 *
 * This test proves the fallback end to end: with only `HOME` set (no `JARVIS_CLI_HOME_BASE`), the
 * real provider probe reports `ready` and the tmux-launching engine factory hands its child that
 * same host `HOME` — while a poisoned ambient secret still does not reach either child.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";
import type * as MossChatModule from "@moss/chat";

const { createRealEngineFactoryMock } = vi.hoisted(() => ({
  createRealEngineFactoryMock: vi.fn()
}));

vi.mock("@moss/chat", async (importOriginal) => {
  const actual = await importOriginal<typeof MossChatModule>();
  return { ...actual, createRealEngineFactory: createRealEngineFactoryMock };
});

import {
  makeProviderConnectionCheckProbe,
  resolveChatEngineFactory
} from "../../packages/module-registry/src/chat-multiplexer.js";

function fakeAppDb(rows: Record<string, string>): Kysely<MossDatabase> {
  return {
    selectFrom: () => ({
      select: () => ({
        where: (_col: string, _op: string, key: string) => ({
          executeTakeFirst: async () => (key in rows ? { value: { value: rows[key] } } : undefined)
        })
      })
    })
  } as unknown as Kysely<MossDatabase>;
}

async function readDeliveredEnv(capturePath: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s, 2))
  );
}

describe("chat-multiplexer HOME fallback with no JARVIS_CLI_HOME_BASE configured", () => {
  afterEach(() => {
    createRealEngineFactoryMock.mockReset();
  });

  it("falls back to the real host HOME for both the provider probe and tmux children, never a scratch tmpdir", async () => {
    const bin = await mkdtemp(join(tmpdir(), "jarv1s-host-home-bin-"));
    const hostHome = await mkdtemp(join(tmpdir(), "jarv1s-host-home-"));
    await writeFile(join(hostHome, "credential-marker"), "logged-in", "utf8");

    const claudeCapture = join(bin, "claude-delivered-env");
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\n` +
        `/usr/bin/env > "${claudeCapture}"\n` +
        `if [ -f "$HOME/credential-marker" ]; then\n` +
        `  printf '{"loggedIn":true}\\n'\n` +
        `else\n` +
        `  printf '{"loggedIn":false}\\n'\n` +
        `fi\n`,
      { mode: 0o755 }
    );

    const tmuxCapture = join(bin, "tmux-delivered-env");
    await writeFile(join(bin, "tmux"), `#!/bin/sh\n/usr/bin/env > "${tmuxCapture}"\n`, {
      mode: 0o755
    });

    const env = {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin"}`,
      HOME: hostHome,
      BETTER_AUTH_SECRET: "must-not-reach-any-child"
    };

    try {
      const probe = makeProviderConnectionCheckProbe({
        engineFactory: () => {
          throw new Error("anthropic provider checks should not open an interactive engine");
        },
        cliPresent: async () => true,
        skipInstallCheck: true,
        env
      });
      await expect(probe("anthropic")).resolves.toEqual({ status: "ready" });
      const claudeDelivered = await readDeliveredEnv(claudeCapture);
      expect(claudeDelivered.HOME).toBe(hostHome);
      expect(claudeDelivered.BETTER_AUTH_SECRET).toBeUndefined();

      createRealEngineFactoryMock.mockReturnValue(vi.fn());
      await resolveChatEngineFactory({ appDb: fakeAppDb({}), env, log: vi.fn() });
      const opts = createRealEngineFactoryMock.mock.calls[0]![0];
      await opts.mux.open({ name: "host-home-check", cols: 80, rows: 24, launchLine: "true" });
      const tmuxDelivered = await readDeliveredEnv(tmuxCapture);
      expect(tmuxDelivered.HOME).toBe(hostHome);
      expect(tmuxDelivered.BETTER_AUTH_SECRET).toBeUndefined();
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(hostHome, { recursive: true, force: true });
    }
  });
});
