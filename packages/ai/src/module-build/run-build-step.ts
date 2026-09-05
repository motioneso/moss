import type { ModuleBuildStepResult } from "@moss/jobs";

export type ModuleBuildStep = "writing_spec" | "writing_tests" | "writing_code";

export interface ModuleBuildRow {
  readonly id: string;
  readonly step: string | null;
  readonly plan: Record<string, unknown> | null;
}

export interface ModuleBuildSource {
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

export interface RunModuleBuildStepDeps {
  /** Checks host runtime availability before spending a provider call. */
  readonly assertExecutionAvailable: () => void | Promise<void>;
  readonly generateSource: (input: {
    readonly step: ModuleBuildStep;
    readonly plan: Record<string, unknown> | null;
    readonly signal?: AbortSignal;
  }) => Promise<ModuleBuildSource>;
  /** Host-owned acceptance, persistence and verification; source cannot report success. */
  readonly acceptSource: (input: {
    readonly buildId: string;
    readonly step: ModuleBuildStep;
    readonly source: ModuleBuildSource;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly moduleId?: string }>;
}

export async function runModuleBuildStep(
  deps: RunModuleBuildStepDeps,
  build: ModuleBuildRow,
  signal?: AbortSignal
): Promise<ModuleBuildStepResult> {
  signal?.throwIfAborted();
  await deps.assertExecutionAvailable();
  signal?.throwIfAborted();
  const step = currentBuildStep(build.step, build.plan?.["skipSpecAndTests"] === true);
  const source = await deps.generateSource({ step, plan: build.plan, signal });
  signal?.throwIfAborted();
  const accepted = await deps.acceptSource({ buildId: build.id, step, source, signal });
  signal?.throwIfAborted();
  const next = nextBuildStep(step);
  if (next === null) {
    if (!accepted.moduleId) throw new Error("module build acceptance did not return a module");
    return { deferred: false, moduleId: accepted.moduleId };
  }
  return { deferred: true, continuation: { buildId: build.id, step: next } };
}

function currentBuildStep(step: string | null, skipSpecAndTests: boolean): ModuleBuildStep {
  if (step === "writing_spec" || step === "writing_tests" || step === "writing_code") return step;
  return skipSpecAndTests ? "writing_code" : "writing_spec";
}

function nextBuildStep(step: ModuleBuildStep): ModuleBuildStep | null {
  if (step === "writing_spec") return "writing_tests";
  if (step === "writing_tests") return "writing_code";
  return null;
}
