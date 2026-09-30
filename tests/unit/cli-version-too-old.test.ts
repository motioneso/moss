import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Multiplexer, TmuxIo } from "@moss/ai";

import {
  cliToolsDto,
  readCliToolVersions,
  type CliToolVersions
} from "../../packages/ai/src/cli-tool-versions.js";
import { serializeProvider } from "../../packages/ai/src/routes.js";
import {
  CLI_VERSION_TOO_OLD_MESSAGE,
  isCliVersionTooOldError,
  isCliVersionTooOldReply,
  isCliVersionTooOldText
} from "../../packages/chat/src/live/cli-version-errors.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import { ClaudePrintChatEngine } from "../../packages/chat/src/live/structured-claude-engine.js";
import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import { InstallService } from "../../packages/cli-runner/src/install-service.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual("node:child_process")),
  spawn: spawnMock
}));

const REFUSAL =
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"This model requires Claude Code version 2.1.280 or newer is required"}}';

function fakeChild() {
  const listeners = new Map<string, Array<(code?: number | null) => void>>();
  const child = {
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => true),
    on: vi.fn((event: string, callback: (code?: number | null) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      return child;
    }),
    once: vi.fn((event: string, callback: (code?: number | null) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      return child;
    }),
    unref: vi.fn(),
    emit(event: string, code: number | null) {
      listeners.get(event)?.forEach((listener) => listener(code));
    },
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  };
  return child;
}

function fakeIo(): TmuxIo {
  const files: Record<string, string> = {};
  return {
    async run() {
      return { code: 0, stdout: "" };
    },
    async readFile(file) {
      const value = files[file];
      if (value === undefined) throw new Error(`missing ${file}`);
      return value;
    },
    async writeFile(file, content) {
      files[file] = content;
    },
    async sleep() {}
  };
}

const fakeMux = { kind: "tmux" } as unknown as Multiplexer;

const flush = () => new Promise((resolve) => setImmediate(resolve));

let child: ReturnType<typeof fakeChild>;

beforeEach(() => {
  child = fakeChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
});

describe("#2689 version-too-old matchers", () => {
  it("matches the provider refusal and nothing ordinary", () => {
    expect(isCliVersionTooOldText(REFUSAL)).toBe(true);
    expect(isCliVersionTooOldText("Claude Code 2.1.183")).toBe(false);
    expect(isCliVersionTooOldReply(REFUSAL)).toBe(true);
    // A model that merely quotes the phrase is not a provider error.
    expect(isCliVersionTooOldReply("Sure: version 2.1.280 or newer is required")).toBe(false);
  });

  it("reads the JSON-RPC data detail on an error", () => {
    const error = Object.assign(new Error("Internal error"), {
      data: { details: "version 2.1.280 or newer is required" }
    });
    expect(isCliVersionTooOldError(error)).toBe(true);
    expect(isCliVersionTooOldError(new Error("Internal error"))).toBe(false);
  });
});

describe("#2689 one-shot claude engine", () => {
  async function launched() {
    const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
      mux: fakeMux,
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000001"
    });
    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona"
    });
    await engine.submit("hello");
    return engine;
  }

  it("throws the plain message when the tool exits refusing the model", async () => {
    const engine = await launched();
    child.stdout.write(`${REFUSAL}\n`);
    await flush();
    child.emit("close", 1);

    const error = await engine.readNew(0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliChatUnavailableError);
    expect((error as Error).message).toBe(CLI_VERSION_TOO_OLD_MESSAGE);
  });

  it("ignores the phrase on a clean exit", async () => {
    const engine = await launched();
    child.stdout.write(`${REFUSAL}\n`);
    await flush();
    child.emit("close", 0);

    const error = await engine.readNew(0).catch((e: unknown) => e);
    expect((error as Error | undefined)?.message).not.toBe(CLI_VERSION_TOO_OLD_MESSAGE);
  });
});

describe("#2689 structured claude engine", () => {
  it("throws the plain message on an error result record", async () => {
    const engine = new ClaudePrintChatEngine("structured-scope", fakeIo(), {
      mux: fakeMux,
      homeBase: "/home/test"
    });
    await engine.launchStructured({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona",
      schema: { type: "object" }
    });
    await engine.submitStructured("go");
    child.stdout.write(`${JSON.stringify({ type: "result", is_error: true, result: REFUSAL })}\n`);
    await flush();

    await expect(engine.readStructured(0)).rejects.toThrow(CLI_VERSION_TOO_OLD_MESSAGE);
    await engine.kill();
  });
});

describe("#2689 installed versions", () => {
  let toolsPrefix: string;

  beforeEach(async () => {
    toolsPrefix = await mkdtemp(path.join(tmpdir(), "jarv1s-tools-"));
  });
  afterEach(async () => {
    await rm(toolsPrefix, { recursive: true, force: true });
  });

  it("reads the version behind the current link and reports missing tools as null", async () => {
    const recipe = PROVIDER_CATALOG.anthropic.recipe;
    if (recipe?.kind !== "npm") throw new Error("anthropic recipe is not npm");
    const providerDir = path.join(toolsPrefix, "providers", "anthropic");
    const pkgDir = path.join(providerDir, "releases", "r1", "node_modules", recipe.pkg);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: recipe.pkg, version: "2.1.183" })
    );
    await symlink("releases/r1", path.join(providerDir, "current"));

    const svc = new InstallService({
      io: fakeIo(),
      catalog: PROVIDER_CATALOG,
      toolsPrefix,
      homeBase: toolsPrefix
    });
    const { providers, opencode } = await svc.toolVersions();
    expect(providers).toEqual({ anthropic: "2.1.183", "openai-compatible": null, google: null });
    // The image's OpenCode package is a workspace dependency, so its version is readable here.
    expect(opencode).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("#2689 provider versions on the list route", () => {
  const versions: CliToolVersions = {
    providers: { anthropic: "2.1.183", "openai-compatible": null, google: null },
    opencode: "1.0.0"
  };

  it("gives up on a failed or slow runner", async () => {
    expect(await readCliToolVersions(undefined)).toBeUndefined();
    expect(await readCliToolVersions(() => Promise.reject(new Error("down")))).toBeUndefined();
    expect(await readCliToolVersions(() => new Promise(() => undefined), 10)).toBeUndefined();
    expect(await readCliToolVersions(async () => versions)).toEqual(versions);
  });

  it("adds cliTools only to command-line providers", async () => {
    const row = {
      id: "p1",
      provider_kind: "anthropic",
      display_name: "Claude",
      base_url: null,
      status: "active",
      auth_method: "cli",
      execution_mode: "cli",
      has_credential: false,
      is_instance_default: false
    } as unknown as Parameters<typeof serializeProvider>[0];

    expect((await serializeProvider(row, versions)).cliTools).toEqual({
      version: "2.1.183",
      state: "current"
    });
    expect((await serializeProvider(row)).cliTools).toBeUndefined();
    expect(
      (await serializeProvider({ ...row, auth_method: "api_key" }, versions)).cliTools
    ).toBeUndefined();
    expect(cliToolsDto(null)).toEqual({ version: null, state: "not_installed" });
  });
});
