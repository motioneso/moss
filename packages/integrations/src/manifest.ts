import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";

export const INTEGRATIONS_MODULE_ID = "integrations";

export const integrationsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const integrationsModuleManifest = {
  id: INTEGRATIONS_MODULE_ID,
  name: "Integrations",
  publisher: "Moss",
  version: "1.0.0",
  lifecycle: "required",
  availability: { defaultEnabled: true, required: true },
  compatibility: { jarv1s: ">=0.0.0" },
  // Chat tools are dynamic (one per discovered connection tool), so there is no static
  // assistantTools list — see Task 8.
  routes: [
    { method: "GET", path: "/api/integrations" },
    { method: "POST", path: "/api/integrations" },
    { method: "GET", path: "/api/integrations/:id" },
    { method: "PATCH", path: "/api/integrations/:id" },
    { method: "POST", path: "/api/integrations/:id/refresh" },
    { method: "DELETE", path: "/api/integrations/:id" },
    { method: "PUT", path: "/api/integrations/:id/classifier/tools/:toolName" },
    { method: "DELETE", path: "/api/integrations/:id/classifier/tools/:toolName" },
    { method: "POST", path: "/api/integrations/:id/classifier/prepare" }
  ],
  dataLifecycle: {
    exportSections: [],
    deletion: {
      strategy: "cascade",
      tables: [{ table: "app.integration_connections" }]
    }
  },
  features: [
    {
      id: "integrations.connection_detail_grouped_tools",
      description:
        "A connection's tool list is grouped, with each tool getting a per-tool switch to allow " +
        "repeated identical calls (off by default). Notes explain grandfathered connections and " +
        "point to Refresh tools when read/repeat hints are missing."
    },
    {
      id: "integrations.connection_classifier_opt_in",
      description:
        "A connection can be opted into the chat classifier, one tool at a time. Each opt-in " +
        "needs an owner-reviewed risk; a tool with no confirmed label stays out, a changed tool " +
        "definition marks the review stale, and each unusable tool names why."
    },
    {
      id: "integrations.connection_classifier_review",
      description:
        "The classifier section on a connection reviews each tool's description, reply and risk " +
        "before use. Drafts look different from saved reviews, every unusable tool names why, and " +
        "the connection switch never opts a tool in."
    },
    {
      id: "integrations.connection_classifier_preparation",
      description:
        "Prepares a connection's tools for the chat classifier: the owner's own model drafts " +
        "each tool's description and reply from its definition once. Preparing costs model " +
        "usage; a model that cannot draft shows a setup failure.",
      remediations: [
        {
          id: "integrations.connection_classifier_preparation.choose_chat_model",
          description:
            "Choose a chat model that supports structured output in Settings, Assistant & AI, " +
            "then prepare again.",
          path: "/settings?section=assistant"
        }
      ],
      errors: [
        {
          code: "integrations.connection_classifier_preparation.no_default_model",
          class: "prerequisite",
          remediationRef: "integrations.connection_classifier_preparation.choose_chat_model",
          description: "No default chat model is set, so tool preparation cannot run."
        },
        {
          code: "integrations.connection_classifier_preparation.model_cannot_draft",
          class: "prerequisite",
          remediationRef: "integrations.connection_classifier_preparation.choose_chat_model",
          description: "The default chat model cannot produce the structured setup draft for tools."
        }
      ]
    },
    {
      id: "integrations.credentials_paused",
      description:
        "Integration credentials pause when no encryption key is set up. Credentialed tools " +
        "stay unlisted until an admin generates a key.",
      remediations: [
        {
          id: "integrations.credentials_paused.generate_key",
          description: "Ask an admin to open Settings, Encryption keys, and press Generate.",
          path: "/settings?section=enckeys"
        }
      ],
      errors: [
        {
          code: "integrations.credentials_paused.no_key",
          class: "prerequisite",
          remediationRef: "integrations.credentials_paused.generate_key",
          description: "No integrations encryption key is set up."
        }
      ]
    }
  ]
} satisfies MossModuleManifest;
