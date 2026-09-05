import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createGeminiSourceLaunch } from "../../packages/chat/src/live/gemini-source-policy.js";
import {
  publishGeminiCredential,
  scopedGeminiCredentialPath
} from "../../packages/cli-runner/src/gemini-credential-store.js";

const scope = { actorUserId: "actor-a", providerConfigId: "config-a" };
const credential = (token: string) => ({
  account: "fixture@example.invalid",
  oauth: {
    access_token: token,
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    expiry_date: 1
  }
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const login = () => ({ kind: "login" as const, isCurrent: () => true, onPublished: vi.fn() });

it("publishes private scoped records, preserves cancelled state and rejects invalid input", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-store-test-"));
  roots.push(home);
  const target = scopedGeminiCredentialPath(home, scope);
  const guard = login();
  expect(await publishGeminiCredential(home, scope, credential("first"), guard)).toBe(true);
  expect(guard.onPublished).toHaveBeenCalledOnce();
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(target))).mode & 0o777).toBe(0o700);
  expect(scopedGeminiCredentialPath(home, { ...scope, actorUserId: "actor-b" })).not.toBe(target);
  expect(scopedGeminiCredentialPath(home, { ...scope, providerConfigId: "config-b" })).not.toBe(
    target
  );
  const cancelled = { ...login(), isCurrent: () => false };
  expect(await publishGeminiCredential(home, scope, credential("cancelled"), cancelled)).toBe(
    false
  );
  expect(cancelled.onPublished).not.toHaveBeenCalled();
  await expect(publishGeminiCredential(home, scope, {}, login())).rejects.toThrow("unavailable");
  await expect(
    publishGeminiCredential(
      home,
      { ...scope, actorUserId: "../escape" },
      credential("bad"),
      login()
    )
  ).rejects.toThrow();
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(credential("first"));
  expect(await readdir(dirname(target))).toEqual(["google"]);
});

it("persists only accepted account-bound refreshes and fences stale or concurrent writers", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-store-test-"));
  roots.push(home);
  await publishGeminiCredential(home, scope, credential("first"), login());
  const target = scopedGeminiCredentialPath(home, scope);
  const launch = await createGeminiSourceLaunch({ model: "configured-model", schema: {} }, target);
  try {
    await expect(launch.readRefreshedCredential()).rejects.toThrow("unavailable");
    const native = join(launch.env.HOME, ".gemini");
    await writeFile(
      join(native, "oauth_creds.json"),
      JSON.stringify(credential("refreshed").oauth)
    );
    const output = [
      { type: "init", model: "configured-model" },
      { type: "message", role: "assistant", content: "{}" },
      { type: "result", status: "success" }
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");
    await launch.readResult(output);
    const updated = await launch.readRefreshedCredential();
    expect(updated).toEqual(credential("refreshed"));
    const refresh = () => ({
      ...login(),
      kind: "refresh" as const,
      expectedVersion: launch.credentialVersion
    });
    const guards = [refresh(), refresh()];
    const results = await Promise.all(
      guards.map((guard, index) =>
        publishGeminiCredential(home, scope, credential(`refresh-${index}`), guard)
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(guards.reduce((count, guard) => count + guard.onPublished.mock.calls.length, 0)).toBe(1);
    await publishGeminiCredential(home, scope, credential("new-login"), login());
    expect(await publishGeminiCredential(home, scope, updated, refresh())).toBe(false);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(credential("new-login"));
    expect(
      await publishGeminiCredential(home, { ...scope, actorUserId: "actor-b" }, updated, refresh())
    ).toBe(false);
    expect(await readdir(dirname(target))).toEqual(["google"]);
    await writeFile(
      join(native, "google_accounts.json"),
      JSON.stringify({ active: "other@example.invalid" })
    );
    expect(await launch.readRefreshedCredential()).toEqual(updated);
    await expect(launch.readResult(output)).rejects.toThrow("validation");
    await expect(launch.readRefreshedCredential()).rejects.toThrow("unavailable");
    await writeFile(
      join(native, "google_accounts.json"),
      JSON.stringify({ active: updated.account })
    );
    await expect(launch.readResult("invalid")).rejects.toThrow("validation");
    await expect(launch.readRefreshedCredential()).rejects.toThrow("unavailable");
  } finally {
    await launch.dispose();
  }
});
