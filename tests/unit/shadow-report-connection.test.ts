import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { DataContextDb, DataContextRunner, JsonSecretCipher } from "@moss/db";
import {
  createIntegrationsActiveModulesResolver,
  createResolverCache,
  effectiveClassifierTools,
  toolRunsWithoutAsking,
  withSortResult,
  type ConnectionRow,
  type IntegrationsRepository
} from "@moss/integrations";
import { checkClassifierEligibility } from "@moss/module-sdk";
import { resolveComparison } from "../../packages/chat/src/classifier-shadow-repository.js";
import { createClassifierGatePortsFactory } from "../../packages/chat/src/live/classifier-gate-wiring.js";
import {
  requireShadowReportProject,
  seedShadowReportConnection,
  SHADOW_REPORT_CONNECTION_NAME,
  SHADOW_REPORT_MODEL_IDENTITY,
  SHADOW_REPORT_MODEL_TOOL,
  shadowReportFixtureTool
} from "../uat/fixtures/shadow-report-connection.js";
import { UAT_ADMIN_ID } from "../uat/seed/admin.js";
import { UAT_SEED_BASE_TIMESTAMP } from "../uat/seed/timestamps.js";
import { loadChatScriptFixture } from "../uat/fixtures/scripted-provider/script-schema.js";

const PROJECT = "uat-123_ab12cd34";
const DB = {} as DataContextDb;

function harness() {
  let row: ConnectionRow = {
    id: "00000000-0000-4000-8000-000000000003",
    ownerUserId: UAT_ADMIN_ID,
    name: SHADOW_REPORT_CONNECTION_NAME,
    kind: "mcp",
    transport: "http",
    url: "",
    credentialPlacement: null,
    hasCredential: false,
    enabled: true,
    baseUrl: null,
    specPasted: false,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    classifierEnabled: false,
    classifierPreparation: { version: 1, entries: {} },
    classifierSort: { version: 1, entries: {} },
    classifierKeptOutTools: [],
    discoveredTools: [],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: UAT_SEED_BASE_TIMESTAMP,
    updatedAt: UAT_SEED_BASE_TIMESTAMP
  };
  type Repository = NonNullable<Parameters<typeof seedShadowReportConnection>[2]>;
  const repository: Repository = {
    createConnection: vi.fn(async (_db, input) => {
      row = { ...row, name: input.name, url: input.url };
      return row;
    }),
    saveDiscovery: vi.fn(async (_db, _id, tools) => {
      row = { ...row, discoveredTools: tools ?? [] };
    }),
    updateConnection: vi.fn(async (_db, _id, patch) => {
      row = { ...row, ...patch };
      return row;
    }),
    saveClassifierToolSorts: vi.fn(async (_db, _id, results) => {
      for (const { toolName, result } of results)
        row = { ...row, classifierSort: withSortResult(row.classifierSort, toolName, result)! };
      return row;
    }),
    saveClassifierToolReview: vi.fn(async (_db, _id, toolName, input) => {
      row = {
        ...row,
        classifierPreparation: {
          version: 1,
          entries: {
            [toolName]: {
              optIn: input.optIn,
              reviewedRisk: input.reviewedRisk,
              description: input.description,
              arguments: input.arguments,
              replyTemplate: input.replyTemplate,
              definitionFingerprint: input.reviewedFingerprint,
              reviewedAt: UAT_SEED_BASE_TIMESTAMP.toISOString(),
              preparationVersion: 1
            }
          }
        }
      };
      return { status: "saved" as const, connection: row };
    }),
    getConnection: vi.fn(async () => row)
  };
  const withDataContext = vi.fn(
    async (_access: unknown, work: (db: DataContextDb) => Promise<unknown>) => work(DB)
  );
  const runner = { withDataContext } as unknown as DataContextRunner;
  return { repository, runner, withDataContext, row: () => row };
}

describe("shadow report's declared mismatch fixture", () => {
  it("rejects non-UAT targets before any repository or actor-context operation", async () => {
    const h = harness();
    for (const project of [undefined, "prod", "uat-dev", "uat-1_ab12cd34.evil"])
      expect(() => requireShadowReportProject(project)).toThrow("isolated UAT project");
    await expect(seedShadowReportConnection(h.runner, "prod", h.repository)).rejects.toThrow();
    expect(h.withDataContext).not.toHaveBeenCalled();
    expect(h.repository.createConnection).not.toHaveBeenCalled();
  });

  it("persists owner-scoped prepared/sorted fixture setup that the production menu declares", async () => {
    const h = harness();
    await seedShadowReportConnection(h.runner, PROJECT, h.repository);
    expect(h.withDataContext).toHaveBeenCalledWith(
      { actorUserId: UAT_ADMIN_ID },
      expect.any(Function)
    );
    expect(h.repository.createConnection).toHaveBeenCalledWith(DB, {
      name: SHADOW_REPORT_CONNECTION_NAME,
      kind: "mcp",
      url: "http://uat-123_ab12cd34-mcpfixture:8082/mcp",
      baseUrl: null,
      specPasted: false,
      credentialEnvelope: null,
      credentialPlacement: null
    });
    const saved = h.row();
    expect(effectiveClassifierTools(saved)).toHaveLength(1);
    expect(toolRunsWithoutAsking(saved.classifierSort, shadowReportFixtureTool())).toBe(true);

    const resolveActiveModules = createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: h.runner,
      repository: { listConnections: async () => [saved] } as unknown as IntegrationsRepository,
      cipher: {} as JsonSecretCipher,
      resolverCache: createResolverCache(),
      logger: { warn: vi.fn() }
    });
    const [manifest] = await resolveActiveModules(UAT_ADMIN_ID);
    const tool = manifest!.assistantTools![0]!;
    expect(tool.name).toBe(SHADOW_REPORT_MODEL_TOOL);
    expect(checkClassifierEligibility(tool)).toEqual({ eligible: true });
    const ports = createClassifierGatePortsFactory({
      resolveActiveModules,
      dataContext: h.runner,
      classifierDeps: {} as never,
      gateway: {
        recordContextForSession: vi.fn(async () => {}),
        admitToolDescriptorsForSession: vi.fn(async () => {})
      } as never
    })(UAT_ADMIN_ID, "unused-fixture-token");
    const [declared] = await ports.listTools();
    expect(declared?.name).toBe(SHADOW_REPORT_MODEL_TOOL);
    expect(`${declared!.moduleId}.${declared!.name}`).toBe(SHADOW_REPORT_MODEL_IDENTITY);
    expect(
      resolveComparison("would_handle", "calendar.listvisibleevents", SHADOW_REPORT_MODEL_IDENTITY)
    ).toBe("mismatch");
    const script = loadChatScriptFixture("classifier-shadow");
    expect(script.turns.find((turn) => turn.expectIncludes.includes("uatmiss"))?.calls).toEqual([
      { tool: SHADOW_REPORT_MODEL_TOOL, arguments: { name: "Kitchen light", on: true } }
    ]);

    // Removing the prepared or sorted state really removes this tool from the menu.
    expect(
      effectiveClassifierTools({ ...saved, classifierPreparation: { version: 1, entries: {} } })
    ).toEqual([]);
    expect(
      effectiveClassifierTools({ ...saved, classifierSort: { version: 1, entries: {} } })
    ).toEqual([]);
  });

  it("fails closed when preparation is rejected or the stored setup is not eligible", async () => {
    const rejected = harness();
    vi.mocked(rejected.repository.saveClassifierToolReview).mockResolvedValue({
      status: "not_found"
    });
    await expect(
      seedShadowReportConnection(rejected.runner, PROJECT, rejected.repository)
    ).rejects.toThrow("preparation failed");
    const missing = harness();
    vi.mocked(missing.repository.getConnection).mockResolvedValue(null);
    await expect(
      seedShadowReportConnection(missing.runner, PROJECT, missing.repository)
    ).rejects.toThrow("not classifier eligible");
  });

  it("the CLI retains both seed-environment and actual-target guards before fixture writes", () => {
    const cli = readFileSync(
      new URL("../uat/fixtures/shadow-report-connection-cli.ts", import.meta.url),
      "utf8"
    );
    expect(cli).toContain('process.env.JARVIS_UAT_SEED_CONFIRM !== "1"');
    expect(cli.indexOf("await assertTargetIsEphemeral(migrationDb)")).toBeLessThan(
      cli.indexOf("await seedShadowReportConnection(runner, project)")
    );
  });
});
