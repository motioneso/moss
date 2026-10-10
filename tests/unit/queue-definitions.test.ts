import { describe, expect, it } from "vitest";

import { getAllQueueDefinitions } from "@moss/module-registry";

// Pins every registered pg-boss queue, in registration order. Moved out of
// tests/integration/ai-tools.test.ts (which keeps its DataContext-only repository checks) because
// it needs no database. The list proving there is no assistant-tool queue is the point: adding a
// queue is a visible act that updates this file.
describe("registered queue definitions", () => {
  it("lists every queue, with no assistant-tool queue", () => {
    expect(getAllQueueDefinitions().map((queue) => queue.name)).toEqual([
      "rls-probe",
      "system.upgrade-check",
      "system.upgrade-notify",
      "platform.module-control",
      "module-build",
      "system.focus-judgment-purge",
      "export.build",
      "export.cleanup",
      "connectors.google-sync",
      "connectors.google-sync-continuation",
      "connectors.google-sync-sweep",
      "connectors.imap-sync",
      "connectors.email-refresh-account",
      "connectors.email-refresh-dispatch",
      "connectors.email-refresh-sweep",
      "connectors.email-monitor",
      "connectors.calendar-monitor",
      "tasks-deferred-status",
      "tasks-recurrence-materialize",
      "goals-memory-sync",
      "goals-memory-sync-reconcile",
      "integrations.classifier-sort",
      "integrations.classifier-prepare",
      "notifications.digest.compose",
      "notifications.push.deliver",
      "notifications.push.summary",
      "calendar.cache-evict-event",
      "calendar.day-plan-apply",
      "ai-purge-audit-log",
      "ai-purge-activity-detail",
      "chat.embed-turn",
      "chat.extract-facts",
      "chat.archive-day",
      "chat.summarize-conversation",
      "chat.deliver-reminder",
      "briefings-run",
      "memory.vault-ingest-sweep",
      "memory.vault-ingest-nudge",
      "memory.vault-ingest-tick",
      "wellness-export",
      "news.refresh",
      "news.revalidate",
      "notes.sync",
      "meetings.stop-summary",
      "meetings.capture-maintenance",
      "proactive-scan-source",
      "commitment-extraction",
      "commitment-email-judgement",
      "person-index",
      "sync-person-memory",
      "workflow.step.deadletter",
      "workflow.step.execute",
      "backtrack.index",
      "backtrack.upkeep"
    ]);
  });
});
