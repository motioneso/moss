import {
  askClassifierChoice,
  extractClassifierValues,
  resolveClassifier,
  type ActiveModulesResolver,
  type AssistantToolGateway,
  type ClassifierDeps
} from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import type { MossModuleManifest, ToolContext } from "@moss/module-sdk";
import { MODULE_WORKER_SERVICE_KEY } from "@moss/shared";

import type { ClassifierReleaseEligibilityRepository } from "../classifier-release-repository.js";
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
  readonly gateway: Pick<AssistantToolGateway, "callToolForGate">;
  readonly classifierDeps: ClassifierDeps;
  readonly releaseRepository: ClassifierReleaseEligibilityRepository;
  /** The human-readable area label shown to the classifier; defaults to the manifest name. */
  readonly moduleDescription?: (manifest: MossModuleManifest) => string;
  readonly now?: () => number;
}

/** A manifest assistant tool that carries the classifier opt-in and a real handler. */
type ClassifierCapableTool = NonNullable<MossModuleManifest["assistantTools"]>[number];

function isClassifierCapable(tool: ClassifierCapableTool): boolean {
  return typeof tool.execute === "function" && tool.classifier !== undefined;
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
    risk: tool.risk,
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
    const releasedIds = new Set<string>();
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
                signal: input.signal
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
                signal: input.signal
              },
              classifierDeps
            )
          )
      },
      listTools: async () => {
        byName.clear();
        releasedIds.clear();
        const manifests = await deps.resolveActiveModules(actorUserId);
        const tools: GateTool[] = [];
        for (const manifest of manifests) {
          for (const tool of manifest.assistantTools ?? []) {
            if (!isClassifierCapable(tool)) continue;
            byName.set(tool.name, tool);
            tools.push(asGateTool(manifest, tool, describe(manifest)));
          }
        }
        const releases = await scoped((db) => deps.releaseRepository.listEligibleReleases(db));
        for (const release of releases) releasedIds.add(`${release.moduleId}.${release.toolName}`);
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
        return scoped((db) => manifestTool.classifier!.candidates!(db, ctx, { signal }));
      },
      // Synchronous by contract; `listTools` preloaded the approved releases beforehand. No release
      // writer exists yet (task 4.2), so today this is always empty and `on` stays unreachable.
      isReleased: (tool) => releasedIds.has(`${tool.moduleId}.${tool.name}`),
      gateway: {
        call: (toolName: string, input: Record<string, unknown>, mode: "execute" | "dry-run") =>
          deps.gateway.callToolForGate(token, toolName, input, mode)
      }
    };
  };
}
