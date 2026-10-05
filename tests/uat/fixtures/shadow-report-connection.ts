import type { DataContextRunner } from "@moss/db";
import {
  effectiveClassifierTools,
  IntegrationsRepository,
  toolDefinitionFingerprint,
  toolRiskInputs,
  toolSortFingerprint,
  type DiscoveredTool
} from "@moss/integrations";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { UAT_SEED_BASE_TIMESTAMP } from "../seed/timestamps.js";
import {
  classifierMcpFixtureEndpointFor,
  defaultFixtureTools,
  FIXTURE_LIGHT_TOOL
} from "./classifier-mcp-fixture-server.js";

export const SHADOW_REPORT_CONNECTION_NAME = "UAT shadow report";
export const SHADOW_REPORT_MODEL_TOOL = "uat-shadow-report.set_light_state";
export const SHADOW_REPORT_MODEL_IDENTITY =
  "integration-uat-shadow-report.uat-shadow-report.set_light_state";

type FixtureRepository = Pick<
  IntegrationsRepository,
  | "createConnection"
  | "saveDiscovery"
  | "updateConnection"
  | "saveClassifierToolSorts"
  | "saveClassifierToolReview"
  | "getConnection"
>;

export function requireShadowReportProject(project: string | undefined): string {
  if (!project || !/^uat-[0-9]+_[0-9a-f]{8}$/.test(project))
    throw new Error("Shadow report fixture requires an isolated UAT project");
  return project;
}

/** The existing MCP fixture's in-memory light switch; it never controls a real device. */
export function shadowReportFixtureTool(): DiscoveredTool {
  const tool = defaultFixtureTools().find((candidate) => candidate.name === FIXTURE_LIGHT_TOOL);
  if (!tool) throw new Error("Shadow report fixture light tool is missing");
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    group: ""
  };
}

/**
 * Explicit synthetic setup data, like the fixture classifier binding. Persist through the
 * owning module's repository and owner context; never fabricate a shadow record or a response.
 * The later chat turn resolves this declaration and calls the real MCP fixture through the
 * production gateway. No sorting/preparation model is contacted by this setup.
 * A connected read tool is intentionally absent from the gate menu because its summary has
 * no answer content. The fixture's in-memory light is truthfully sorted as write instead.
 */
export async function seedShadowReportConnection(
  runner: DataContextRunner,
  projectName: string,
  repository: FixtureRepository = new IntegrationsRepository()
): Promise<void> {
  const project = requireShadowReportProject(projectName);
  const tool = shadowReportFixtureTool();
  await runner.withDataContext({ actorUserId: UAT_ADMIN_ID }, async (db) => {
    const connection = await repository.createConnection(db, {
      name: SHADOW_REPORT_CONNECTION_NAME,
      kind: "mcp",
      url: classifierMcpFixtureEndpointFor(project),
      baseUrl: null,
      specPasted: false,
      credentialEnvelope: null,
      credentialPlacement: null
    });
    await repository.saveDiscovery(db, connection.id, [tool], null);
    await repository.updateConnection(db, connection.id, {
      enabled: true,
      classifierEnabled: true
    });
    await repository.saveClassifierToolSorts(db, connection.id, [
      {
        toolName: tool.name,
        result: {
          status: "current",
          risk: "write",
          readableName: "Set fixture light",
          sortFingerprint: toolSortFingerprint(toolRiskInputs(tool)),
          sortedAt: UAT_SEED_BASE_TIMESTAMP.toISOString()
        }
      }
    ]);
    const prepared = await repository.saveClassifierToolReview(db, connection.id, tool.name, {
      optIn: true,
      reviewedRisk: "write",
      description: "Set the synthetic fixture light state.",
      arguments: { name: { kind: "extract" }, on: { kind: "extract" } },
      replyTemplate: "{summary}",
      reviewedFingerprint: toolDefinitionFingerprint(tool)
    });
    if (prepared.status !== "saved") throw new Error("Shadow report fixture preparation failed");
    const saved = await repository.getConnection(db, connection.id);
    if (!saved || !effectiveClassifierTools(saved).some((entry) => entry.tool.name === tool.name))
      throw new Error("Shadow report fixture tool is not classifier eligible");
  });
}
