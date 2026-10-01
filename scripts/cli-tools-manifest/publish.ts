// The signing job's decision step. It reads the check job's output as pass/fail per toolset and
// nothing else, so text produced next to untrusted package code never reaches a signature,
// an issue body or a command.
import type { CliToolsManifest } from "./manifest.js";
import type { PrepareResult } from "./prepare.js";
import { assembleManifest, assertNotRollback } from "./sign-assemble.js";

export interface BlockedToolset {
  readonly toolset: string;
  readonly pkg: string;
  readonly version: string;
  readonly reason: "prepare" | "contract-check";
  /** Only set for "prepare" failures, which come from code that never runs packages. */
  readonly failures: readonly string[];
}

export interface PublishPlan {
  readonly manifest: CliToolsManifest | null;
  readonly blocked: readonly BlockedToolset[];
}

/** Keeps only `{toolset, pass: true|false}` from untrusted JSON. Anything else counts as a fail. */
export function readCheckPasses(raw: unknown): Map<string, boolean> {
  const passes = new Map<string, boolean>();
  if (!Array.isArray(raw)) return passes;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { toolset, pass } = item as { toolset?: unknown; pass?: unknown };
    if (typeof toolset === "string") passes.set(toolset, pass === true);
  }
  return passes;
}

export function planPublish(input: {
  readonly previous: CliToolsManifest | null;
  readonly prepared: PrepareResult;
  readonly checkPasses: ReadonlyMap<string, boolean>;
  readonly issuedAt: string;
}): PublishPlan {
  const updates: Record<
    string,
    NonNullable<PrepareResult["outcomes"][number]["manifestToolset"]>
  > = {};
  const attested: { pkg: string; version: string }[] = [];
  const blocked: BlockedToolset[] = [];

  for (const outcome of input.prepared.outcomes) {
    if (outcome.status === "blocked") {
      blocked.push({
        toolset: outcome.toolset,
        pkg: outcome.subject?.pkg ?? outcome.toolset,
        version: outcome.subject?.version ?? "unknown",
        reason: "prepare",
        failures: outcome.failures
      });
      continue;
    }
    if (outcome.status !== "updated" || outcome.manifestToolset === undefined) continue;

    if (input.checkPasses.get(outcome.toolset) !== true) {
      const changed = outcome.manifestToolset.packages[0]!;
      blocked.push({
        toolset: outcome.toolset,
        pkg: changed.pkg,
        version: changed.version,
        reason: "contract-check",
        failures: []
      });
      continue;
    }
    for (const p of outcome.manifestToolset.packages) {
      assertNotRollback(input.previous, outcome.toolset, p.pkg, p.version);
    }
    updates[outcome.toolset] = outcome.manifestToolset;
    attested.push(...(outcome.attested ?? []));
  }

  if (Object.keys(updates).length === 0) return { manifest: null, blocked };
  return {
    manifest: assembleManifest({
      previous: input.previous,
      updates,
      attested,
      issuedAt: input.issuedAt
    }),
    blocked
  };
}
