import {
  askClassifierChoice,
  extractClassifierValues,
  resolveClassifier,
  type ActiveModulesResolver,
  type AssistantToolGateway,
  type ClassifierDeps
} from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import {
  normalizeClassifierCandidates,
  type MossModuleManifest,
  type ToolContext
} from "@moss/module-sdk";
import { MODULE_WORKER_SERVICE_KEY } from "@moss/shared";

import type { ClassifierGatePorts, GateTool } from "./classifier-gate.js";

/**
 * #2907 (plan 3.5) — the production ports factory for the classifier gate. It assembles the tool
 * menu, the classifier calls, the candidate hooks and the gateway call from the composition root's
 * existing dependencies. One factory is built per gate attempt, so its tool-name cache is scoped to
 * that attempt and its gateway is already bound to a short-lived token.
 *
 * The tool menu comes from the actor's active module manifests, not the gateway's executable list.
 * The gateway re-validates membership, trust and limits at call time (`callToolForGate`), so a pick
 * the gateway would hide is a truthful decline; this factory never becomes an authority.
 */

export type ClassifierGateAttemptPorts = {
  readonly classifier: ClassifierGatePorts["classifier"];
  readonly listTools: ClassifierGatePorts["listTools"];
  readonly loadCandidates: ClassifierGatePorts["loadCandidates"];
  readonly isReleased: ClassifierGatePorts["isReleased"];
  readonly gateway: ClassifierGatePorts["gateway"];
};

export type ClassifierGatePortsFactory = (
  actorUserId: string,
  token: string,
  /** The attempt's non-secret correlation id; falls back to an opaque per-call id when absent. */
  correlationId?: string
) => ClassifierGateAttemptPorts;

export interface ClassifierGatePortsFactoryDeps {
  readonly resolveActiveModules: ActiveModulesResolver;
  readonly dataContext: DataContextRunner;
  readonly gateway: Pick<AssistantToolGateway, "callToolForGate" | "recordContextForSession">;
  readonly classifierDeps: ClassifierDeps;
  /** The human-readable area label shown to the classifier; defaults to the manifest name. */
  readonly moduleDescription?: (manifest: MossModuleManifest) => string;
  readonly now?: () => number;
}

/** A manifest assistant tool that carries the classifier opt-in and a real handler. */
type ClassifierCapableTool = NonNullable<MossModuleManifest["assistantTools"]>[number];

function isClassifierCapable(tool: ClassifierCapableTool): boolean {
  return typeof tool.execute === "function" && tool.classifier !== undefined;
}

/**
 * A connected tool's sorted group sets its confidence bar (spec 8.3). Only an external tool's
 * declaration is read, and never to `read`, so a tool the gate may act on keeps mutating handling.
 */
function gateRisk(tool: ClassifierCapableTool): GateTool["risk"] {
  const sorted = tool.classifier?.sortedRisk;
  return tool.isExternal === true && sorted !== undefined && sorted !== "read" ? sorted : tool.risk;
}

function asGateTool(
  manifest: MossModuleManifest,
  tool: ClassifierCapableTool,
  description: string
): GateTool {
  return {
    moduleId: manifest.id,
    moduleDescription: description,
    name: tool.name,
    risk: gateRisk(tool),
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    classifier: tool.classifier
  };
}

export function createClassifierGatePortsFactory(
  deps: ClassifierGatePortsFactoryDeps
): ClassifierGatePortsFactory {
  const describe = deps.moduleDescription ?? ((manifest) => manifest.name);

  return (actorUserId, token, correlationId): ClassifierGateAttemptPorts => {
    const { dataContext, classifierDeps } = deps;
    /** The manifest tool behind each offered name, so `loadCandidates` can reach its hook. */
    const byName = new Map<string, ClassifierCapableTool>();
    /** Populated by `listTools`; the engine consults `isReleased` only after listing. */
    const listedIds = new Set<string>();
    let requestCounter = 0;
    const nextRequestId = () => `classifier_gate_${actorUserId}_${(requestCounter += 1)}`;
    const scoped = <T>(work: (db: DataContextDb) => Promise<T>) =>
      dataContext.withDataContext({ actorUserId, requestId: nextRequestId() }, work);

    return {
      classifier: {
        resolve: () =>
          scoped((db) => resolveClassifier(db, MODULE_WORKER_SERVICE_KEY, classifierDeps)),
        choose: (handle, input) =>
          scoped((db) =>
            askClassifierChoice(
              db,
              handle,
              {
                service: MODULE_WORKER_SERVICE_KEY,
                state: input.state,
                question: input.question,
                signal: input.signal,
                // #2956: the owner is this attempt's actor; the turn rides in.
                ...(input.activity
                  ? {
                      activity: {
                        ownerUserId: actorUserId,
                        ...(input.activity.actionCode
                          ? { actionCode: input.activity.actionCode }
                          : {}),
                        ...(input.activity.turnId ? { turnId: input.activity.turnId } : {}),
                        ...(input.activity.parentId ? { parentId: input.activity.parentId } : {})
                      }
                    }
                  : {})
              },
              classifierDeps
            )
          ),
        extract: (handle, input) =>
          scoped((db) =>
            extractClassifierValues(
              db,
              handle,
              {
                service: MODULE_WORKER_SERVICE_KEY,
                instructions: input.instructions,
                state: input.state,
                schema: input.schema,
                signal: input.signal,
                // #2956: the owner is this attempt's actor; the turn rides in.
                ...(input.activity
                  ? {
                      activity: {
                        ownerUserId: actorUserId,
                        ...(input.activity.actionCode
                          ? { actionCode: input.activity.actionCode }
                          : {}),
                        ...(input.activity.turnId ? { turnId: input.activity.turnId } : {}),
                        ...(input.activity.parentId ? { parentId: input.activity.parentId } : {})
                      }
                    }
                  : {})
              },
              classifierDeps
            )
          )
      },
      listTools: async () => {
        byName.clear();
        listedIds.clear();
        const manifests = await deps.resolveActiveModules(actorUserId);
        const tools: GateTool[] = [];
        let hasOutsideDescriptors = false;
        for (const manifest of manifests) {
          for (const tool of manifest.assistantTools ?? []) {
            if (!isClassifierCapable(tool)) continue;
            // Decide before projection drops provenance; an unstamped tool is outside content.
            if (tool.isExternal !== false) hasOutsideDescriptors = true;
            byName.set(tool.name, tool);
            const gateTool = asGateTool(manifest, tool, describe(manifest));
            listedIds.add(`${gateTool.moduleId}.${gateTool.name}`);
            tools.push(gateTool);
          }
        }
        if (hasOutsideDescriptors) {
          await deps.gateway.recordContextForSession(token, "tool_external_descriptors");
        }
        return tools;
      },
      loadCandidates: async (tool, signal) => {
        const manifestTool = byName.get(tool.name);
        if (!manifestTool?.classifier?.candidates) {
          throw new Error(`no candidate hook for ${tool.name}`);
        }
        const ctx: ToolContext = {
          actorUserId,
          requestId: nextRequestId(),
          // #2907 QA N1: never the live gate token. Use the attempt's non-secret correlation id.
          chatSessionId: correlationId ?? nextRequestId()
        };
        const raw = await scoped((db) => manifestTool.classifier!.candidates!(db, ctx, { signal }));
        const normalized = normalizeClassifierCandidates(raw);
        if (!normalized.ok) throw new Error("invalid classifier candidates");
        if (normalized.candidates.length > 0) {
          // Admission acquires its own actor-scoped connection, after the hook released its own.
          await deps.gateway.recordContextForSession(token, "classifier_candidates");
        }
        return normalized.candidates;
      },
      // Synchronous by contract. A tool is released when this attempt listed it: a module tool by
      // its author's classifier declaration, a connected tool by the declaration its synthetic
      // manifest carries only while the tool is eligible (spec 8.5).
      isReleased: (tool) => listedIds.has(`${tool.moduleId}.${tool.name}`),
      gateway: {
        call: (toolName: string, input: Record<string, unknown>, mode: "execute" | "dry-run") =>
          deps.gateway.callToolForGate(token, toolName, input, mode)
      }
    };
  };
}
