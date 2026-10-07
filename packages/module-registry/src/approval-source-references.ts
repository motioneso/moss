import { createHash } from "node:crypto";
import { isUuid } from "@moss/db";
import { CalendarRepository } from "@moss/calendar";
import { ChatRepository } from "@moss/chat";
import { EmailRepository } from "@moss/email";
import { resolveNoteApprovalTarget } from "@moss/notes";
import { MemoryForgetService } from "@moss/memory";
import { TasksRepository } from "@moss/tasks";
import type { MossModuleManifest } from "@moss/module-sdk";
import type { GoalApprovalSourceResolver } from "@moss/goals";

/** Public owning-module readers only; every call retains the requesting actor's data scope. */
export function createApprovalSourceReferences(
  deps: {
    manifests?: () => readonly MossModuleManifest[];
    tasks?: Pick<TasksRepository, "getById">;
    calendar?: Pick<CalendarRepository, "getById">;
    email?: Pick<EmailRepository, "getById">;
    chat?: Pick<ChatRepository, "getMessageById" | "getThreadById">;
    note?: typeof resolveNoteApprovalTarget;
    memory?: Pick<MemoryForgetService, "target">;
  } = {}
): GoalApprovalSourceResolver {
  const tasks = deps.tasks ?? new TasksRepository();
  const calendar = deps.calendar ?? new CalendarRepository();
  const email = deps.email ?? new EmailRepository();
  const chat = deps.chat ?? new ChatRepository();
  const note = deps.note ?? resolveNoteApprovalTarget;
  const memory = deps.memory ?? new MemoryForgetService();
  const target = (label: string, row: unknown) => ({
    label,
    version: createHash("sha256").update(JSON.stringify(row)).digest("hex")
  });
  return async (db, input) => {
    if (deps.manifests) {
      const sourceModules = {
        task: "tasks",
        calendar: "calendar",
        email: "email",
        chat: "chat",
        note: "notes",
        memory: "memory"
      } as const;
      const moduleId = Object.hasOwn(sourceModules, input.sourceKind)
        ? sourceModules[input.sourceKind as keyof typeof sourceModules]
        : null;
      const module = deps.manifests().find((entry) => entry.id === moduleId);
      // These public readers currently belong to required modules. A new optional source needs
      // its explicit enablement boundary before this bridge can read it.
      if (
        !module ||
        module.availability?.required !== true ||
        (module.aiConsent && !(await module.aiConsent.isGranted(db, input.actorUserId)))
      )
        throw new Error("Approval source unavailable");
    }

    if (input.sourceKind === "note") {
      try {
        const resolved = await note(db, input.sourceRef, false);
        const parts = resolved.relative.split("/");
        const name = parts.pop()!;
        return {
          label: [name, ...parts.map((value, index) => `Folder ${index + 1}: ${value}`)].join("\n"),
          version: resolved.version
        };
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw new Error("Approval source unavailable", { cause: error });
      }
    }
    if (!isUuid(input.sourceRef)) return null;
    if (input.sourceKind === "memory") return memory.target(db, input.actorUserId, input.sourceRef);
    if (input.sourceKind === "task") {
      const row = await tasks.getById(db, input.sourceRef);
      return row?.owner_user_id === input.actorUserId ? target(row.title, row) : null;
    }
    if (input.sourceKind === "calendar") {
      const row = await calendar.getById(db, input.sourceRef);
      return row?.owner_user_id === input.actorUserId
        ? target(`${row.title}\n${new Date(row.starts_at).toISOString()}`, row)
        : null;
    }
    if (input.sourceKind === "email") {
      const row = await email.getById(db, input.sourceRef);
      return row?.owner_user_id === input.actorUserId
        ? target(`${row.subject}\n${row.sender}`, row)
        : null;
    }
    if (input.sourceKind === "chat") {
      const row = await chat.getMessageById(db, input.sourceRef);
      if (row?.owner_user_id !== input.actorUserId) return null;
      if (
        row.tool_metadata &&
        typeof row.tool_metadata === "object" &&
        "meetingChatV1" in row.tool_metadata
      )
        throw new Error("Approval source unavailable");
      const thread = await chat.getThreadById(db, row.thread_id);
      if (!thread || thread.owner_user_id !== input.actorUserId || thread.incognito)
        throw new Error("Approval source unavailable");
      return target(row.body, [row, thread.id]);
    }
    return null;
  };
}
