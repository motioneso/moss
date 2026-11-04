import type { MossModuleManifest } from "@moss/module-sdk";

type Feature = NonNullable<MossModuleManifest["features"]>[number];

export const platformDiagnosticsFeatures: readonly Feature[] = [
  {
    id: "settings.platformDiagnostics",
    description:
      "Moss explains why a job, sync or connection is not working. The jobs and connections sections are for instance admins only. Other users get them listed as redacted, with no data.",
    errors: [
      {
        code: "admin_only_section",
        class: "prerequisite",
        description:
          "The jobs and connections sections are hidden from users who are not instance admins.",
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
    id: "settings.platformDiagnostics.limits",
    description:
      "Each list in a diagnosis holds at most 10 items, and the jobs and connections sections hold at most 16 KB each. They never include job payloads, failure text or log lines. Moss cannot yet show application log lines."
  }
];
