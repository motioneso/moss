import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";

export const INTEGRATIONS_MODULE_ID = "integrations";

export const integrationsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const INTEGRATION_CLASSIFIER_SORT_QUEUE = "integrations.classifier-sort";
export const INTEGRATION_CLASSIFIER_PREPARE_QUEUE = "integrations.classifier-prepare";

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
    { method: "GET", path: "/api/integrations", chat: { access: "read" } },
    {
      method: "POST",
      path: "/api/integrations",
      chat: { access: "blocked", blockedBecause: "secrets" }
    },
    {
      method: "GET",
      path: "/api/integrations/:id",
      chat: { access: "blocked", blockedBecause: "self_authority" }
    },
    {
      method: "PATCH",
      path: "/api/integrations/:id",
      chat: { access: "blocked", blockedBecause: "secrets" }
    },
    {
      method: "POST",
      path: "/api/integrations/:id/refresh",
      chat: { access: "blocked", blockedBecause: "external_effect" }
    },
    {
      method: "DELETE",
      path: "/api/integrations/:id",
      chat: { access: "blocked", blockedBecause: "external_effect" }
    },
    {
      method: "PUT",
      path: "/api/integrations/:id/classifier/kept-out",
      chat: { access: "blocked", blockedBecause: "self_authority" }
    },
    {
      method: "POST",
      path: "/api/integrations/:id/classifier/prepare",
      chat: { access: "blocked", blockedBecause: "self_authority" }
    },
    {
      method: "POST",
      path: "/api/integrations/:id/classifier/sort",
      chat: { access: "blocked", blockedBecause: "self_authority" }
    },
    {
      method: "PUT",
      path: "/api/integrations/:id/classifier/send-without-asking",
      chat: { access: "blocked", blockedBecause: "self_authority" }
    }
  ],
  jobs: [
    { queueName: INTEGRATION_CLASSIFIER_SORT_QUEUE, metadataOnly: true },
    { queueName: INTEGRATION_CLASSIFIER_PREPARE_QUEUE, metadataOnly: true }
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
      id: "integrations.connection_tool_sorting",
      description:
        "When a connection is added or refreshed, the owner's chat model sorts each tool by what " +
        "it does and names it. A tool holding the credential is not sent; delete is always " +
        "sensitive. Failures wait for Try again, unless no model was set up."
    },
    {
      id: "integrations.connection_tools_ask_first",
      description:
        "Outside YOLO, connected tools sorted as Looks things up or Changes things run without " +
        "asking. Sends things out asks until the owner allows it. Sensitive, unsorted, failed and " +
        "changed tools always ask; the detail shows which ask first."
    },
    {
      // #2956: the Activity history line title for the background tool-sorting call.
      id: "structured.integrations.tool-sort",
      description: "Sorted a connection's tools"
    },
    {
      // The Activity history line title for the background tool-preparation call.
      id: "structured.integrations.tool-prepare",
      description: "Prepared a connection's tool for quick requests"
    },
    {
      id: "integrations.connection_detail_grouped_tools",
      description:
        "A connection's page groups its tools by what they do, one switch each, Asks first " +
        "marked. Sending tools can send without asking, singly or as a confirmed group. Moss " +
        "never blocks a tool for repeating an identical call."
    },
    {
      id: "integrations.connection_classifier_opt_in",
      description:
        "With a connection's classifier switch on, each tool on for chat answers quick requests " +
        "once sorted and prepared. A kept-out tool stays out; a changed tool drops out until it " +
        "is prepared again."
    },
    {
      id: "integrations.connection_classifier_panel",
      description:
        "The Classifier panel shows Off, a one-time confirmation of what is sent and what it " +
        "costs, Preparing with progress, Ready with how many tools answer and always ask, a " +
        "tool changed, Couldn't prepare with Try again, No tools left, or Paused."
    },
    {
      id: "integrations.connection_classifier_keep_out",
      description:
        "Each tool's menu has Keep out of the classifier, with an Undo. Ordinary chat can still " +
        "use a kept-out tool. Let the classifier use it puts the tool back and prepares it."
    },
    {
      id: "integrations.connection_sorting_line",
      description:
        "Tools show a readable name over the raw name. The Connection panel says when tools " +
        "were sorted, which models read them, and how many Moss sorted without sending them " +
        "(only the date if unrecorded). A failed sort gets Try again."
    },
    {
      id: "integrations.connection_classifier_preparation",
      description:
        "With the classifier switch on, sorted chat tools are prepared on the owner's model, " +
        "again when changed. A tool holding the credential is not sent. Failures wait for " +
        "Try again, unless no model was set up; those resume once one is.",
      remediations: [
        {
          id: "integrations.connection_classifier_preparation.choose_chat_model",
          description:
            "Choose a chat model that supports structured output in Settings, Your assistant, " +
            "then open the connection again. Tools that waited for a model prepare by themselves.",
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
        },
        {
          code: "integrations.connection_classifier_preparation.unsupported_shape",
          class: "validation",
          description:
            "A tool has more inputs or longer text than quick requests can hold, so it stays out."
        },
        {
          code: "integrations.connection_classifier_preparation.too_many_tools",
          class: "validation",
          description:
            "The connection already has the most prepared tools it can hold, so this one stays out."
        }
      ]
    },
    {
      id: "integrations.connection_classifier_candidates",
      description:
        "When the gate is active, a tool that needs a device or area name can pick from the " +
        "connection's list, read through a prepared tool sorted as Looks things up and cached " +
        "briefly for its owner. A missing or expired list keeps the tool out.",
      remediations: [
        {
          id: "integrations.connection_classifier_candidates.refresh",
          description:
            "Switch on the connection's device-listing tool and make sure it is not kept out of " +
            "the classifier.",
          path: "/settings?section=integrations"
        }
      ],
      errors: [
        {
          code: "integrations.connection_classifier_candidates.unavailable",
          class: "prerequisite",
          remediationRef: "integrations.connection_classifier_candidates.refresh",
          description:
            "A tool needs a device or area name, but the connection has no current list of them."
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
