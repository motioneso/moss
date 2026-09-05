import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LoginService } from "../../packages/cli-runner/src/login-service.js";
import { LOGIN_ADAPTERS } from "../../packages/cli-runner/src/login-adapters.js";
import {
  prepareFreshGeminiLogin,
  publishFreshGeminiCredential,
  validateFreshGeminiCredential
} from "../../packages/cli-runner/src/fresh-gemini-login.js";
import { scopedGeminiCredentialPath } from "../../packages/cli-runner/src/gemini-credential-store.js";

const scope = { actorUserId: "actor-a", providerConfigId: "config-a" };
const record = {
  account: "fixture@example.invalid",
  oauth: {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    token_type: "Bearer" as const,
    expiry_date: Date.now() + 3600000
  }
};
const homes: string[] = [];
const services: { service: LoginService; id: string }[] = [];
afterEach(async () => {
  for (const { service, id } of services.splice(0))
    await service.cancel("google", id, scope).catch(() => undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function home() {
  const value = await mkdtemp(join(tmpdir(), "gemini-fresh-test-"));
  homes.push(value);
  return value;
}
async function native(root: string, value = record) {
  await mkdir(join(root, ".gemini"), { recursive: true });
  await writeFile(join(root, ".gemini/oauth_creds.json"), JSON.stringify(value.oauth));
  await writeFile(
    join(root, ".gemini/google_accounts.json"),
    JSON.stringify({ active: value.account, old: [] })
  );
}
const accountResponse = () => Response.json({ email: record.account, verified_email: true });

it("validates only fresh native account identity with bounded authenticated requests", async () => {
  const root = await home();
  await prepareFreshGeminiLogin(root);
  const fetcher = vi.fn(async () => accountResponse());
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(await validateFreshGeminiCredential(root, signal)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  await native(root);
  expect(await validateFreshGeminiCredential(root, signal)).toEqual(record);
  expect(fetcher).toHaveBeenCalledWith(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    expect.objectContaining({
      headers: { authorization: "Bearer synthetic-access" },
      redirect: "error"
    })
  );
  for (const response of [
    Response.json({ email: "foreign@example.invalid", verified_email: true }),
    Response.json({ email: record.account, verified_email: false }),
    Response.json({ email: record.account }, { status: 401 }),
    new Response("x".repeat(16385)),
    new Response("invalid")
  ]) {
    fetcher.mockImplementationOnce(async () => response);
    expect(await validateFreshGeminiCredential(root, signal)).toBeUndefined();
  }
  const controller = new AbortController();
  controller.abort();
  const calls = fetcher.mock.calls.length;
  expect(await validateFreshGeminiCredential(root, controller.signal)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(calls);
});

it("publishes ordinary native compatibility and rolls it back when scoped publication fails", async () => {
  const root = await home();
  const prior = { ...record, oauth: { ...record.oauth, access_token: "previous" } };
  await native(root, prior);
  const target = scopedGeminiCredentialPath(root, scope);
  await mkdir(target, { recursive: true }); // cannot replace a directory with the scoped record
  const committed = vi.fn();
  await expect(
    publishFreshGeminiCredential(root, scope, record, () => true, committed)
  ).rejects.toThrow();
  expect(committed).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(root, ".gemini/oauth_creds.json"), "utf8"))).toEqual(
    prior.oauth
  );
  expect(await readdir(join(root, ".gemini"))).toEqual([
    "google_accounts.json",
    "oauth_creds.json",
    "settings.json"
  ]);
  await rm(target, { recursive: true });
  await publishFreshGeminiCredential(root, scope, record, () => true, committed);
  expect(committed).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(record);
  for (const file of [
    target,
    join(root, ".gemini/oauth_creds.json"),
    join(root, ".gemini/google_accounts.json")
  ])
    expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it("bound Gemini login ignores global ready, uses a private environment, and cannot publish after cancellation", async () => {
  const root = await home();
  const probe = vi.fn(async () => ({ status: "ready" as const }));
  const fetcher = vi.fn(async () => accountResponse());
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("GEMINI_API_KEY", "ambient-secret");
  let freshHome = "";
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    if (args.includes("new-session")) {
      freshHome = args.find((arg) => arg.startsWith("HOME="))!.slice(5);
      expect(args).toContain("-i");
      expect(args).toContain("NO_BROWSER=1");
      expect(args.join(" ")).not.toContain("ambient-secret");
      expect(freshHome).not.toBe(root);
    }
    if (args.includes("send-keys") && args.includes("Enter")) await native(freshHome);
    return {
      code: 0,
      stdout: args.includes("capture-pane")
        ? "https://accounts.google.com/o/oauth2/v2/auth?fixture=1"
        : "",
      stderr: ""
    };
  });
  const service = new LoginService({
    homeBase: root,
    adapters: LOGIN_ADAPTERS,
    probe,
    validateFreshGemini: validateFreshGeminiCredential,
    settleMs: 0,
    surfaceTimeoutMs: 1,
    io: { run, readFile: async () => "", writeFile: async () => {}, sleep: async () => {} }
  });
  const id = service.reserve("google", scope);
  services.push({ service, id });
  expect((await service.start(id)).status).toBe("awaiting_token");
  expect((await service.submitToken("google", id, "synthetic-code", scope)).status).toBe("ready");
  expect(probe).not.toHaveBeenCalled();
  const target = scopedGeminiCredentialPath(root, scope);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(record);
  await service.startupSweep();
  const second = service.reserve("google", scope);
  services.push({ service, id: second });
  await service.start(second);
  fetcher.mockImplementationOnce(async () => {
    await service.cancel("google", second, scope);
    return accountResponse();
  });
  expect((await service.submitToken("google", second, "synthetic-code", scope)).status).toBe(
    "error"
  );
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(record);
  expect(await service.isLoginActive()).toBe(false);
});
