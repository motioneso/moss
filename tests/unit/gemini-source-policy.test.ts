import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGeminiSourceLaunch } from "../../packages/chat/src/live/gemini-source-policy.js";

const model = "gemini-2.5-flash";
const credential = {
  account: "fixture@example.invalid",
  oauth: {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    token_type: "Bearer",
    expiry_date: 1
  }
};
const init = { type: "init", model };
const message = { type: "message", role: "assistant", content: '{"word":"quasar"}', delta: true };
const result = { type: "result", status: "success" };
const records = (...values: unknown[]) => values.map((value) => JSON.stringify(value)).join("\n");
let root: string;
let path: string;
let launch: Awaited<ReturnType<typeof createGeminiSourceLaunch>> | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gemini-source-test-"));
  path = join(root, "credential.json");
  await writeFile(path, JSON.stringify(credential), { mode: 0o600 });
  vi.stubEnv("GEMINI_API_KEY", "ambient-must-not-inherit");
  vi.stubEnv("GEMINI_EXP", "/ambient/experiments");
});
afterEach(async () => {
  await launch?.dispose();
  launch = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("creates isolated native OAuth state and the installed source policy without ambient overrides", async () => {
  launch = await createGeminiSourceLaunch({ model, schema: { type: "object" } }, path);
  expect(Object.keys(launch.env).sort()).toEqual([
    "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    "HOME",
    "NO_BROWSER",
    "PATH",
    "TMPDIR"
  ]);
  expect(launch.cwd.startsWith(launch.env.HOME)).toBe(true);
  expect((await stat(launch.env.HOME)).mode & 0o777).toBe(0o700);
  const native = join(launch.env.HOME, ".gemini", "oauth_creds.json");
  expect((await stat(native)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(native, "utf8"))).toEqual(credential.oauth);
  const settings = JSON.parse(await readFile(launch.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
  expect(settings.tools.core).toEqual([]);
  expect(settings.mcp).toEqual({
    allowed: ["workshop-source-disabled"],
    excluded: ["workshop-source-disabled"]
  });
  expect(settings.modelConfigs.modelIdResolutions[model]).toEqual({ default: model, contexts: [] });
  expect(launch.encodePrompt("source-task")).toContain('schema:\n{"type":"object"}');
  expect(JSON.stringify(launch.env)).not.toContain("synthetic-access");
  expect(launch.args.join(" ")).not.toContain("synthetic-access");
  const home = launch.env.HOME;
  await launch.dispose();
  await expect(access(home)).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(credential);
});

it("accepts one successful structured result and rejects tool activity, mismatched identity and credential echoes", async () => {
  launch = await createGeminiSourceLaunch({ model, schema: {} }, path);
  expect(await launch.readResult(records(init, message, result))).toBe('{"word":"quasar"}');
  for (const output of [
    records({ ...init, model: "other-model" }, message, result),
    records(init, message, { ...result, status: "error" }),
    records(init, { type: "tool_use", tool_name: "read_file" }, message, result),
    records(init, { type: "tool_result", status: "error" }, message, result),
    records(init, message, result, result),
    records(init, result, message),
    records(init, { ...message, content: "[]" }, result),
    records(init, { ...message, content: '{"word":"synthetic-refresh"}' }, result),
    "not-json",
    "x".repeat(65537)
  ])
    await expect(launch!.readResult(output)).rejects.toThrow("failed policy validation");
  await writeFile(
    join(launch.env.HOME, ".gemini", "oauth_creds.json"),
    JSON.stringify({
      ...credential.oauth,
      access_token: "synthetic-rotated-access"
    })
  );
  await expect(
    launch.readResult(
      records(init, { ...message, content: '{"word":"synthetic-rotated-access"}' }, result)
    )
  ).rejects.toThrow("failed policy validation");
  await expect(launch.readRefreshedCredential()).rejects.toThrow("unavailable");
});

it("rejects original and refreshed credentials reconstructed from deltas or JSON escapes", async () => {
  const original = { ...credential.oauth, id_token: 'original-id-"quoted"' };
  const refreshed = {
    ...credential.oauth,
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
    id_token: 'rotated-id-"quoted"'
  };
  await writeFile(path, JSON.stringify({ ...credential, oauth: original }));
  launch = await createGeminiSourceLaunch({ model, schema: {} }, path);
  await writeFile(join(launch.env.HOME, ".gemini", "oauth_creds.json"), JSON.stringify(refreshed));
  for (const oauth of [original, refreshed]) {
    for (const secret of [oauth.access_token, oauth.refresh_token, oauth.id_token]) {
      const source = JSON.stringify({ word: secret });
      const split = source.indexOf("-") + 1;
      const escaped = Array.from(
        secret,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
      ).join("");
      for (const output of [
        records(
          init,
          { ...message, content: source.slice(0, split) },
          { ...message, content: source.slice(split) },
          result
        ),
        records(init, { ...message, content: `{"word":"${escaped}"}` }, result)
      ]) {
        expect(output).not.toContain(secret);
        expect(output).not.toContain(JSON.stringify(secret).slice(1, -1));
        await launch.readResult(records(init, message, result));
        await expect(launch.readResult(output)).rejects.toThrow("failed policy validation");
        await expect(launch.readRefreshedCredential()).rejects.toThrow("unavailable");
      }
    }
  }
});

it("requires one valid bounded credential record and a concrete model", async () => {
  for (const selected of [undefined, "", "default", " ", " model "]) {
    await expect(createGeminiSourceLaunch({ model: selected, schema: {} }, path)).rejects.toThrow(
      "requires"
    );
  }
  for (const value of [
    {},
    { ...credential, oauth: {} },
    { ...credential, account: "" },
    { ...credential, extra: true },
    "x".repeat(65537)
  ]) {
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
    await expect(createGeminiSourceLaunch({ model, schema: {} }, path)).rejects.toThrow(
      "credential is unavailable"
    );
  }
  const link = join(root, "symlink");
  await symlink(path, link);
  await expect(createGeminiSourceLaunch({ model, schema: {} }, link)).rejects.toThrow(
    "credential is unavailable"
  );
  await expect(createGeminiSourceLaunch({ model, schema: {} }, root)).rejects.toThrow(
    "credential is unavailable"
  );
});
