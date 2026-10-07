import { createHash } from "node:crypto";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import {
  type ApprovalField,
  type HumanActionDetails,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import type { DayPlanDto } from "@moss/shared";
import type { DayPlanRoutesDependencies } from "./day-plan-routes.js";

type Dependencies = Pick<DayPlanRoutesDependencies, "findTask" | "findRun"> & {
  readonly dayPlanRepository: Pick<DayPlanRoutesDependencies["dayPlanRepository"], "getById">;
};
let dependencies: Dependencies | undefined;
export function setDayPlanApprovalDependencies(value: Dependencies): void {
  dependencies = value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value: unknown): string | null {
  return value === null ? "Clear" : typeof value === "string" ? value : null;
}
const choices: Record<string, Readonly<Record<string, string>>> = {
  capacity: { light: "Light", normal: "Normal", full: "Full" },
  source: { briefing: "Briefing", planner: "Planner", actor: "You" },
  decision: { commit: "Commit", defer: "Defer", drop: "Drop" },
  kind: {
    focus: "Focus",
    meeting: "Meeting",
    prep: "Preparation",
    break: "Break",
    personal: "Personal",
    unscheduled: "Unscheduled"
  },
  change: { add: "Add", move: "Move", remove: "Remove" }
};
function choice(value: unknown, kind: string): string | null {
  if (value === null) return "Clear";
  return typeof value === "string" && Object.hasOwn(choices[kind]!, value)
    ? choices[kind]![value]!
    : null;
}

class PlanDisclosure {
  readonly fields: ApprovalField[] = [];
  readonly references: unknown[] = [];
  constructor(
    private readonly db: DataContextDb,
    private readonly actor: string,
    readonly plan: DayPlanDto | null
  ) {}
  add(label: string, value: string | null): void {
    if (value === null) throw new Error("Unavailable plan field");
    this.fields.push({ label, value });
  }
  async task(value: unknown): Promise<string | null> {
    if (value === null) return "None";
    if (typeof value !== "string" || !dependencies?.findTask) return null;
    const row = await dependencies.findTask(this.db, value);
    if (!row || row.owner_user_id !== this.actor || !row.title.trim()) return null;
    this.references.push(row);
    return row.title;
  }
  async intent(value: unknown): Promise<void> {
    if (value === null) {
      this.add("Evening plan", "Clear");
      return;
    }
    const patch = object(value);
    if (
      !patch ||
      !keys(patch, ["priorityTaskIds", "capacity", "notes", "corrections", "commitments"])
    )
      throw new Error("Invalid intent");
    for (const [key, entry] of Object.entries(patch)) {
      if (key === "capacity") this.add("Capacity", choice(entry, "capacity"));
      else if (key === "notes") this.add("Notes", text(entry));
      else {
        if (!Array.isArray(entry)) throw new Error("Invalid intent list");
        if (!entry.length)
          this.add(
            {
              priorityTaskIds: "Priority tasks",
              corrections: "Corrections",
              commitments: "Commitments"
            }[key]!,
            "None"
          );
        for (const [index, item] of entry.entries()) {
          const prefix = `${{ priorityTaskIds: "Priority task", corrections: "Correction", commitments: "Commitment" }[key]} ${index + 1}`;
          if (key === "priorityTaskIds") {
            this.add(prefix, await this.task(item));
            continue;
          }
          const row = object(item);
          if (
            !row ||
            !keys(
              row,
              key === "corrections" ? ["taskId", "note", "source"] : ["taskId", "decision"]
            )
          )
            throw new Error("Invalid intent item");
          this.add(`${prefix}: task`, await this.task(row.taskId));
          if (key === "corrections") {
            this.add(`${prefix}: note`, text(row.note));
            this.add(`${prefix}: source`, choice(row.source, "source"));
          } else this.add(`${prefix}: decision`, choice(row.decision, "decision"));
        }
      }
    }
  }
  async blocks(value: unknown, additions: boolean): Promise<void> {
    if (!Array.isArray(value)) throw new Error("Invalid blocks");
    if (!value.length) this.add(additions ? "New tasks" : "Draft blocks", "None");
    for (const [index, item] of value.entries()) {
      const row = object(item);
      const prefix = `${additions ? "New task" : "Block"} ${index + 1}`;
      if (
        !row ||
        !keys(
          row,
          additions ? ["taskId", "title"] : ["id", "kind", "taskId", "title", "pendingChange"]
        )
      )
        throw new Error("Invalid block");
      if (row.id !== undefined) {
        const saved = this.plan?.blocks.find((block) => block.id === row.id);
        if (!saved) throw new Error("Unavailable block");
        this.add(`${prefix}: current`, saved.title ?? (await this.task(saved.taskId)));
      }
      this.add(`${prefix}: task`, await this.task(row.taskId));
      if (row.title !== undefined) this.add(`${prefix}: title`, text(row.title));
      if (!additions) this.add(`${prefix}: kind`, choice(row.kind, "kind"));
      if (row.pendingChange !== undefined) {
        if (row.pendingChange === null) {
          this.add(`${prefix}: change`, "None");
          continue;
        }
        const change = object(row.pendingChange);
        if (!change || !keys(change, ["kind", "startsAt", "durationMinutes"]))
          throw new Error("Invalid change");
        this.add(`${prefix}: change`, choice(change.kind, "change"));
        if (change.startsAt !== undefined) this.add(`${prefix}: start`, text(change.startsAt));
        if (change.durationMinutes !== undefined)
          this.add(
            `${prefix}: minutes`,
            typeof change.durationMinutes === "number" ? String(change.durationMinutes) : null
          );
      }
    }
  }
  result(target: string): HumanActionDetails {
    return {
      target,
      fields: this.fields,
      version: createHash("sha256")
        .update(JSON.stringify([this.plan, this.references]))
        .digest("hex")
    };
  }
}

async function present(
  db: unknown,
  raw: unknown,
  actor: string,
  planId?: string,
  tool = false
): Promise<HumanActionDetails | null> {
  assertDataContextDb(db);
  const body = object(raw);
  if (
    !dependencies ||
    !body ||
    !keys(
      body,
      tool
        ? ["planId", "expectedRevision", "eveningIntent", "additions"]
        : planId
          ? ["date", "timeZone", "expectedRevision", "eveningIntent", "blocks"]
          : ["date", "timeZone", "sourceRunId"]
    )
  )
    return null;
  if (tool || planId) {
    if (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) return null;
  }
  if (!tool && (typeof body.date !== "string" || typeof body.timeZone !== "string")) return null;
  const plan = planId ? ((await dependencies.dayPlanRepository.getById(db, planId)) ?? null) : null;
  if (planId && !plan) return null;
  const view = new PlanDisclosure(db, actor, plan);
  try {
    if (body.date !== undefined) view.add("Date", text(body.date));
    if (body.timeZone !== undefined) view.add("Time zone", text(body.timeZone));
    if (body.expectedRevision !== undefined)
      view.add(
        "Plan version",
        typeof body.expectedRevision === "number" ? String(body.expectedRevision) : null
      );
    if (body.sourceRunId !== undefined) {
      if (body.sourceRunId === null) view.add("Briefing", "None");
      else {
        if (typeof body.sourceRunId !== "string") return null;
        const run = await dependencies.findRun(db, body.sourceRunId);
        if (!run || run.owner_user_id !== actor) return null;
        view.references.push(run);
        view.add(
          "Briefing",
          `${run.briefing_type === "morning" ? "Morning" : run.briefing_type === "evening" ? "Evening" : "Briefing"} · ${new Date(run.created_at).toISOString()}`
        );
      }
    }
    if (body.eveningIntent !== undefined) await view.intent(body.eveningIntent);
    if (body.blocks !== undefined) await view.blocks(body.blocks, false);
    if (body.additions !== undefined) await view.blocks(body.additions, true);
    const day = plan?.localDay ?? (typeof body.date === "string" ? body.date : null);
    const zone = plan?.timeZone ?? (typeof body.timeZone === "string" ? body.timeZone : null);
    return day && zone ? view.result(`Day plan · ${day} · ${zone}`) : null;
  } catch {
    return null;
  }
}

export const createDayPlanPresentation: RouteApprovalPresentation = async (db, input, ctx) =>
  input.query && Object.keys(input.query).length ? null : present(db, input.body, ctx.actorUserId);
export const saveDayPlanPresentation: RouteApprovalPresentation = async (db, input, ctx) =>
  input.query && Object.keys(input.query).length
    ? null
    : present(db, input.body, ctx.actorUserId, input.params.id);
export const dayPlanDraftPresentation: ToolApprovalPresentation = async (db, input, ctx) =>
  typeof input.planId === "string" ? present(db, input, ctx.actorUserId, input.planId, true) : null;
