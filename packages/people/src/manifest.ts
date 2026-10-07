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
  // Canonical-note writes enqueue ingest. Identity merge/split cannot preview all targets
  // through the current path-parameter-only target contract, so both remain unavailable here.
  routes: [
    { method: "GET", path: "/api/people/notes-directories", chat: { access: "read" } },
    { method: "GET", path: "/api/people", chat: { access: "read", content: "outside" } },
    {
      method: "POST",
      path: "/api/people",
      chat: { access: "blocked", blockedBecause: "external_effect" }
    },
    {
      method: "GET",
      path: "/api/people/resolve",
      chat: { access: "read", content: "outside", coveredBy: "people.resolve" }
    },
    {
      method: "GET",
      path: "/api/people/match-candidates",
      chat: { access: "read", content: "outside" }
    },
    {
      method: "POST",
      path: "/api/people/match-candidates/:id/accept",
      chat: {
        access: "write",
        title: "Accept People match",
        content: "user_authored",
        coveredBy: "people.acceptMatch"
      }
    },
    {
      method: "POST",
      path: "/api/people/match-candidates/:id/reject",
      chat: {
        access: "write",
        title: "Reject People match",
        content: "user_authored",
        coveredBy: "people.rejectMatch"
      }
    },
    {
      method: "POST",
      path: "/api/people/match-candidates/:id/suppress",
      chat: { access: "write", title: "Suppress People match", content: "user_authored" }
    },
    {
      method: "POST",
      path: "/api/people/index/refresh",
      chat: { access: "blocked", blockedBecause: "external_effect" }
    },
    {
      method: "GET",
      path: "/api/people/notes-settings",
      chat: { access: "read", content: "user_authored" }
    },
    {
      method: "PUT",
      path: "/api/people/notes-settings",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" }
    },
    {
      method: "POST",
      path: "/api/people/notes/refresh",
      chat: { access: "blocked", blockedBecause: "external_effect" }
    },
    {
      method: "GET",
      path: "/api/people/:id",
      chat: { access: "read", content: "outside", coveredBy: "people.getContext" }
    },
    { method: "GET", path: "/api/people/:id/links", chat: { access: "read", content: "outside" } },
    {
      method: "PATCH",
      path: "/api/people/:id",
      chat: { access: "blocked", blockedBecause: "external_effect" }
    },
    {
      method: "POST",
      path: "/api/people/:id/archive",
      chat: { access: "blocked", blockedBecause: "external_effect" }
    },
    {
      method: "POST",
      path: "/api/people/:id/merge",
      chat: { access: "blocked", blockedBecause: "module_promise" }
    },
    {
      method: "POST",
      path: "/api/people/:id/split-identity",
      chat: { access: "blocked", blockedBecause: "module_promise" }
    }
  ],
  features: [
    {
      id: "people.chat_app_actions",
      description:
        "App actions read People and review matches. Note-backed writes, ingestion, merges and identity splits remain unavailable through this path."
    }
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
