import { createHash } from "node:crypto";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type {
  ProactiveMonitorInput,
  ProactiveMonitorProvider,
  ProactiveMonitorResult,
  ProactiveMonitorSignal
} from "@moss/module-sdk";
import { formatLocaleDate } from "@moss/shared";

import { TaskDriftRepository } from "./drift.js";

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export const tasksMonitorProvider: ProactiveMonitorProvider = {
  source: "tasks",
  moduleId: "tasks",

  async collectSignals(
    scopedDb: unknown,
    input: ProactiveMonitorInput
  ): Promise<ProactiveMonitorResult> {
    assertDataContextDb(scopedDb as DataContextDb);
    const db = scopedDb as DataContextDb;
    const repo = new TaskDriftRepository();
    const now = input.now;

    const [overdue, atRisk] = await Promise.all([repo.getOverdue(db), repo.getAtRisk(db)]);

    const signals: ProactiveMonitorSignal[] = [];
    const seen = new Set<string>();

    for (const task of overdue) {
      if (signals.length >= input.maxSignals) break;
      const key = `overdue:${stableHash(task.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({
        source: "tasks",
        stableKey: key,
        sourceRefHash: stableHash(task.id),
        signalType: "overdue_high_priority",
        title: task.title,
        summary: `Task overdue${task.due_at ? ` since ${formatLocaleDate(task.due_at as unknown as string, input.locale)}` : ""}`,
        occurredAt: task.due_at ? new Date(task.due_at as unknown as string).toISOString() : now,
        priorityCandidate: {
          dueAt: task.due_at ? new Date(task.due_at as unknown as string).toISOString() : undefined,
          explicitPriority: task.priority as 1 | 2 | 3 | 4 | 5 | undefined,
          effort: task.effort ?? undefined
        }
      });
    }

    for (const task of atRisk) {
      if (signals.length >= input.maxSignals) break;
      const key = `at-risk:${stableHash(task.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const signalType = task.due_at ? "due_soon_high_priority" : "at_risk_focus";
      signals.push({
        source: "tasks",
        stableKey: key,
        sourceRefHash: stableHash(task.id),
        signalType,
        title: task.title,
        summary: `High-priority task needs attention${task.due_at ? ` — due ${formatLocaleDate(task.due_at as unknown as string, input.locale)}` : ""}`,
        targetAt: task.due_at
          ? new Date(task.due_at as unknown as string).toISOString()
          : undefined,
        priorityCandidate: {
          dueAt: task.due_at ? new Date(task.due_at as unknown as string).toISOString() : undefined,
          explicitPriority: task.priority as 1 | 2 | 3 | 4 | 5 | undefined,
          effort: task.effort ?? undefined
        }
      });
    }

    return { signals, nextCursor: { checkedAt: now } };
  }
};
