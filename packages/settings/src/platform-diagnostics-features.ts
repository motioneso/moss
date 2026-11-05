import type { MossModuleManifest } from "@moss/module-sdk";

type Feature = NonNullable<MossModuleManifest["features"]>[number];

export const platformDiagnosticsFeatures: readonly Feature[] = [
  {
    id: "settings.platformDiagnostics",
    description:
      "Moss explains why a job, sync or connection is not working. The jobs, connections and logs sections are for instance admins only. Other users get them listed as redacted, with no data.",
    errors: [
      {
        code: "admin_only_section",
        class: "prerequisite",
        description:
          "The jobs, connections and logs sections are hidden from users who are not instance admins.",
        remediationRef: "settings.diagnostics_admin"
      }
    ],
    remediations: [
      {
        id: "settings.diagnostics_admin",
        description: "Ask an instance admin to run the diagnosis or review instance admin access.",
        path: "/settings"
      }
    ]
  },
  {
    id: "settings.platformDiagnostics.jobs",
    description:
      "Recent job runs from the last 24 hours: queue, state, retry count, time, and per-queue last success, failures and stuck jobs. Kind and connection id show only for your own jobs. Covers API and worker jobs."
  },
  {
    id: "settings.platformDiagnostics.connections",
    description:
      "Your connections: status, last attempt, last good sync, failure count and a fixed error label. Outlook calendar partial cannot tell an incomplete scan from an unreachable helper."
  },
  {
    id: "settings.platformDiagnostics.logs",
    description:
      "Stored warnings and errors from the API and the worker, instance admins only. Filter by time (up to 24 hours back), level, component and connection kind. Shows the full message only for records tied to your own account. Other records show time, component and level, with no text. Logs keep about 7 days and about 50,000 records, enforced hourly, so the store can briefly hold more. A heavy burst may drop records, and some records have no known owner.",
    errors: [
      {
        code: "log_store_empty_or_gap",
        class: "prerequisite",
        description:
          "The log store has no matching records, or the oldest record is newer than the time asked about. The coverage field says how far back logs go.",
        remediationRef: "settings.diagnostics_logs_gap"
      }
    ],
    remediations: [
      {
        id: "settings.diagnostics_logs_gap",
        description:
          "Say how far back the stored logs go and that earlier or dropped records cannot be shown. Reproduce the problem and ask again.",
        path: "/settings"
      }
    ]
  },
  {
    id: "settings.platformDiagnostics.limits",
    description:
      "Each list in a diagnosis holds at most 10 items, and the jobs, connections and logs sections hold at most 16 KB each. Jobs and connections never include job payloads or failure text. Log text appears only for records tied to the asking admin, at most 500 characters each, and never includes stored context."
  }
];
