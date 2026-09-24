import { beforeEach, describe, expect, it } from "vitest";

import { composeBriefing, type ComposeDeps } from "../../packages/briefings/src/compose.js";
import {
  definition,
  executedSql,
  fakeScopedDb,
  makeFakeDeps,
  runInput
} from "./briefings-compose.harness.js";

// Compose runs on the job's single transaction. Every best-effort step that can swallow a
// database error must run inside its own savepoint, and savepoints must never interleave.

const SAVEPOINT = /^SAVEPOINT (\S+)$/;
const ROLLBACK = /^ROLLBACK TO SAVEPOINT (\S+)$/;
const RELEASE = /^RELEASE SAVEPOINT (\S+)$/;

interface SavepointTrace {
  readonly opened: string[];
  readonly rolledBack: string[];
  readonly maxDepth: number;
  readonly unreleased: string[];
}

/** Replays the recorded statements as a savepoint stack, failing on any out-of-order step. */
function traceSavepoints(statements: readonly string[]): SavepointTrace {
  const stack: string[] = [];
  const opened: string[] = [];
  const rolledBack: string[] = [];
  let maxDepth = 0;
  for (const stmt of statements) {
    const open = SAVEPOINT.exec(stmt);
    if (open) {
      stack.push(open[1]!);
      opened.push(open[1]!);
      maxDepth = Math.max(maxDepth, stack.length);
      continue;
    }
    const rollback = ROLLBACK.exec(stmt);
    if (rollback) {
      expect(stack.at(-1), `rollback of ${rollback[1]} must target the open savepoint`).toBe(
        rollback[1]
      );
      rolledBack.push(rollback[1]!);
      continue;
    }
    const release = RELEASE.exec(stmt);
    if (release) {
      expect(stack.at(-1), `release of ${release[1]} must target the open savepoint`).toBe(
        release[1]
      );
      stack.pop();
    }
  }
  return { opened, rolledBack, maxDepth, unreleased: stack };
}

describe("composeBriefing savepoints", () => {
  beforeEach(() => {
    executedSql.length = 0;
  });

  it("rolls a failing tool back to a savepoint it opened, then later tools open their own", async () => {
    const deps = makeFakeDeps({ failTool: "email.listVisibleMessages" });
    await composeBriefing(fakeScopedDb, definition(), runInput, deps);

    const rollback = executedSql.findIndex((stmt) => ROLLBACK.test(stmt));
    expect(rollback).toBeGreaterThan(-1);
    const name = ROLLBACK.exec(executedSql[rollback]!)![1]!;
    const opened = executedSql.indexOf(`SAVEPOINT ${name}`);
    expect(opened).toBeGreaterThan(-1);
    expect(opened).toBeLessThan(rollback);
    expect(executedSql[rollback + 1]).toBe(`RELEASE SAVEPOINT ${name}`);
    expect(executedSql.slice(rollback + 2).some((stmt) => SAVEPOINT.test(stmt))).toBe(true);
  });

  it("protects the suggested-task, saved-plan and freshness reads one at a time", async () => {
    const failingRead = async (): Promise<Date | null> => {
      throw new Error("freshness read down");
    };
    const deps: ComposeDeps = {
      ...makeFakeDeps({ failTool: "tasks.list", dayPlan: { throws: true } }),
      connectorSyncAt: failingRead,
      vaultLastWriteAt: failingRead
    };
    const result = await composeBriefing(fakeScopedDb, definition(), runInput, deps);

    const gaps = (result.sourceMetadata.gaps ?? []) as Array<{ source: string; reason: string }>;
    expect(gaps).toContainEqual({ source: "action_rows", reason: "structured_payload_failed" });
    expect(gaps).toContainEqual({ source: "day_plan", reason: "tool_failed" });
    expect(result.status).toBe("succeeded");

    const trace = traceSavepoints(executedSql);
    expect(trace.maxDepth).toBe(1);
    expect(trace.unreleased).toEqual([]);
    // tasks.list twice (suggested rows, then the tasks section), the plan read, and one
    // freshness read each for calendar, email and vault.
    expect(trace.rolledBack).toHaveLength(6);
  });
});
