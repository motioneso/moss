import {
  generateStructured,
  type GenerateStructuredDeps,
  type ModuleBuildStep,
  type ModuleBuildSource
} from "@moss/ai";
import type { DataContextDb } from "@moss/db";
import { WORKSHOP_PLAN_SERVICE_KEY } from "@moss/shared";

import { ModuleBuildSafeError } from "./module-build-step-runner.js";

const SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 200 },
          content: { type: "string", maxLength: 32768 }
        }
      }
    }
  }
} as const;

// Files are data, never a tarball, link, package script, compiler config or executable bundle.
// The runtime owns dependencies, recipes and output paths. Tighten/extend this public input
// contract together with its isolated image; accepting a suffix is not execution permission.
const SOURCE_PATH =
  /^(?:jarvis\.module\.json|SPEC\.md|README\.md|(?:src\/(?:worker|web)|tests)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:ts|tsx|css))$/;

export function validateModuleBuildSource(value: unknown): ModuleBuildSource {
  const invalid = () => new ModuleBuildSafeError("Workshop returned invalid source files.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== 1 ||
    !Object.hasOwn(object, "files") ||
    !Array.isArray(object.files)
  )
    throw invalid();
  if (object.files.length === 0 || object.files.length > 32) throw invalid();
  const paths = new Set<string>();
  let bytes = 0;
  const files = Array.from(object.files, (entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const file = entry as Record<string, unknown>;
    if (
      Object.keys(file).length !== 2 ||
      !Object.hasOwn(file, "path") ||
      !Object.hasOwn(file, "content") ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      file.path.length > 200 ||
      !SOURCE_PATH.test(file.path) ||
      file.content.includes("\0") ||
      Buffer.byteLength(file.content) > 32768
    )
      throw invalid();
    const path = file.path.toLowerCase();
    if (paths.has(path)) throw invalid();
    paths.add(path);
    bytes += Buffer.byteLength(file.path) + Buffer.byteLength(file.content);
    if (bytes > 65536) throw invalid();
    return { path: file.path, content: file.content };
  });
  return { files };
}

export function createModuleBuildSourceGenerator(
  scopedDb: DataContextDb,
  actorUserId: string,
  deps: GenerateStructuredDeps
) {
  return async (input: {
    readonly step: ModuleBuildStep;
    readonly plan: Record<string, unknown> | null;
    readonly signal?: AbortSignal;
  }): Promise<ModuleBuildSource> => {
    input.signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(120_000);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const result = await generateStructured(
      scopedDb,
      {
        service: input.step === "writing_spec" ? WORKSHOP_PLAN_SERVICE_KEY : "module.workshop",
        tierHint: input.step === "writing_spec" ? "reasoning" : "interactive",
        requiredTier: input.step === "writing_spec" ? "reasoning" : undefined,
        schema: SOURCE_SCHEMA,
        prompt: [
          "Return source files as JSON data for a Moss downloaded module. Do not run tools or commands.",
          "The host supplies the SDK and build recipe; do not supply dependencies, scripts or tool configuration.",
          "Allowed paths: SPEC.md, README.md, jarvis.module.json, TypeScript under src/worker, src/web or tests, and CSS under src/web.",
          "Use only the agreed plan. Source is a proposal; never assert that tests, installation or verification succeeded.",
          `Current step: ${input.step}`,
          `Agreed plan: ${JSON.stringify(input.plan)}`
        ].join("\n\n"),
        sourceGeneration: true,
        maxOutputTokens: 16384,
        signal
      },
      {
        ...deps,
        repository: {
          resolveModelForService: async (db, service, options) => {
            const route = await deps.repository.resolveModelForService(db, service, options);
            signal.throwIfAborted();
            return route.model?.owner_user_id === actorUserId ? route : { ...route, model: null };
          },
          selectProviderWithCredential: async (db, id) => {
            const provider = await deps.repository.selectProviderWithCredential(db, id);
            signal.throwIfAborted();
            return provider?.owner_user_id === actorUserId &&
              provider.status === "active" &&
              provider.purpose === "assistant"
              ? provider
              : undefined;
          }
        },
        // #2288: the runner's provider-global CLI token has no actor/config provenance.
        // Never borrow it or fall back to a different route. Bind fresh login credentials first.
        createCliStructuredAdapter: undefined
      }
    );
    signal.throwIfAborted();
    if (!result.ok) {
      throw new ModuleBuildSafeError(
        result.error === "needs_config"
          ? "Workshop needs an available model with an owner-bound connection in AI providers."
          : "Workshop source generation did not complete."
      );
    }
    return validateModuleBuildSource(result.object);
  };
}
