import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bareSeedHook,
  buildSeedHookInput,
  buildUatComposeArgs,
  cleanupUatAttempt,
  createUatProvisionPlan,
  expectedUatVolumeNames,
  jobSearchFixtureBaseUrlFor,
  jobSearchFixtureContainerName,
  findAvailablePort,
  generateUatRunId,
  provisionForUat,
  UAT_PORT_RANGE_START,
  UAT_PORT_RANGE_SIZE,
  uatComposeInterpolationEnv,
  writeUatEnvFile
} from "../uat/provisioner.js";

const TEST_SUBNET = "10.249.0.0/24";

const originalRequestedSubnet = process.env.UAT_DOCKER_SUBNET;
const originalRealChatEnvFile = process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE;
const originalTmpDir = process.env.TMPDIR;

afterEach(() => {
  if (originalRequestedSubnet === undefined) delete process.env.UAT_DOCKER_SUBNET;
  else process.env.UAT_DOCKER_SUBNET = originalRequestedSubnet;
  if (originalRealChatEnvFile === undefined) delete process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE;
  else process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE = originalRealChatEnvFile;
  if (originalTmpDir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpDir;
});

describe("provisionForUat setup cleanup", () => {
  it("restores run-scoped state when the requested production subnet is refused", async () => {
    const cleanup = vi.fn();
    process.env.UAT_DOCKER_SUBNET = "10.252.0.0/24";
    process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE = "sentinel-original-env-file";

    await expect(
      provisionForUat(
        "bare",
        { chatScript: "phase1-smoke" },
        {
          listLiveSubnets: async () => [],
          writeRealChatEnvFile: async () => {
            process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE = "/tmp/decrypted-real-chat.env";
            return { path: "/tmp/decrypted-real-chat.env", cleanup };
          }
        }
      )
    ).rejects.toThrow(/10\.252\.0\.0\/24.*production/i);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE).toBe("sentinel-original-env-file");
  });

  it("restores run-scoped state when live subnet discovery fails", async () => {
    const cleanup = vi.fn();

    await expect(
      provisionForUat(
        "bare",
        { chatScript: "phase1-smoke" },
        {
          listLiveSubnets: async () => {
            throw new Error("malformed Docker inspect state");
          },
          writeRealChatEnvFile: async () => ({
            path: "/tmp/decrypted-real-chat.env",
            cleanup
          })
        }
      )
    ).rejects.toThrow(/malformed Docker inspect state/i);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves both setup and credential-cleanup failures", async () => {
    const setupError = new Error("malformed Docker inspect state");
    const cleanupError = new Error("credential cleanup failed");
    process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE = "sentinel-original-env-file";

    const failure = await provisionForUat(
      "bare",
      { chatScript: "phase1-smoke" },
      {
        listLiveSubnets: async () => {
          throw setupError;
        },
        writeRealChatEnvFile: async () => {
          process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE = "/tmp/decrypted-real-chat.env";
          return {
            path: "/tmp/decrypted-real-chat.env",
            cleanup: () => {
              throw cleanupError;
            }
          };
        }
      }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([setupError, cleanupError]);
    expect(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE).toBe("sentinel-original-env-file");
  });

  it("restores run-scoped state when the UAT env file cannot be created", async () => {
    const cleanup = vi.fn();
    process.env.TMPDIR = "/definitely-missing-uat-temp-root";
    process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE = "sentinel-original-env-file";

    await expect(
      provisionForUat(
        "bare",
        { chatScript: "phase1-smoke" },
        {
          listLiveSubnets: async () => [],
          writeRealChatEnvFile: async () => {
            process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE = "/tmp/decrypted-real-chat.env";
            return { path: "/tmp/decrypted-real-chat.env", cleanup };
          }
        }
      )
    ).rejects.toThrow();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE).toBe("sentinel-original-env-file");
  });
});

describe("cleanupUatAttempt", () => {
  it("deletes both env files without hiding a leak-assertion failure", async () => {
    const leakError = new Error("owned UAT network remains");
    const cleanupEnvFile = vi.fn();
    const cleanupRunScopedState = vi.fn();

    await expect(
      cleanupUatAttempt({
        teardownCompose: async () => {},
        assertNoLeaks: async () => {
          throw leakError;
        },
        cleanupEnvFile,
        cleanupRunScopedState
      })
    ).rejects.toBe(leakError);

    expect(cleanupEnvFile).toHaveBeenCalledOnce();
    expect(cleanupRunScopedState).toHaveBeenCalledOnce();
  });
});

describe("generateUatRunId", () => {
  it("produces a docker-safe project name prefixed uat-", () => {
    const { projectName, suffix } = generateUatRunId();
    expect(projectName).toBe(`uat-${suffix}`);
    // Compose project names must be lowercase alphanumeric + separators only.
    expect(projectName).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  it("generates distinct ids across calls (no collision on concurrent runs)", () => {
    const a = generateUatRunId();
    const b = generateUatRunId();
    expect(a.projectName).not.toBe(b.projectName);
  });
});

describe("reserved ranges", () => {
  it("reserves a 100-port UAT range starting at 20000, above the prod default (1533)", () => {
    expect(UAT_PORT_RANGE_START).toBe(20000);
    expect(UAT_PORT_RANGE_SIZE).toBe(100);
  });
});

describe("findAvailablePort", () => {
  it("returns the first candidate that is actually free", async () => {
    const port = await findAvailablePort([20000, 20001], async (p) => p === 20001);
    expect(port).toBe(20001);
  });

  it("skips a port that is really bound (EADDRINUSE) and returns the next", async () => {
    const server = createServer();
    await new Promise<void>((resolvePromise) => server.listen(20050, "127.0.0.1", resolvePromise));
    try {
      const port = await findAvailablePort([20050, 20051]);
      expect(port).toBe(20051);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it("throws when no candidate is free", async () => {
    await expect(findAvailablePort([20060], async () => false)).rejects.toThrow(
      /no available port/i
    );
  });
});

describe("writeUatEnvFile", () => {
  it("writes an env file pinning the chosen port, UAT subnet, and a stub embed provider", () => {
    const { path, cleanup } = writeUatEnvFile({ webPort: 20077, subnet: TEST_SUBNET });
    try {
      const contents = readFileSync(path, "utf8");
      expect(contents).toContain("JARVIS_WEB_PORT=20077");
      expect(contents).toContain(`JARVIS_DOCKER_SUBNET=${TEST_SUBNET}`);
      // #1024/#1000: bare level has no users/data to embed, so the stub provider avoids an
      // unnecessary model download on every ephemeral run (spec §3.3 model-cache-volume note).
      expect(contents).toContain("JARVIS_EMBED_PROVIDER=stub");
      // #1313: NODE_ENV=production here means createEmbeddingProvider's test/dev gate would
      // otherwise refuse "stub" and silently fall back to "local" — this escape hatch is what
      // actually keeps the stub provider (not a real model download) in effect for this instance.
      expect(contents).toContain("JARVIS_ALLOW_STUB_EMBEDDINGS=1");
      expect(contents).toContain(
        "JARVIS_NOTES_ROOTS=/data/vaults/00000000-0000-4000-8000-000000000001"
      );
      expect(contents).toContain("JARVIS_MIGRATION_DATABASE_URL=");
      // #1024/#1000: NODE_ENV=production means resolveKeyring enforces this (>=32 bytes) since
      // #918 Slice 2 — a real boot crash Task 7's live run caught (JARVIS_MODULE_CREDENTIAL_SECRET_KEY
      // is required in production and any non-development/test NODE_ENV).
      expect(contents).toContain("JARVIS_MODULE_CREDENTIAL_SECRET_KEY=");
      expect(contents).toContain("JARVIS_NEWS_CREDENTIAL_SECRET_KEY=");
      // #2173: resolveKeyring enforces this the same way, and the cached-image repro's real
      // crash was this key specifically ("JARVIS_INTEGRATIONS_SECRET_KEY is required in
      // production and any non-development/test NODE_ENV").
      expect(contents).toContain("JARVIS_INTEGRATIONS_SECRET_KEY=");
      expect(
        contents.match(/JARVIS_INTEGRATIONS_SECRET_KEY=(\S+)/)?.[1]?.length
      ).toBeGreaterThanOrEqual(32);
    } finally {
      cleanup();
    }
  });

  it("omits JARVIS_RUNTIME_MODE and JARVIS_E2E_MODULE_FETCH_BASE when no fixture URL is given", () => {
    // #1306 Task 22: these two vars may never appear in a checked-in compose file, .env.example,
    // or dev script — provisioner-only, and only when a caller opts in.
    const { path, cleanup } = writeUatEnvFile({ webPort: 20078, subnet: TEST_SUBNET });
    try {
      const contents = readFileSync(path, "utf8");
      expect(contents).not.toContain("JARVIS_RUNTIME_MODE");
      expect(contents).not.toContain("JARVIS_E2E_MODULE_FETCH_BASE");
    } finally {
      cleanup();
    }
  });

  it("writes both fetch-bypass vars together when a fixture URL is given", () => {
    const { path, cleanup } = writeUatEnvFile({
      webPort: 20079,
      subnet: TEST_SUBNET,
      jobSearchFixtureBaseUrl: "http://uat-1_abcd1234-jsfixture:8080"
    });
    try {
      const contents = readFileSync(path, "utf8");
      expect(contents).toContain("JARVIS_RUNTIME_MODE=e2e");
      expect(contents).toContain(
        "JARVIS_E2E_MODULE_FETCH_BASE=http://uat-1_abcd1234-jsfixture:8080"
      );
    } finally {
      cleanup();
    }
  });

  it("writes JARVIS_UAT_SCRIPTED_PROVIDER_BIN when a chat script is given", () => {
    // #1659 defect 4: a dedicated PATH entry, never JARVIS_CLI_TOOLS_PREFIX itself — that var
    // doubles as the production installer's toolsPrefix, so pointing it at the fixture let
    // reconcileInstalledProviders() clobber the fixture's own bin/claude with the real CLI on
    // every container boot.
    const { path, cleanup } = writeUatEnvFile({
      webPort: 20080,
      subnet: TEST_SUBNET,
      chatScript: "phase1-smoke"
    });
    try {
      const contents = readFileSync(path, "utf8");
      expect(contents).toContain(
        "JARVIS_UAT_SCRIPTED_PROVIDER_BIN=/app/tests/uat/fixtures/scripted-provider/bin"
      );
    } finally {
      cleanup();
    }
  });

  it("omits JARVIS_UAT_SCRIPTED_PROVIDER_BIN when no chat script is given", () => {
    const { path, cleanup } = writeUatEnvFile({ webPort: 20081, subnet: TEST_SUBNET });
    try {
      const contents = readFileSync(path, "utf8");
      expect(contents).not.toContain("JARVIS_UAT_SCRIPTED_PROVIDER_BIN");
    } finally {
      cleanup();
    }
  });
});

describe("job-search fixture origin addressing", () => {
  // #1306 Task 22: the fixture origin is a container on the stack's own Compose network, NOT a
  // host process reached through the bridge gateway. The gateway route was tried live and every
  // crawl fetch timed out — ufw drops container traffic arriving at the host's gateway address —
  // so a host-derived address reappearing here is a regression, not a refactor.
  it("addresses the fixture by container name, never by a host or bridge-gateway address", () => {
    const { projectName } = generateUatRunId();
    const url = jobSearchFixtureBaseUrlFor(projectName);

    expect(url).toBe(`http://${jobSearchFixtureContainerName(projectName)}:8080`);
    expect(url).not.toContain("127.0.0.1");
    expect(url).not.toContain("localhost");
    expect(url).not.toContain(TEST_SUBNET.split("/")[0]?.replace(/\.0$/, "") ?? "");
  });

  it("scopes the container name to the Compose project so concurrent runs never collide", () => {
    const first = jobSearchFixtureContainerName(generateUatRunId().projectName);
    const second = jobSearchFixtureContainerName(generateUatRunId().projectName);

    expect(first).not.toBe(second);
    // assertNoLeakedResources filters `docker ps -a` by the project name, so a leaked fixture
    // container has to be caught by that same filter.
    expect(first.startsWith("uat-")).toBe(true);
  });
});

describe("uatComposeInterpolationEnv", () => {
  it("exports the same values the env file carries, for compose-file ${...} interpolation", () => {
    // #1024/#1000: env_file: never feeds compose YAML interpolation — only container env. Every
    // key here must match a `${KEY...}` reference in infra/docker-compose.prod.yml or the
    // provisioner would silently fall back to prod's port/subnet defaults, or hard-fail on the
    // two `:?`-required secrets (POSTGRES_PASSWORD, JARVIS_CLI_RUNNER_RPC_SECRET).
    const env = uatComposeInterpolationEnv({ webPort: 20077, subnet: TEST_SUBNET });
    expect(env.JARVIS_WEB_PORT).toBe("20077");
    expect(env.JARVIS_DOCKER_SUBNET).toBe(TEST_SUBNET);
    expect(env.POSTGRES_PASSWORD).toBeTruthy();
    expect(env.JARVIS_CLI_RUNNER_RPC_SECRET).toBeTruthy();
    // #1468 (B2): restartUatStack's `docker compose restart jarv1s` reruns the container's
    // already-materialized env — the bootstrap-owner confirmation must be interpolated at the
    // earlier `up -d jarv1s --wait` step, or module-reconcile.ts's boot one-shot refuses.
    expect(env.MOSS_RECONCILE_CONFIRM_OWNER_EMAIL).toBe("uat-admin@jarv1s.local");
  });
});

describe("bareSeedHook", () => {
  it("is a no-op that resolves without touching the database", async () => {
    await expect(bareSeedHook({ projectName: "uat-test", level: "bare" })).resolves.toBeUndefined();
  });
});

describe("composeSeedHook", () => {
  it("emits the current Moss job-search AI fixture env name", () => {
    const source = readFileSync(new URL("../uat/provisioner.ts", import.meta.url), "utf8");

    expect(source).toContain('MOSS_UAT_JOB_SEARCH_AI_BASE_URL=${jobSearchAiProviderBaseUrl ?? ""}');
    expect(source).not.toContain(
      'JARVIS_UAT_JOB_SEARCH_AI_BASE_URL=${jobSearchAiProviderBaseUrl ?? ""}'
    );
  });
});

describe("buildUatComposeArgs", () => {
  it("scopes every invocation to the project name and prod-shaped compose file", () => {
    expect(buildUatComposeArgs("uat-abc", ["up", "-d"])).toEqual([
      "compose",
      "-p",
      "uat-abc",
      "-f",
      "infra/docker-compose.prod.yml",
      "up",
      "-d"
    ]);
  });
});

describe("createUatProvisionPlan", () => {
  it("orders config-validate -> postgres up -> migrate -> jarv1s up, with down -v last", () => {
    const plan = createUatProvisionPlan({ projectName: "uat-abc", seedHook: async () => {} });
    const descriptions = plan.map((c) => c.description);
    expect(descriptions[0]).toMatch(/validate/i);
    expect(descriptions.at(-1)).toMatch(/teardown|down/i);
    const migrateIndex = plan.findIndex((c) => c.args.includes("migrate"));
    const jarv1sUpIndex = plan.findIndex((c) => c.args.includes("up") && c.args.includes("jarv1s"));
    expect(migrateIndex).toBeGreaterThan(-1);
    expect(jarv1sUpIndex).toBeGreaterThan(migrateIndex);
  });

  it("scopes the migrate step to the ops profile (matches docker-compose.prod.yml)", () => {
    const plan = createUatProvisionPlan({ projectName: "uat-abc", seedHook: async () => {} });
    const migrateCommand = plan.find((c) => c.args.includes("migrate"));
    expect(migrateCommand?.args).toEqual(
      expect.arrayContaining(["--profile", "ops", "run", "--rm", "migrate"])
    );
  });
});

describe("expectedUatVolumeNames", () => {
  it("derives the compose-scoped volume names for a project", () => {
    expect(expectedUatVolumeNames("uat-abc")).toEqual([
      "uat-abc_jarv1s-postgres-data",
      "uat-abc_jarv1s-vault-data",
      "uat-abc_jarv1s-model-cache",
      "uat-abc_jarv1s-cli-tools",
      "uat-abc_jarv1s-cli-auth",
      "uat-abc_jarv1s-cli-socket",
      "uat-abc_jarv1s-modules"
    ]);
  });
});

describe("buildSeedHookInput", () => {
  it("forwards excludeChunks into the seed hook input (#1026: previously dropped by main())", () => {
    expect(buildSeedHookInput("uat-abc", "admin+data", { excludeChunks: ["finance"] })).toEqual({
      projectName: "uat-abc",
      level: "admin+data",
      excludeChunks: ["finance"]
    });
  });

  it("omits excludeChunks when no opts are given", () => {
    expect(buildSeedHookInput("uat-abc", "bare")).toEqual({
      projectName: "uat-abc",
      level: "bare",
      excludeChunks: undefined
    });
  });
});
