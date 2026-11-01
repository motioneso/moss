// tests/unit/helpers/meals-log-fake.ts
//
// An in-memory twin of the log store plus a deps builder, so the log tools and the estimate job
// run without a database. The twin applies the same revision check and the same positional merge
// as the SQL store.
import type { LogEntryView, KitchenView } from "../../../external-modules/meals/src/contracts.js";
import type { LogDeps, LogJobDeps } from "../../../external-modules/meals/src/log/deps.js";
import { sumItemNutrients } from "../../../external-modules/meals/src/log/domain.js";
import type {
  CorrectEntryPatch,
  CreateEntryInput,
  LogStore,
  RecordEstimateInput
} from "../../../external-modules/meals/src/store/log-port.js";
import { mergeItems } from "../../../external-modules/meals/src/store/log.js";
import { RecordingJobs, ScriptedAi, sequentialIds } from "./meals-plan-fake.js";

export class FakeLogStore implements LogStore {
  readonly entries = new Map<string, LogEntryView & { idempotencyKey: string }>();

  private view(id: string): LogEntryView | null {
    const row = this.entries.get(id);
    if (!row) return null;
    const { idempotencyKey: _key, ...entry } = row;
    return entry;
  }

  async createEntry(input: CreateEntryInput) {
    for (const row of this.entries.values()) {
      if (row.idempotencyKey === input.idempotencyKey) {
        return { entry: this.view(row.entryId)!, created: false };
      }
    }
    this.entries.set(input.entryId, {
      entryId: input.entryId,
      consumedAt: input.consumedAt.toISOString(),
      localDate: input.localDate,
      timezoneOffset: input.timezoneOffset,
      description: input.description,
      servingNote: input.servingNote,
      captureKind: input.captureKind,
      estimateState: "pending",
      estimateRevision: 1,
      nutrients: null,
      items: [],
      missingDetails: null,
      clarificationQuestion: null,
      idempotencyKey: input.idempotencyKey
    });
    return { entry: this.view(input.entryId)!, created: true };
  }

  async getEntry(entryId: string) {
    return this.view(entryId);
  }

  async listForLocalDate(localDate: string) {
    return this.listForDateRange(localDate, localDate);
  }

  async listForDateRange(from: string, to: string) {
    return [...this.entries.keys()]
      .map((id) => this.view(id)!)
      .filter((entry) => entry.localDate >= from && entry.localDate <= to)
      .sort((a, b) => a.consumedAt.localeCompare(b.consumedAt));
  }

  async recordEstimate(entryId: string, expectedRevision: number, outcome: RecordEstimateInput) {
    const row = this.entries.get(entryId);
    if (!row || row.estimateRevision !== expectedRevision) return null;
    this.entries.set(entryId, {
      ...row,
      estimateState: outcome.state,
      estimateRevision: row.estimateRevision + 1,
      nutrients: outcome.state === "estimated" ? outcome.nutrients : null,
      items: outcome.items,
      missingDetails: outcome.state === "needs_details" ? outcome.missingDetails : null,
      clarificationQuestion:
        outcome.state === "needs_details" ? outcome.clarificationQuestion : null
    });
    return this.view(entryId);
  }

  async correctEntry(entryId: string, expectedRevision: number, patch: CorrectEntryPatch) {
    const row = this.entries.get(entryId);
    if (!row || row.estimateRevision !== expectedRevision) return null;
    const items = patch.items ? mergeItems(row.items, patch.items) : null;
    this.entries.set(entryId, {
      ...row,
      description: patch.description ?? row.description,
      servingNote: patch.servingNote !== undefined ? patch.servingNote : row.servingNote,
      consumedAt: patch.consumedAt?.toISOString() ?? row.consumedAt,
      localDate: patch.localDate ?? row.localDate,
      timezoneOffset: patch.timezoneOffset ?? row.timezoneOffset,
      estimateState: items ? "estimated" : row.estimateState,
      estimateRevision: row.estimateRevision + 1,
      items: items ?? row.items,
      nutrients: items ? sumItemNutrients(items) : row.nutrients,
      missingDetails: items ? null : row.missingDetails,
      clarificationQuestion: items ? null : row.clarificationQuestion
    });
    return this.view(entryId);
  }

  async markPending(entryId: string, expectedRevision: number) {
    const row = this.entries.get(entryId);
    if (!row || row.estimateRevision !== expectedRevision || row.estimateState !== "failed") {
      return null;
    }
    this.entries.set(entryId, { ...row, estimateState: "pending" });
    return this.view(entryId);
  }

  async deleteEntry(entryId: string) {
    return this.entries.delete(entryId);
  }
}

export function fakeLogDeps(
  kitchen: KitchenView,
  options: { localTimezone?: string; now?: Date; ai?: ScriptedAi } = {}
) {
  const store = new FakeLogStore();
  const jobs = new RecordingJobs();
  const ai = options.ai ?? new ScriptedAi();
  let kitchenReads = 0;
  const deps: LogDeps = {
    store,
    kitchen: async () => {
      kitchenReads += 1;
      return kitchen;
    },
    jobs,
    newId: sequentialIds(),
    now: () => options.now ?? new Date("2026-11-02T18:30:00Z"),
    localTimezone: options.localTimezone
  };
  const jobDeps: LogJobDeps = { store, ai };
  return { deps, jobDeps, store, jobs, ai, kitchenReads: () => kitchenReads };
}
