/**
 * #1554 task #5 — `chat-multiplexer.ts`'s `resolveChatEngineFactory` (the real production
 * composition root for the in-process/host-dev topology): the settings-allowlist fix
 * (`PREAUTH_READABLE_SETTING_KEYS` gaining `chat.persistent_pool_cap` /
 * `chat.persistent_idle_reap_minutes`) plus the two new readers that use it
 * (`readPersistentPoolCap`, `createIdleReapMinutesLiveReader`).
 *
 * Both readers fail CLOSED to the registry default on ANY read error — including the
 * allowlist's own `"pre-auth instance-setting read not allowed for key ..."` throw — so a
 * broken allowlist does NOT surface as a crash or a thrown error here; it silently produces
 * the default value instead. That means the only way to prove the allowlist fix is load-
 * bearing is to seed a NON-default row value and assert it actually comes through: if the
 * allowlist regressed, both assertions below would see the (different) registry default
 * instead and fail.
 *
 * `createRealEngineFactory` (`@moss/chat`) is mocked so this test proves only what
 * `resolveChatEngineFactory` reads and forwards, without constructing a real pool/engine.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

import { resolveChatEngineFactory } from "../../packages/module-registry/src/chat-multiplexer.js";

async function pathWithFakeTmux(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarv1s-mux-settings-"));
  const bin = join(dir, "tmux");
  await writeFile(bin, "");
  await chmod(bin, 0o755);
  return dir;
}

/** Minimal fake `appDb` — only the `selectFrom("app.instance_settings").select("value")
 *  .where("key", "=", key).executeTakeFirst()` chain `chat-multiplexer.ts`'s readers use. */
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

describe("resolveChatEngineFactory — persistent-pool settings wiring (#1554 task #5)", () => {
  afterEach(() => {
    createRealEngineFactoryMock.mockReset();
  });

  it("runs the real multiplexer check with an isolated HOME and no ambient secrets", async () => {
    createRealEngineFactoryMock.mockReturnValue(vi.fn());
    const dir = await mkdtemp(join(tmpdir(), "jarv1s-mux-env-"));
    const capturePath = join(dir, "delivered-env");
    const bin = join(dir, "tmux");
    await writeFile(bin, `#!/bin/sh\n/usr/bin/env > "${capturePath}"\n`, { mode: 0o755 });

    try {
      await resolveChatEngineFactory({
        appDb: fakeAppDb({}),
        env: {
          PATH: `${dir}:${process.env.PATH ?? "/usr/bin"}`,
          HOME: "/real-user-home",
          MOSS_CLI_HOME_BASE: "/isolated-cli-home",
          BETTER_AUTH_SECRET: "must-not-reach-multiplexer"
        },
        log: vi.fn()
      });

      const opts = createRealEngineFactoryMock.mock.calls[0]![0];
      await opts.mux.open({
        name: "env-check",
        cols: 80,
        rows: 24,
        launchLine: "true"
      });
      const delivered = Object.fromEntries(
        (await readFile(capturePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.split(/=(.*)/s, 2))
      );
      expect(delivered.HOME).toBe("/isolated-cli-home");
      expect(delivered.BETTER_AUTH_SECRET).toBeUndefined();
      expect(createRealEngineFactoryMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads chat.persistent_pool_cap and chat.persistent_idle_reap_minutes through the (now-allowlisted) pre-auth exception, not the registry defaults", async () => {
    createRealEngineFactoryMock.mockReturnValue(vi.fn());
    const path = await pathWithFakeTmux();
    const log = vi.fn();

    await resolveChatEngineFactory({
      // Non-default values (registry defaults are 4 / 30) — if the allowlist regressed, the
      // readers would fail closed to those defaults instead, and these assertions would fail.
      appDb: fakeAppDb({
        "chat.persistent_pool_cap": "7",
        "chat.persistent_idle_reap_minutes": "45"
      }),
      env: { PATH: path },
      log
    });

    expect(createRealEngineFactoryMock).toHaveBeenCalledTimes(1);
    const opts = createRealEngineFactoryMock.mock.calls[0]![0];
    expect(opts.persistentPoolCap).toBe(7);
    await expect(opts.readIdleReapMinutes()).resolves.toBe(45);

    // No "pre-auth instance-setting read not allowed" log line for either new key.
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("not allowed");
  });

  it("falls back to the registry defaults (4 / 30) when no row is set, without throwing", async () => {
    createRealEngineFactoryMock.mockReturnValue(vi.fn());
    const path = await pathWithFakeTmux();

    await resolveChatEngineFactory({ appDb: fakeAppDb({}), env: { PATH: path }, log: vi.fn() });

    expect(createRealEngineFactoryMock).toHaveBeenCalledTimes(1);
    const opts = createRealEngineFactoryMock.mock.calls[0]![0];
    expect(opts.persistentPoolCap).toBe(4);
    await expect(opts.readIdleReapMinutes()).resolves.toBe(30);
  });

  // #1554 task #6 — closes task #5's documented KNOWN GAP: `onPersistentReap` must now be
  // forwarded straight through to `createRealEngineFactory`, unmodified, so the composition
  // root's (module-registry/src/index.ts) late-bound revoke callback actually reaches the pool.
  it("forwards onPersistentReap straight through to createRealEngineFactory", async () => {
    createRealEngineFactoryMock.mockReturnValue(vi.fn());
    const path = await pathWithFakeTmux();
    const onPersistentReap = vi.fn();

    await resolveChatEngineFactory({
      appDb: fakeAppDb({}),
      env: { PATH: path },
      log: vi.fn(),
      onPersistentReap
    });

    expect(createRealEngineFactoryMock).toHaveBeenCalledTimes(1);
    const opts = createRealEngineFactoryMock.mock.calls[0]![0];
    expect(opts.onPersistentReap).toBe(onPersistentReap);
  });

  it("passes onPersistentReap through as undefined when the caller omits it (no crash)", async () => {
    createRealEngineFactoryMock.mockReturnValue(vi.fn());
    const path = await pathWithFakeTmux();

    await resolveChatEngineFactory({ appDb: fakeAppDb({}), env: { PATH: path }, log: vi.fn() });

    expect(createRealEngineFactoryMock).toHaveBeenCalledTimes(1);
    const opts = createRealEngineFactoryMock.mock.calls[0]![0];
    expect(opts.onPersistentReap).toBeUndefined();
  });
});
