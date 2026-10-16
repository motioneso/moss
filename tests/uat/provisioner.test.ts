import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type * as Net from "node:net";
import * as lifecycleRecords from "./lifecycle-records.js";
import {
  createLifecycleRecorder,
  type LifecycleAttempt,
  type LifecycleCapture
} from "./lifecycle-records.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1121 Task 4: pure arg-building coverage for buildSeedHookInput/composeSeedHook — no Docker.
// spawn is mocked so composeSeedHook's runCommand resolves immediately without touching a real
// process; only the args it was invoked with are asserted.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createServer: vi.fn()
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: vi.fn() }));
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof Net>()),
  createServer: mocks.createServer
}));

const {
  buildSeedHookInput,
  composeSeedHook,
  captureFailureEvidence,
  cleanupUatAttempt,
  provisionForUat
} = await import("./provisioner.js");

describe("#1121 Task 4: chatScript arg-building", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockReturnValue({
      stderr: { on: vi.fn() },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "exit") listener(0);
      }
    });
  });

  it("buildSeedHookInput threads chatScript from UatProvisionOptions", () => {
    const withChatScript = buildSeedHookInput("proj", "solo-admin", { chatScript: "phase1-smoke" });
    expect(withChatScript.chatScript).toBe("phase1-smoke");

    const without = buildSeedHookInput("proj", "solo-admin", {});
    expect(without.chatScript).toBeUndefined();
  });

  it("composeSeedHook always passes JARVIS_UAT_SEED_CHAT_SCRIPT, empty when chatScript is absent", async () => {
    await composeSeedHook({ projectName: "proj", level: "solo-admin" });

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    const index = args.indexOf("-e");
    const chatScriptArg = args.find((arg) => arg.startsWith("JARVIS_UAT_SEED_CHAT_SCRIPT="));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(chatScriptArg).toBe("JARVIS_UAT_SEED_CHAT_SCRIPT=");
  });

  it("composeSeedHook passes the chatScript id when set", async () => {
    await composeSeedHook({ projectName: "proj", level: "solo-admin", chatScript: "phase1-smoke" });

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    const chatScriptArg = args.find((arg) => arg.startsWith("JARVIS_UAT_SEED_CHAT_SCRIPT="));
    expect(chatScriptArg).toBe("JARVIS_UAT_SEED_CHAT_SCRIPT=phase1-smoke");
  });

  it("threads the opt-in #1909 public-source fixture seed", async () => {
    const input = buildSeedHookInput("proj", "admin+data", {
      withSportsPublicSourceFixtures: true
    });
    expect(input.sportsPublicSourceFixtures).toBe(true);
    await composeSeedHook(input);

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("JARVIS_UAT_SPORTS_PUBLIC_SOURCE_FIXTURES=1");
  });

  it("threads News fixture input only when provisioning provides its opt-in URL", async () => {
    const baseUrl = "http://proj-newsfixture:4319";
    const input = buildSeedHookInput(
      "proj",
      "admin+data",
      { withNewsFeedbackFixture: true },
      undefined,
      undefined,
      undefined,
      baseUrl
    );
    expect(input.newsFeedbackFixtureBaseUrl).toBe(baseUrl);
    await composeSeedHook(input);
    expect(mocks.spawn.mock.calls[0]?.[1]).toContain(
      `MOSS_UAT_NEWS_FEEDBACK_FIXTURE_BASE_URL=${baseUrl}`
    );
    expect(buildSeedHookInput("proj", "admin+data", {}).newsFeedbackFixtureBaseUrl).toBeUndefined();
  });

  it("starts ESPN-only provisioning without seeding a Job Search provider", async () => {
    const input = buildSeedHookInput(
      "proj",
      "admin+data",
      { withEspnFixture: true, chatScript: "phase1-smoke" },
      undefined
    );
    expect(input.jobSearchAiProviderBaseUrl).toBeUndefined();
    expect(input.chatScript).toBe("phase1-smoke");

    await composeSeedHook(input);

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("MOSS_UAT_JOB_SEARCH_AI_BASE_URL=");
    expect(args).toContain("JARVIS_UAT_SEED_CHAT_SCRIPT=phase1-smoke");
  });
});

describe("#3013: seed containers use their owned-stack guard, not outer authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockReturnValue({
      stderr: { on: vi.fn() },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "exit") listener(0);
      }
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["both markers", "1", "1"],
    ["legacy marker only", "1", undefined],
    ["Moss marker only", undefined, "1"],
    ["legacy marker with an invalid Moss marker", "1", "0"],
    ["Moss marker with an invalid legacy marker", "false", "1"],
    ["missing markers", undefined, undefined],
    ["empty markers", "", ""],
    ["false-like markers", "0", "false"],
    ["truthy but non-exact markers", "true", "yes"],
    ["whitespace around markers", " 1", "1 "]
  ])("does not forward %s into the owned stack", async (_label, jarvis, moss) => {
    vi.stubEnv("JARVIS_GATE_RUN", jarvis);
    vi.stubEnv("MOSS_GATE_RUN", moss);

    await composeSeedHook({ projectName: "uat-marker-test", level: "solo-admin" });

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    const envArgs = args.flatMap((arg, index) => (arg === "-e" ? [args[index + 1]] : []));
    expect(envArgs.filter((arg) => /^(JARVIS|MOSS)_GATE_RUN=/.test(arg!))).toHaveLength(0);
    expect(envArgs).toContain("JARVIS_UAT_SEED_CONFIRM=1");
    expect(args.slice(0, 5)).toEqual([
      "compose",
      "-p",
      "uat-marker-test",
      "-f",
      "infra/docker-compose.prod.yml"
    ]);
    expect(args.at(-1)).toBe("seed");
  });

  it("does not pass a direct-DB override, CI flag, or outer gate database target to seed", async () => {
    // Pure mocked-spawn coverage: these values never reach a Docker or database process.
    vi.stubEnv("JARVIS_GATE_RUN", undefined);
    vi.stubEnv("MOSS_GATE_RUN", undefined);
    vi.stubEnv("JARVIS_ALLOW_DIRECT_DB", "1");
    vi.stubEnv("CI", "true");
    vi.stubEnv("JARVIS_PGHOST", "outer-gate.invalid");
    vi.stubEnv("MOSS_PGHOST", "outer-gate.invalid");
    vi.stubEnv("JARVIS_APP_DATABASE_URL", "postgres://outer-gate.invalid/outer-gate");
    vi.stubEnv("MOSS_APP_DATABASE_URL", "postgres://outer-gate.invalid/outer-gate");

    await composeSeedHook({ projectName: "uat-marker-test", level: "solo-admin" });

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    const envArgs = args.flatMap((arg, index) => (arg === "-e" ? [args[index + 1]] : []));
    expect(envArgs.some((arg) => /^(JARVIS|MOSS)_GATE_RUN=/.test(arg!))).toBe(false);
    expect(
      envArgs.some((arg) =>
        /^(?:(?:JARVIS|MOSS)_(?:ALLOW_DIRECT_DB|PGHOST|APP_DATABASE_URL)|CI)=/.test(arg!)
      )
    ).toBe(false);
    expect(args.some((arg) => arg.includes("outer-gate.invalid"))).toBe(false);
  });
});

describe("#2164 r19: captureFailureEvidence transcript capture is not tail-truncated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockReturnValue({
      stdout: { on: vi.fn() },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "exit") listener(0);
      }
    });
  });

  it("captures each transcript's full content instead of tailing it", async () => {
    await captureFailureEvidence("proj", "180s timeout");

    const execCall = mocks.spawn.mock.calls.find((call) => (call[1] as string[]).includes("exec"));
    const shellScript = (execCall?.[1] as string[]).at(-1) ?? "";
    expect(shellScript).toContain('cat "$f"');
    expect(shellScript).not.toContain("tail -c");
  });
});

describe("#2732 P1-1: cleanupUatAttempt still verifies the stack after a failed credential wipe", () => {
  it("still tears down and checks for leaks when the credential cleanup step throws", async () => {
    const teardownCompose = vi
      .fn()
      .mockRejectedValue(new Error("[uat real-chat] credential cleanup failed for proj"));
    const assertNoLeaks = vi.fn().mockResolvedValue(undefined);
    const cleanupEnvFile = vi.fn();

    await expect(
      cleanupUatAttempt({ teardownCompose, assertNoLeaks, cleanupEnvFile })
    ).rejects.toThrow(/credential cleanup failed/);

    // A failed credential wipe must not skip the stack-wide leak check or the env file cleanup —
    // both still ran even though teardownCompose rejected.
    expect(assertNoLeaks).toHaveBeenCalledTimes(1);
    expect(cleanupEnvFile).toHaveBeenCalledTimes(1);
  });

  it("surfaces both a failed credential wipe and a leaked volume together, with no credential content", async () => {
    const teardownCompose = vi
      .fn()
      .mockRejectedValue(new Error("[uat real-chat] credential cleanup failed for proj"));
    const assertNoLeaks = vi
      .fn()
      .mockRejectedValue(
        new Error('UAT teardown leaked resources for proj: volumes=["proj_jarv1s-cli-auth"]')
      );
    const cleanupEnvFile = vi.fn();

    await expect(
      cleanupUatAttempt({ teardownCompose, assertNoLeaks, cleanupEnvFile })
    ).rejects.toThrow(AggregateError);
    expect(cleanupEnvFile).toHaveBeenCalledTimes(1);
  });
});

describe("N3 lifecycle cleanup boundaries", () => {
  it("records before credential teardown and after leak checks, before removing env identity", async () => {
    const order: string[] = [];
    await cleanupUatAttempt({
      beforeTeardown: async () => {
        order.push("before");
      },
      teardownCompose: async () => {
        order.push("credentials-and-resources");
      },
      assertNoLeaks: async () => {
        order.push("leaks");
      },
      afterTeardown: async () => {
        order.push("after");
      },
      cleanupEnvFile: () => {
        order.push("env");
      }
    });
    expect(order).toEqual(["before", "credentials-and-resources", "leaks", "after", "env"]);
  });

  it("aggregates both metadata failures with cleanup failures and still removes env last", async () => {
    const order: string[] = [];
    const fail = (stage: string) => async () => {
      order.push(stage);
      throw new Error(stage);
    };
    const error = await cleanupUatAttempt({
      beforeTeardown: fail("before"),
      teardownCompose: fail("teardown"),
      assertNoLeaks: fail("leaks"),
      afterTeardown: async (failed) => {
        expect(failed).toBe(true);
        await fail("after")();
      },
      cleanupEnvFile: () => {
        order.push("env");
      }
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "before",
      "teardown",
      "leaks",
      "after"
    ]);
    expect(order).toEqual(["before", "teardown", "leaks", "after", "env"]);
  });

  it("rejects partial opt-in before any provisioning effects", async () => {
    vi.stubEnv("JARVIS_UAT_LIFECYCLE_DIR", "/not-created");
    vi.stubEnv("JARVIS_UAT_LIFECYCLE_NONCE", undefined);
    mocks.createServer.mockImplementation(() => {
      throw new Error("unexpected port probe");
    });
    try {
      await expect(provisionForUat("bare")).rejects.toThrow(/lifecycle configuration/);
      expect(mocks.createServer).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// The fake implements only read-only metadata commands. Unexpected commands fail closed.
function lifecycleFixture() {
  const root = mkdtempSync(join(tmpdir(), "n3-lifecycle-"));
  const dir = join(root, "channel");
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(join(root, "infra"));
  mkdirSync(join(root, "tests", "uat"), { recursive: true });
  for (const path of [
    "Dockerfile",
    ".dockerignore",
    "infra/docker-compose.prod.yml",
    "tests/uat/compose.override.yml"
  ]) {
    writeFileSync(join(root, path), "frozen-input\n");
  }
  const env = {
    JARVIS_UAT_LIFECYCLE_DIR: dir,
    JARVIS_UAT_LIFECYCLE_NONCE: "ab".repeat(32),
    JARVIS_IMAGE_TAG: "uat-unique"
  };
  const attempt: LifecycleAttempt = {
    projectName: "uat-123_abcdef01",
    webPort: 5201,
    composeArgs: [
      "compose",
      "-p",
      "uat-123_abcdef01",
      "-f",
      "infra/docker-compose.prod.yml",
      "-f",
      "tests/uat/compose.override.yml"
    ]
  };
  const id = "1".repeat(64);
  const imageId = `sha256:${"2".repeat(64)}`;
  const reference = "ghcr.io/motioneso/moss:uat-unique";
  const labels = {
    "com.docker.compose.project": attempt.projectName,
    "com.docker.compose.project.working_dir": join(root, "infra"),
    "com.docker.compose.project.config_files": [
      join(root, "infra/docker-compose.prod.yml"),
      join(root, "tests/uat/compose.override.yml")
    ].join(","),
    "com.docker.compose.service": "jarv1s"
  };
  const app = {
    id,
    name: `/${attempt.projectName}-jarv1s-1`,
    created: new Date().toISOString(),
    labels,
    imageId,
    imageReference: reference,
    ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "5201" }] },
    Env: ["SECRET_SENTINEL"],
    Mounts: ["SECRET_SENTINEL"],
    transcript: "SECRET_SENTINEL"
  };
  const volumes = ["jarv1s-cli-auth", "jarv1s-sports-browser-socket", "jarv1s-vault-data"].map(
    (role) => ({
      id: `${attempt.projectName}_${role}`,
      name: `${attempt.projectName}_${role}`,
      created: app.created,
      labels: {
        "com.docker.compose.project": attempt.projectName,
        "com.docker.compose.volume": role
      },
      driver: "local",
      Options: { secret: "SECRET_SENTINEL" }
    })
  );
  const state = {
    built: false,
    appPresent: false,
    volumesPresent: false,
    daemon: "daemon-original",
    lookupError: false,
    inspectError: false,
    networkPresent: false,
    dirty: false,
    extra: false
  };
  const capture: LifecycleCapture = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === "git") {
      if (args.includes("--show-toplevel")) return root;
      if (args.includes("--porcelain")) return state.dirty ? " M Dockerfile" : "";
      if (args.includes("HEAD^{tree}")) return "4".repeat(40);
      if (args.includes("HEAD")) return "3".repeat(40);
    }
    if (command !== "docker") throw new Error("Unexpected executable");
    if (args[0] === "context" && args[1] === "show") return "default";
    if (args[0] === "context" && args[1] === "inspect")
      return JSON.stringify("unix:///var/run/docker.sock");
    if (args[0] === "info") return JSON.stringify(state.daemon);
    if (args[0] === "image" && args[1] === "ls") return state.built ? imageId : "";
    if (args[0] === "image" && args[1] === "inspect")
      return JSON.stringify({ id: imageId, created: app.created });
    if (args.includes("ls") || args[0] === "ps") {
      if (state.lookupError) throw new Error("SECRET_SENTINEL: lookup denied");
      if (args[0] === "volume")
        return state.volumesPresent
          ? volumes.map((v) => v.id).join("\n")
          : state.extra
            ? `${attempt.projectName}_unexpected-volume`
            : "";
      if (args[0] === "network") return state.networkPresent ? "5".repeat(64) : "";
      if (args.some((arg) => arg.startsWith("name="))) return "";
      return state.appPresent ? id : "";
    }
    if (args[1] === "inspect") {
      if (args[0] === "container") return JSON.stringify(app);
      if (args[0] === "network")
        return JSON.stringify({
          id: "5".repeat(64),
          name: `${app.labels["com.docker.compose.project"]}_jarv1s`,
          created: app.created,
          driver: "bridge",
          labels: {
            "com.docker.compose.project": app.labels["com.docker.compose.project"],
            "com.docker.compose.network": "jarv1s"
          }
        });
      if (args[0] === "volume") {
        if (state.inspectError && args[2] === volumes[0]!.id) throw new Error("SECRET_SENTINEL");
        return JSON.stringify(volumes.find((v) => v.id === args[2]));
      }
    }
    throw new Error(`Unexpected metadata command: ${args.slice(0, 2).join(" ")}`);
  });
  const records = () =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  return {
    root,
    dir,
    env,
    attempt,
    id,
    imageId,
    reference,
    app,
    volumes,
    state,
    capture,
    records,
    recorder: () => createLifecycleRecorder({ env, root, capture }),
    dispose: () => rmSync(root, { recursive: true, force: true })
  };
}

describe("N3 private lifecycle producer", () => {
  let f: ReturnType<typeof lifecycleFixture>;
  beforeEach(() => {
    f = lifecycleFixture();
  });
  afterEach(() => {
    f.dispose();
  });

  it("disabled opt-in performs no metadata queries or filesystem writes", async () => {
    const record = await createLifecycleRecorder({
      env: {},
      root: "/does-not-exist",
      capture: f.capture
    });
    await record("attempt-created", f.attempt);
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.records()).toEqual([]);
  });

  it.each([
    "partial",
    "empty",
    "nonce",
    "public",
    "symlink",
    "missing",
    "occupied",
    "build-disabled"
  ])("rejects %s configuration before queries or creation", async (which) => {
    if (which === "partial") delete (f.env as Partial<typeof f.env>).JARVIS_UAT_LIFECYCLE_NONCE;
    if (which === "empty") f.env.JARVIS_UAT_LIFECYCLE_DIR = "";
    if (which === "nonce") f.env.JARVIS_UAT_LIFECYCLE_NONCE = "invalid";
    if (which === "public") chmodSync(f.dir, 0o755);
    if (which === "symlink") {
      symlinkSync(f.dir, join(f.root, "alias"));
      f.env.JARVIS_UAT_LIFECYCLE_DIR = join(f.root, "alias");
    }
    if (which === "missing") f.env.JARVIS_UAT_LIFECYCLE_DIR = join(f.root, "missing");
    if (which === "occupied") writeFileSync(join(f.dir, "existing"), "untouched");
    if (which === "build-disabled") Object.assign(f.env, { JARVIS_UAT_BUILD: "0" });
    await expect(f.recorder()).rejects.toThrow(/lifecycle configuration/);
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("writes exclusive private monotonic digest-bound receipts and retains immutable app/auth/socket identities", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    f.state.appPresent = f.state.volumesPresent = true;
    await record("resources-created", f.attempt);
    await record("before-teardown", f.attempt);
    f.state.appPresent = f.state.volumesPresent = f.state.built = false;
    await record("after-teardown", f.attempt);
    const records = f.records();
    expect(records.map((r) => r.phase)).toEqual([
      "attempt-created",
      "image-built",
      "resources-created",
      "before-teardown",
      "after-teardown"
    ]);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (const [i, r] of records.entries()) {
      const { digest, ...body } = r;
      expect(digest).toBe(createHash("sha256").update(JSON.stringify(body)).digest("hex"));
      expect(r.previousDigest).toBe(i ? records[i - 1].digest : null);
      expect(r.nonce).toBe("ab".repeat(32));
      expect(r.source.commit).toBe("3".repeat(40));
      expect(r.producer.pid).toBeGreaterThan(0);
    }
    for (const file of readdirSync(f.dir))
      expect(statSync(join(f.dir, file)).mode & 0o777).toBe(0o600);
    const final = records.at(-1);
    expect(final.complete).toBe(true);
    expect(final.image.id).toBe(f.imageId);
    expect(final.inventory.map((r: { id: string }) => r.id)).toEqual([
      f.id,
      ...f.volumes.map((v) => v.id)
    ]);
    expect(
      final.inventory.every(
        (r: { observation: { state: string } }) => r.observation.state === "absent"
      )
    ).toBe(true);
    expect(final.inventory[0].creation.imageId).toBe(f.imageId);
    expect(final.inventory[0].creation.imageReference).toBe(f.reference);
    expect(JSON.stringify(records)).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify(records)).not.toContain('"Env"');
    expect(JSON.stringify(records)).not.toContain('"Mounts"');
  });

  it("preserves partial creation on failed attempt and retains it across a fresh retry", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    f.state.volumesPresent = true;
    const failed = { ...f.attempt, failed: true };
    await record("resources-created", failed);
    await record("before-teardown", failed);
    f.state.volumesPresent = false;
    await record("after-teardown", failed);
    const retry = {
      ...f.attempt,
      projectName: "uat-124_abcdef02",
      composeArgs: f.attempt.composeArgs.map((a) =>
        a === f.attempt.projectName ? "uat-124_abcdef02" : a
      )
    };
    await record("attempt-created", retry);
    await record("image-built", retry);
    const records = f.records();
    expect(records[4].complete).toBe(false);
    expect(records[4].inventory).toHaveLength(3);
    expect(records[5].attempt.number).toBe(2);
    expect(records[5].inventory).toEqual([]);
    expect(records[6].image.id).toBe(f.imageId);
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("rejects a preexisting tag before any build or creation", async () => {
    f.state.built = true;
    const record = await f.recorder();
    await expect(record("attempt-created", f.attempt)).rejects.toThrow(/lifecycle/);
    expect(f.records()[0].errors).toContain("image-tag-not-absent");
  });

  it("writes an error observation instead of absence on selected-daemon lookup failure", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    f.state.appPresent = true;
    await record("resources-created", f.attempt);
    await record("before-teardown", f.attempt);
    f.state.lookupError = true;
    await expect(record("after-teardown", f.attempt)).rejects.toThrow(/lifecycle/);
    const final = f.records().at(-1);
    expect(final.complete).toBe(false);
    expect(final.inventory[0].observation.state).toBe("error");
    expect(final.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(final)).not.toContain("SECRET_SENTINEL");
  });

  it.each(["daemon", "image", "port", "source", "compose"])(
    "rejects changed %s identity before a passing receipt",
    async (which) => {
      const record = await f.recorder();
      await record("attempt-created", f.attempt);
      f.state.built = true;
      await record("image-built", f.attempt);
      f.state.appPresent = true;
      if (which === "daemon") f.state.daemon = "daemon-switched";
      if (which === "image") f.app.imageId = `sha256:${"9".repeat(64)}`;
      if (which === "port") f.app.ports["3000/tcp"][0]!.HostPort = "5202";
      if (which === "source") f.state.dirty = true;
      if (which === "compose")
        f.app.labels["com.docker.compose.project.config_files"] = "/different.yml";
      await expect(record("resources-created", f.attempt)).rejects.toThrow(/lifecycle/);
      expect(f.records().at(-1).complete).toBe(false);
    }
  );

  it("requires current app identity before readiness can be released", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    await expect(record("resources-created", { ...f.attempt, requireApp: true })).rejects.toThrow(
      /lifecycle/
    );
    expect(f.records().at(-1).errors).toContain("app-build-proof-missing");
  });

  it("requires app/build proof on a successful attempt before teardown", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    await expect(record("before-teardown", f.attempt)).rejects.toThrow(/lifecycle/);
    expect(f.records().at(-1).errors).toContain("app-build-proof-missing");
  });

  it.each(["image-built", "invented"])(
    "rejects out-of-order or unknown %s and permanently fails that stream",
    async (phase) => {
      const record = await f.recorder();
      await expect(record(phase as never, f.attempt)).rejects.toThrow(/lifecycle/);
      await expect(record("attempt-created", f.attempt)).rejects.toThrow(/lifecycle/);
      expect(f.records().at(-1).errors).toContain("prior-record-failure");
    }
  );

  it("does not overwrite a record nominated by the channel owner", async () => {
    const record = await f.recorder();
    writeFileSync(join(f.dir, "000001.json"), "preserved", { mode: 0o600 });
    await expect(record("attempt-created", f.attempt)).rejects.toThrow(/lifecycle/);
    expect(readFileSync(join(f.dir, "000001.json"), "utf8")).toBe("preserved");
  });

  it("fails same-daemon absence verification even when every saved resource disappeared", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    f.state.appPresent = true;
    await record("resources-created", f.attempt);
    await record("before-teardown", f.attempt);
    f.state.appPresent = false;
    f.state.daemon = "wrong-daemon";
    await expect(record("after-teardown", f.attempt)).rejects.toThrow(/lifecycle/);
    expect(f.records().at(-1).inventory[0].observation.state).toBe("error");
  });

  it("retains every discovered identity when one inspection fails, and positively observes absence later", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    f.state.volumesPresent = f.state.inspectError = true;
    await expect(record("resources-created", { ...f.attempt, failed: true })).rejects.toThrow(
      /lifecycle/
    );
    const partial = f.records().at(-1);
    expect(partial.inventory.map((r: { id: string }) => r.id)).toEqual(f.volumes.map((v) => v.id));
    expect(partial.inventory[0].creation).toBeNull();
    expect(partial.inventory[0].observation.state).toBe("error");
    await expect(record("before-teardown", { ...f.attempt, failed: true })).rejects.toThrow(
      /lifecycle/
    );
    f.state.volumesPresent = false;
    await expect(record("after-teardown", { ...f.attempt, failed: true })).rejects.toThrow(
      /lifecycle/
    );
    expect(
      f
        .records()
        .at(-1)
        .inventory.every(
          (r: { observation: { state: string } }) => r.observation.state === "absent"
        )
    ).toBe(true);
  });

  it("reports extra project residuals without treating them as deletion authority", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    f.state.appPresent = true;
    await record("resources-created", f.attempt);
    await record("before-teardown", f.attempt);
    f.state.appPresent = false;
    f.state.extra = true;
    await expect(record("after-teardown", f.attempt)).rejects.toThrow(/lifecycle/);
    expect(f.records().at(-1).residuals).toEqual([
      { kind: "volume", id: `${f.attempt.projectName}_unexpected-volume` }
    ]);
    expect(f.records().at(-1).complete).toBe(false);
  });

  it("retains the exact network identity and reports a surviving network", async () => {
    const record = await f.recorder();
    await record("attempt-created", f.attempt);
    f.state.built = true;
    await record("image-built", f.attempt);
    f.state.networkPresent = true;
    await record("resources-created", { ...f.attempt, failed: true });
    await record("before-teardown", { ...f.attempt, failed: true });
    await expect(record("after-teardown", { ...f.attempt, failed: true })).rejects.toThrow(
      /lifecycle/
    );
    const row = f.records().at(-1).inventory[0];
    expect(row.kind).toBe("network");
    expect(row.id).toBe("5".repeat(64));
    expect(row.creation.driver).toBe("bridge");
    expect(row.observation.state).toBe("present");
  });

  it("rejects a changed channel mode before publication", async () => {
    const record = await f.recorder();
    chmodSync(f.dir, 0o755);
    await expect(record("attempt-created", f.attempt)).rejects.toThrow(/lifecycle/);
    expect(f.records()).toEqual([]);
  });

  it("scrubs malformed endpoint output before it can reach an error", async () => {
    const capture: LifecycleCapture = async (command, args, env, root) =>
      args[0] === "context" && args[1] === "inspect"
        ? "SECRET_SENTINEL"
        : f.capture(command, args, env, root);
    const error = await createLifecycleRecorder({ env: f.env, root: f.root, capture }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("SECRET_SENTINEL");
  });
});

describe("N3 provisioner integration with fake Docker/ports/auth/health", () => {
  let f: ReturnType<typeof lifecycleFixture>;
  let events: string[];
  let failPhase: string | undefined;
  let failedOnce: boolean;
  let conflict: boolean;
  let appStarts: number;
  let cleanupFails: boolean;
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(async () => {
    savedEnv = { ...process.env };
    f = lifecycleFixture();
    events = [];
    failedOnce = false;
    conflict = false;
    appStarts = 0;
    cleanupFails = false;
    failPhase = undefined;
    vi.stubEnv("JARVIS_IMAGE_TAG", "uat-unique");
    vi.stubEnv("JARVIS_UAT_BUILD", "1");
    vi.stubEnv("UAT_DOCKER_SUBNET", undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => {
      events.push("ready");
      return new Response(JSON.stringify({ ok: true, db: "ok", pgboss: "ok" }));
    });
    const record = await f.recorder();
    vi.spyOn(lifecycleRecords, "createLifecycleRecorder").mockResolvedValue(
      async (phase, input) => {
        events.push(phase);
        if (phase === "attempt-created") {
          f.app.name = `/${input.projectName}-jarv1s-1`;
          f.app.labels["com.docker.compose.project"] = input.projectName;
          f.app.ports["3000/tcp"][0]!.HostPort = String(input.webPort);
          for (const v of f.volumes) {
            v.id = `${input.projectName}_${v.labels["com.docker.compose.volume"]}`;
            v.name = v.id;
            v.labels["com.docker.compose.project"] = input.projectName;
          }
        }
        if (phase === failPhase && !failedOnce) {
          failedOnce = true;
          throw new Error(`injected-${phase}`);
        }
        await record(phase, input);
      }
    );
    mocks.createServer.mockImplementation(() => ({
      once: () => {},
      listen: (_port: number, _host: string, fn: () => void) => fn(),
      close: (fn: () => void) => fn()
    }));
    mocks.spawn.mockImplementation((_command: string, args: string[]) => {
      let rc = 0;
      let stderr = "";
      if (args[0] === "build") {
        events.push("build");
        f.state.built = true;
      }
      if (args.includes("up") && args.includes("postgres")) f.state.volumesPresent = true;
      if (args.includes("up") && args.includes("jarv1s")) {
        appStarts++;
        if (conflict && appStarts === 1) {
          rc = 1;
          stderr = "address already in use";
        } else f.state.appPresent = true;
      }
      if (args.includes("down")) {
        events.push("delete-resources");
        f.state.appPresent = f.state.volumesPresent = false;
      }
      return {
        stderr: {
          on: (_event: string, fn: (chunk: Buffer) => void) => {
            if (stderr) fn(Buffer.from(stderr));
          }
        },
        stdout: { on: () => {} },
        on: (event: string, fn: (code: number) => void) => {
          if (event === "exit") fn(rc);
        }
      };
    });
  });
  afterEach(() => {
    f.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  const provision = () =>
    provisionForUat("bare", undefined, {
      listLiveSubnets: async () => [],
      installRealChatAuth: () => ({
        cleanup: async () => {
          events.push("credentials");
          if (cleanupFails) throw new Error("credential-cleanup-error");
        }
      })
    });

  it("awaits image and resource receipts before readiness, then observes after credential/resource cleanup", async () => {
    const run = await provision();
    expect(f.records().map((r) => r.phase)).toContain("image-built");
    expect(events.indexOf("image-built")).toBeLessThan(events.indexOf("ready"));
    await run.teardown();
    expect(events.indexOf("before-teardown")).toBeLessThan(events.indexOf("credentials"));
    expect(events.indexOf("after-teardown")).toBeGreaterThan(events.indexOf("delete-resources"));
    expect(f.records().at(-1).complete).toBe(true);
  });

  it.each([
    "attempt-created",
    "image-built",
    "resources-created",
    "before-teardown",
    "after-teardown"
  ])("makes a failed %s boundary nonzero while still cleaning resources", async (phase) => {
    failPhase = phase;
    const result = await provision()
      .then((run) => run.teardown())
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(events).toContain("delete-resources");
    expect(events).toContain("after-teardown");
    expect(f.state.appPresent).toBe(false);
    if (["attempt-created", "image-built", "resources-created"].includes(phase))
      expect(events).not.toContain("ready");
  });

  it("retains partial creation and separate retry inventory while building once", async () => {
    conflict = true;
    const run = await provision();
    await run.teardown();
    const records = f.records();
    const finals = records.filter((r) => r.phase === "after-teardown");
    expect(finals).toHaveLength(2);
    expect(finals[0].attempt.failed).toBe(true);
    expect(finals[0].complete).toBe(false);
    expect(finals[0].inventory).toHaveLength(3);
    expect(finals[1].attempt.number).toBe(2);
    expect(finals[1].complete).toBe(true);
    expect(events.filter((e) => e === "build")).toHaveLength(1);
    expect(records.filter((r) => r.phase === "resources-created" && r.attempt.failed)).toHaveLength(
      1
    );
  });

  it("publishes after-teardown even on credential cleanup error and marks it incomplete", async () => {
    cleanupFails = true;
    const run = await provision();
    await expect(run.teardown()).rejects.toThrow(/credential-cleanup-error/);
    const final = f.records().at(-1);
    expect(final.phase).toBe("after-teardown");
    expect(final.complete).toBe(false);
    expect(
      final.inventory.every(
        (r: { observation: { state: string } }) => r.observation.state === "absent"
      )
    ).toBe(true);
  });
});
