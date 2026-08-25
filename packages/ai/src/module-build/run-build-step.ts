import type { ModuleBuildStepResult } from "@moss/jobs";

export type ModuleBuildStep = "writing_spec" | "writing_tests" | "writing_code";

export interface ModuleBuildRow {
  readonly id: string;
  readonly step: string | null;
  readonly plan: Record<string, unknown> | null;
}

export interface LaunchLiveAgentResult {
  readonly wroteFiles: readonly string[];
  readonly testsPassing?: boolean;
  readonly fetchedUrls?: readonly string[];
}

export interface RunModuleBuildStepDeps {
  /**
   * Composed by the caller from `buildLaunchCommand` + `writeClaudePermissionHook`
   * (packages/chat/src/live), scoped to `workingDir` — this module never launches a
   * CLI or writes a permission hook itself, it only drives the step sequence.
   */
  readonly launchLiveAgent: (input: {
    readonly workingDir: string;
    readonly step: ModuleBuildStep;
    readonly plan: Record<string, unknown> | null;
  }) => Promise<LaunchLiveAgentResult>;
  readonly resolveWorkingDir: (buildId: string) => string;
  readonly recordFetchedUrl: (buildId: string, url: string) => Promise<void>;
  readonly recordWrittenFile: (buildId: string, path: string) => Promise<void>;
}

export async function runModuleBuildStep(
  deps: RunModuleBuildStepDeps,
  build: ModuleBuildRow
): Promise<ModuleBuildStepResult> {
  const skipSpecAndTests = build.plan?.["skipSpecAndTests"] === true;
  const step = currentBuildStep(build.step, skipSpecAndTests);
  const workingDir = deps.resolveWorkingDir(build.id);

  const result = await deps.launchLiveAgent({ workingDir, step, plan: build.plan });

  for (const url of result.fetchedUrls ?? []) {
    await deps.recordFetchedUrl(build.id, url);
  }

  for (const path of result.wroteFiles) {
    await deps.recordWrittenFile(build.id, path);
  }

  const next = nextBuildStep(step);
  if (next === null) return { deferred: false };
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
