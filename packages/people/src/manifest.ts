import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";
import { PEOPLE_TOOLS } from "./tools.js";

export const PEOPLE_MODULE_ID = "people";
export const PEOPLE_MODULE_VERSION = "0.1.0";

export const peopleModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const peopleModuleManifest: MossModuleManifest = {
  id: PEOPLE_MODULE_ID,
  name: "People & Context",
  publisher: "Moss",
  version: PEOPLE_MODULE_VERSION,
  // #996/#860: Commitments (and People/Goals) moved from user-toggleable to required —
  // spec 2026-07-12-module-management-admin-ux.md decided core productivity modules
  // should never be turned off; only Wellness/Sports/News stay user-toggleable.
  lifecycle: "required",
  availability: { defaultEnabled: true, required: true },
  compatibility: { jarv1s: ">=0.0.0" },
  database: {
    migrations: ["0128_person_context.sql"],
    ownedTables: [
      "app.person_context_people",
      "app.person_context_identities",
      "app.person_context_links",
      "app.person_context_link_sources",
      "app.person_context_match_candidates",
      "app.person_context_events",
      "app.person_context_indexing_state"
    ]
  },
  routes: [
    { method: "GET", path: "/api/people" },
    { method: "POST", path: "/api/people" },
    { method: "GET", path: "/api/people/resolve" },
    { method: "GET", path: "/api/people/match-candidates" },
    { method: "POST", path: "/api/people/match-candidates/:id/accept" },
    { method: "POST", path: "/api/people/match-candidates/:id/reject" },
    { method: "POST", path: "/api/people/match-candidates/:id/suppress" },
    { method: "POST", path: "/api/people/index/refresh" },
    { method: "GET", path: "/api/people/notes-settings" },
    { method: "PUT", path: "/api/people/notes-settings" },
    { method: "POST", path: "/api/people/notes/refresh" },
    { method: "GET", path: "/api/people/:id" },
    { method: "GET", path: "/api/people/:id/links" },
    { method: "PATCH", path: "/api/people/:id" },
    { method: "POST", path: "/api/people/:id/archive" },
    { method: "POST", path: "/api/people/:id/merge" },
    { method: "POST", path: "/api/people/:id/split-identity" }
  ],
  sourceBehaviors: [
    {
      id: "people-notes",
      name: "People notes",
      description:
        "People records projected from the People notes folder, which is chosen from the same " +
        "list of available folders as the notes folder and lives inside the chosen notes folder.",
      behaviors: [
        {
          id: "people.notes.suggest-updates",
          name: "Suggest note updates",
          description:
            "Create review candidates for assistant-managed People note updates instead of silently changing human notes.",
          default: "default-on"
        }
      ]
    }
  ],
  assistantActionFamilies: [
    {
      id: "people_review",
      label: "Match review",
      description: "Accept or reject People match candidates.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: PEOPLE_TOOLS
};
