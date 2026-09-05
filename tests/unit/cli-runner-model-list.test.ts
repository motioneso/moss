/**
 * cli-runner MODEL-LIST tests (#2208, spec 2026-09-03-discover-cli-provider-models §1):
 *   - anthropic: the stored token's `CLAUDE_CODE_OAUTH_TOKEN=` prefix is stripped; the vendor
 *     call carries Bearer + version + oauth-beta headers; snapshot ids (":") are dropped;
 *   - codex: `<homeBase>/.codex/auth.json` supplies Bearer + ChatGPT-Account-Id; the
 *     `client_version` is the installed CLI's real version (read once, cached); only
 *     `visibility === "list"` slugs are kept; a missing file is `not_logged_in`;
 *   - google: `unsupported`;
 *   - a timeout / HTTP failure / throw yields a plain `error` whose message carries NO token, and
 *     a refused sign-in (HTTP 401) is reported as `not_logged_in` and clears the saved readiness;
 *   - the RPC verb is dispatched non-session and its kind guard is bad_request.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_LIST_TIMEOUT_MS,
  createCodexVersionReader,
  filterAnthropicModelIds,
  filterCodexModelIds,
  listProviderModels,
  parseCodexVersion,
  stripAnthropicTokenPrefix
} from "../../packages/cli-runner/src/model-list-adapters.js";
import { persistProviderToken } from "../../packages/cli-runner/src/provider-token-store.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import { clearProviderProbeCacheForTests } from "../../packages/chat/src/live/provider-probe.js";

const ANTHROPIC_TOKEN = "sk-ant-oat01-secret-token-value";
const CODEX_TOKEN = "eyJ-codex-access-token-secret";
const CODEX_ACCOUNT = "acct_123";

async function homeWithAnthropicToken(raw = ANTHROPIC_TOKEN): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "model-list-"));
  await persistProviderToken(home, "anthropic", raw);
  return home;
}

async function homeWithCodexAuth(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "model-list-"));
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: CODEX_TOKEN, account_id: CODEX_ACCOUNT } })
  );
  return home;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** A fetch spy that records the url + headers of its one call. */
function fakeFetch(response: Response | (() => Promise<Response>)) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) }
    });
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof globalThis.fetch;
  return { f, calls };
}

describe("model-list pure helpers", () => {
  it("strips a leading CLAUDE_CODE_OAUTH_TOKEN= prefix and surrounding whitespace", () => {
    expect(stripAnthropicTokenPrefix(`CLAUDE_CODE_OAUTH_TOKEN=${ANTHROPIC_TOKEN}\n`)).toBe(
      ANTHROPIC_TOKEN
    );
    expect(stripAnthropicTokenPrefix(`  ${ANTHROPIC_TOKEN}  `)).toBe(ANTHROPIC_TOKEN);
    expect(stripAnthropicTokenPrefix("CLAUDE_CODE_OAUTH_TOKEN=")).toBe("");
  });

  it("keeps claude- ids without a snapshot colon", () => {
    expect(
      filterAnthropicModelIds({
        data: [
          { id: "claude-fable-5-1" },
          { id: "claude-opus-4-8:snapshot" },
          { id: "not-a-claude" },
          { id: "" },
          {},
          null
        ]
      })
    ).toEqual(["claude-fable-5-1"]);
    expect(filterAnthropicModelIds({ data: "nope" })).toEqual([]);
    expect(filterAnthropicModelIds(null)).toEqual([]);
  });

  it("keeps only codex models with visibility 'list'", () => {
    expect(
      filterCodexModelIds({
        models: [
          { slug: "gpt-5.6", visibility: "list" },
          { slug: "gpt-5.6-hidden", visibility: "hidden" },
          { slug: "gpt-5.6-nov" },
          { visibility: "list" },
          null
        ]
      })
    ).toEqual(["gpt-5.6"]);
    expect(filterCodexModelIds({})).toEqual([]);
  });

  it("parses the codex CLI version line", () => {
    expect(parseCodexVersion("codex-cli 0.139.0\n")).toBe("0.139.0");
    expect(parseCodexVersion("codex-cli 0.140.0-alpha.3")).toBe("0.140.0-alpha.3");
    expect(parseCodexVersion("garbage")).toBeUndefined();
  });

  it("reads codex --version once and caches a success, not a failure", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({ code: 0, stdout: "codex-cli 0.139.0\n" })
      .mockResolvedValue({ code: 0, stdout: "codex-cli 9.9.9\n" });
    const read = createCodexVersionReader({ run });
    expect(await read()).toBeUndefined();
    expect(await read()).toBe("0.139.0");
    expect(await read()).toBe("0.139.0");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith("codex", ["--version"]);
    expect(await createCodexVersionReader(undefined)()).toBeUndefined();
  });
});

describe("anthropic model-list adapter", () => {
  it("sends the stripped token as Bearer with the version + oauth-beta headers and returns ids", async () => {
    const home = await homeWithAnthropicToken(`CLAUDE_CODE_OAUTH_TOKEN=${ANTHROPIC_TOKEN}`);
    const { f, calls } = fakeFetch(
      jsonResponse({
        data: [
          { id: "claude-fable-5-1", created_at: "2026-06-01T00:00:00Z" },
          { id: "claude-opus-4-8" },
          { id: "claude-x:old" }
        ]
      })
    );
    const result = await listProviderModels("anthropic", { homeBase: home, fetch: f });
    expect(result).toEqual({
      status: "ok",
      models: [
        { id: "claude-fable-5-1", releasedAt: "2026-06-01T00:00:00.000Z" },
        { id: "claude-opus-4-8", releasedAt: null }
      ]
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(calls[0]!.headers).toEqual({
      authorization: `Bearer ${ANTHROPIC_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20"
    });
  });

  it("reports not_logged_in when no token is stored or no home base is configured", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "model-list-"));
    const { f } = fakeFetch(jsonResponse({ data: [] }));
    expect(await listProviderModels("anthropic", { homeBase: empty, fetch: f })).toEqual({
      status: "not_logged_in"
    });
    expect(await listProviderModels("anthropic", { fetch: f })).toEqual({
      status: "not_logged_in"
    });
    const prefixOnly = await homeWithAnthropicToken("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(await listProviderModels("anthropic", { homeBase: prefixOnly, fetch: f })).toEqual({
      status: "not_logged_in"
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports a refused sign-in as not logged in, and any other HTTP failure as a plain error, carrying no token", async () => {
    const home = await homeWithAnthropicToken();
    // #2242: the vendor answered and refused the stored sign-in — that is a login problem, not
    // an unreachable provider, so the person is told to log in again rather than to retry.
    const refused = fakeFetch(jsonResponse({ error: `bad token ${ANTHROPIC_TOKEN}` }, 401));
    const rejected = await listProviderModels("anthropic", { homeBase: home, fetch: refused.f });
    expect(rejected.status).toBe("not_logged_in");
    expect(JSON.stringify(rejected)).not.toContain(ANTHROPIC_TOKEN);
    expect(JSON.stringify(rejected)).toContain("401");

    const broken = fakeFetch(jsonResponse({ error: `bad token ${ANTHROPIC_TOKEN}` }, 500));
    const result = await listProviderModels("anthropic", { homeBase: home, fetch: broken.f });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain(ANTHROPIC_TOKEN);
    expect(JSON.stringify(result)).toContain("500");
  });

  it("turns a timeout / thrown fetch into a plain error that carries no token", async () => {
    const home = await homeWithAnthropicToken();
    const timeout = fakeFetch(async () => {
      const err = new Error(`aborted while sending ${ANTHROPIC_TOKEN}`);
      err.name = "TimeoutError";
      throw err;
    });
    const timedOut = await listProviderModels("anthropic", { homeBase: home, fetch: timeout.f });
    expect(timedOut).toEqual({
      status: "error",
      message: `model list request timed out after ${MODEL_LIST_TIMEOUT_MS} ms`
    });

    const network = fakeFetch(async () => {
      throw new Error(`ECONNRESET Bearer ${ANTHROPIC_TOKEN}`);
    });
    const failed = await listProviderModels("anthropic", { homeBase: home, fetch: network.f });
    expect(failed.status).toBe("error");
    expect(JSON.stringify(failed)).not.toContain(ANTHROPIC_TOKEN);
  });

  it("bounds the vendor call with an abort signal", async () => {
    const home = await homeWithAnthropicToken();
    let signal: AbortSignal | null | undefined;
    const f = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return jsonResponse({ data: [] });
    }) as unknown as typeof globalThis.fetch;
    await listProviderModels("anthropic", { homeBase: home, fetch: f });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("codex model-list adapter", () => {
  it("sends Bearer + ChatGPT-Account-Id with the real CLI version and keeps listable slugs", async () => {
    const home = await homeWithCodexAuth();
    const { f, calls } = fakeFetch(
      jsonResponse({
        models: [
          { slug: "gpt-5.6", visibility: "list" },
          { slug: "gpt-5.6-internal", visibility: "hidden" }
        ]
      })
    );
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "codex-cli 0.139.0\n" });
    const result = await listProviderModels("openai-compatible", {
      homeBase: home,
      fetch: f,
      io: { run }
    });
    expect(result).toEqual({ status: "ok", models: [{ id: "gpt-5.6" }] });
    expect(calls[0]!.url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.139.0"
    );
    expect(calls[0]!.headers).toEqual({
      authorization: `Bearer ${CODEX_TOKEN}`,
      "ChatGPT-Account-Id": CODEX_ACCOUNT
    });
  });

  it("reports not_logged_in when auth.json is missing or incomplete", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "model-list-"));
    const { f } = fakeFetch(jsonResponse({ models: [] }));
    expect(await listProviderModels("openai-compatible", { homeBase: empty, fetch: f })).toEqual({
      status: "not_logged_in"
    });
    await mkdir(path.join(empty, ".codex"), { recursive: true });
    await writeFile(
      path.join(empty, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: CODEX_TOKEN } })
    );
    expect(await listProviderModels("openai-compatible", { homeBase: empty, fetch: f })).toEqual({
      status: "not_logged_in"
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("fails plainly (no token) when the CLI version cannot be read or the vendor rejects", async () => {
    const home = await homeWithCodexAuth();
    const { f } = fakeFetch(jsonResponse({ models: [] }));
    const noVersion = await listProviderModels("openai-compatible", {
      homeBase: home,
      fetch: f,
      codexVersion: async () => undefined
    });
    expect(noVersion.status).toBe("error");
    expect(f).not.toHaveBeenCalled();

    const rejected = fakeFetch(jsonResponse({ detail: CODEX_TOKEN }, 403));
    const result = await listProviderModels("openai-compatible", {
      homeBase: home,
      fetch: rejected.f,
      codexVersion: async () => "0.139.0"
    });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain(CODEX_TOKEN);
    expect(JSON.stringify(result)).not.toContain(CODEX_ACCOUNT);
  });
});

describe("google model-list adapter", () => {
  it("is unsupported", async () => {
    const result = await listProviderModels("google", { homeBase: "/nowhere" });
    expect(result.status).toBe("unsupported");
  });
});

describe("engine-host listProviderModels", () => {
  it("reads codex --version through the host io once and threads homeBase + fetch", async () => {
    const home = await homeWithCodexAuth();
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "codex-cli 0.139.0\n" });
    // A Response body reads once, so the host's second call needs a fresh one.
    const { f, calls } = fakeFetch(async () =>
      jsonResponse({ models: [{ slug: "gpt-5.6", visibility: "list" }] })
    );
    const host = new CliChatEngineHost({
      io: {
        run,
        readFile: vi.fn().mockResolvedValue(""),
        writeFile: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn().mockResolvedValue(undefined)
      },
      neutralBase: "/tmp/neutral-base",
      homeBase: home,
      singleUser: true,
      cliPresent: async () => false,
      fetch: f
    });
    expect(await host.listProviderModels("openai-compatible")).toEqual({
      status: "ok",
      models: [{ id: "gpt-5.6" }]
    });
    expect(await host.listProviderModels("openai-compatible")).toMatchObject({ status: "ok" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(await host.listProviderModels("google")).toMatchObject({ status: "unsupported" });
  });
});

describe("#2242: a rejected credential clears the saved 'the login works' answer", () => {
  beforeEach(() => {
    clearProviderProbeCacheForTests();
  });
  afterEach(() => {
    clearProviderProbeCacheForTests();
  });

  it("turns a later readiness check into needs_login after the vendor rejects the token", async () => {
    // The exact sequence the review found: the readiness check saves a "ready" answer, the token
    // is then revoked, the model-list call comes back 401 — and the very next readiness check
    // must NOT replay the saved success for the rest of the five-minute cache window.
    const home = await homeWithAnthropicToken();
    let revoked = false;
    const run = vi.fn(async () =>
      revoked
        ? { code: 1, stdout: "", stderr: "API Error: 401 invalid bearer token" }
        : { code: 0, stdout: "OK" }
    );
    const { f } = fakeFetch(async () => jsonResponse({ error: "unauthorized" }, 401));
    const host = new CliChatEngineHost({
      io: {
        run,
        readFile: vi.fn().mockResolvedValue(""),
        writeFile: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn().mockResolvedValue(undefined)
      },
      neutralBase: "/tmp/neutral-base",
      homeBase: home,
      singleUser: false,
      cliPresent: async () => true,
      fetch: f
    });

    expect(await host.probeProvider("anthropic")).toMatchObject({ status: "ready" });

    revoked = true;
    const rejected = await host.listProviderModels("anthropic");
    expect(JSON.stringify(rejected)).toContain("401");
    expect(JSON.stringify(rejected)).not.toContain(ANTHROPIC_TOKEN);

    expect(await host.probeProvider("anthropic")).toMatchObject({ status: "needs_login" });
  });

  it("keeps a codex readiness check honest after the vendor rejects the credential", async () => {
    // Round-3 review finding: codex's readiness check only asks the local tool whether it holds a
    // credential file, and it returned before the refusal was consulted — so a refused model list
    // correctly said Not logged in and the very next readiness check said ready anyway.
    const home = await homeWithCodexAuth();
    const { f } = fakeFetch(async () => jsonResponse({ error: "unauthorized" }, 401));
    const host = new CliChatEngineHost({
      io: {
        run: vi.fn(async (_cmd: string, args: readonly string[]) => ({
          code: 0,
          stdout: args.includes("--version") ? "codex-cli 0.139.0" : "Logged in using ChatGPT"
        })),
        readFile: vi.fn().mockResolvedValue(""),
        writeFile: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn().mockResolvedValue(undefined)
      },
      neutralBase: "/tmp/neutral-base",
      homeBase: home,
      singleUser: false,
      cliPresent: async () => true,
      fetch: f
    });

    expect(await host.probeProvider("openai-compatible")).toMatchObject({ status: "ready" });

    const refused = await host.listProviderModels("openai-compatible");
    expect(refused).toMatchObject({ status: "not_logged_in" });
    expect(JSON.stringify(refused)).not.toContain(CODEX_TOKEN);

    expect(await host.probeProvider("openai-compatible")).toMatchObject({ status: "needs_login" });

    // Pressing Log in asks for a real check. It must not clear the refusal on its own: see the
    // dedicated test below, which drives recovery through a sign-in the vendor actually accepts.
    expect(await host.probeProvider("openai-compatible", { forceFresh: true })).toMatchObject({
      status: "needs_login"
    });
  });

  it("only lets a sign-in the vendor accepts clear a refused codex sign-in", async () => {
    // Round-3 review blocker 1: pressing Log in, or simply waiting five minutes, used to make the
    // refusal disappear and the SAME unchanged sign-in read as ready again - so the Log in button
    // could close the sign-in screen without anyone signing in. The local tool only reports that
    // it is holding a sign-in file, which a refused sign-in passes just as easily as a good one.
    const home = await homeWithCodexAuth();
    let vendorAccepts = false;
    const { f } = fakeFetch(async () =>
      vendorAccepts
        ? jsonResponse({ models: [{ slug: "gpt-5.6", visibility: "list" }] })
        : jsonResponse({ error: "unauthorized" }, 401)
    );
    const host = new CliChatEngineHost({
      io: {
        run: vi.fn(async (_cmd: string, args: readonly string[]) => ({
          code: 0,
          stdout: args.includes("--version") ? "codex-cli 0.139.0" : "Logged in using ChatGPT"
        })),
        readFile: vi.fn().mockResolvedValue(""),
        writeFile: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn().mockResolvedValue(undefined)
      },
      neutralBase: "/tmp/neutral-base",
      homeBase: home,
      singleUser: false,
      cliPresent: async () => true,
      fetch: f
    });

    expect(await host.probeProvider("openai-compatible")).toMatchObject({ status: "ready" });
    expect(await host.listProviderModels("openai-compatible")).toMatchObject({
      status: "not_logged_in"
    });
    expect(await host.probeProvider("openai-compatible")).toMatchObject({ status: "needs_login" });

    // Pressing Log in while the vendor still refuses the same sign-in.
    expect(await host.probeProvider("openai-compatible", { forceFresh: true })).toMatchObject({
      status: "needs_login"
    });

    // Waiting past the five minutes the saved answer used to live for changes nothing.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5 * 60_000 + 1;
      expect(await host.probeProvider("openai-compatible")).toMatchObject({
        status: "needs_login"
      });
    } finally {
      Date.now = realNow;
    }

    // The vendor accepting the sign-in for real is the one thing that recovers it.
    vendorAccepts = true;
    expect(await host.probeProvider("openai-compatible", { forceFresh: true })).toMatchObject({
      status: "ready"
    });
    expect(await host.probeProvider("openai-compatible")).toMatchObject({ status: "ready" });
  });
});
