import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import { emailMonitorProvider } from "./monitor-provider.js";
import {
  emailTaskCreationModeResponseSchema,
  getEmailMessageResponseSchema,
  getEmailBriefingSettingsResponseSchema,
  listEmailMessagesResponseSchema,
  updateEmailBriefingSettingsRequestSchema,
  updateEmailTaskCreationModeRequestSchema
} from "@moss/shared";

import {
  emailDraftReplyExecute,
  emailListVisibleMessagesExecute,
  emailReplyPreview,
  emailSendReplyExecute,
  emailToolMessageOutputSchema,
  summarizeDraftReply,
  summarizeSendReply
} from "./tools.js";

export const EMAIL_MODULE_ID = "email";
export const emailModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const emailModuleManifest = {
  id: EMAIL_MODULE_ID,
  name: "Email",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "required",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: true
  },
  database: {
    migrations: [
      "sql/0012_email_module.sql",
      "sql/0067_email_summary_signals_columns.sql",
      "sql/0068_email_worker_grants_and_google_insert.sql"
    ],
    migrationDirectories: ["packages/email/sql"],
    ownedTables: ["app.email_messages"]
  },
  // No user-facing surface: email is an ingestion source for Jarv1s (assistant tools +
  // cache), not a screen the user browses. The viewer was retired; the assistant tool and
  // REST cache APIs remain so Jarvis can read/learn from messages.
  navigation: [],
  settings: [
    {
      id: "email.module-settings",
      label: "Email",
      description:
        "Choose which email signals show up in briefings, how email turns into tasks, and " +
        "whether your assistant drafts or auto-sends replies.",
      path: "/settings/modules/email",
      scope: "user",
      order: 40,
      permissionId: "email.manage",
      entry: "./settings"
    }
  ],
  features: [
    {
      id: "email.skip-sign-in-code-emails",
      description:
        "A message delivering a temporary sign-in code (one-time code, login code, two-factor " +
        "code) is left out of briefings and never turns into a task, even if it was saved " +
        "before this check existed."
    }
  ],
  permissions: [
    {
      id: "email.view",
      label: "View email",
      description: "Read cached email messages owned by or shared with the active actor.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "email.manage",
      label: "Manage email module",
      description: "Manage Email module settings and connector-backed cache behavior.",
      scope: "user",
      actions: ["manage"]
    }
  ],
  featureFlags: [
    {
      id: "email.module",
      label: "Email module",
      description: "Enables the built-in connector-backed Email read surface.",
      scope: "system",
      defaultEnabled: true
    }
  ],
  sourceBehaviors: [
    {
      id: "email",
      name: "Email",
      description:
        "What your assistant is allowed to do with your email — independent of whichever service powers it.",
      behaviors: [
        {
          id: "email.briefings",
          name: "Include in briefings",
          description: "Flag threads that need a reply today.",
          default: "default-on"
        },
        {
          id: "email.capture-tasks",
          name: "Capture tasks",
          description:
            "Turn emails into tasks when they imply an action. Suggested by default; " +
            "auto modes are opt-in per user.",
          default: "default-on"
        },
        {
          id: "email.thread-summaries",
          name: "Thread summaries",
          description: "Condense long threads before you open them.",
          default: "coming-soon"
        },
        {
          id: "email.send-on-behalf",
          name: "Send on my behalf",
          description: "Draft and send replies, with your approval.",
          default: "default-on"
        }
      ]
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/email/messages",
      responseSchema: listEmailMessagesResponseSchema,
      permissionId: "email.view"
    },
    {
      method: "GET",
      path: "/api/email/messages/:id",
      responseSchema: getEmailMessageResponseSchema,
      permissionId: "email.view"
    },
    {
      method: "GET",
      path: "/api/email/briefing-settings",
      responseSchema: getEmailBriefingSettingsResponseSchema,
      permissionId: "email.manage"
    },
    {
      method: "PATCH",
      path: "/api/email/briefing-settings",
      requestSchema: updateEmailBriefingSettingsRequestSchema,
      responseSchema: getEmailBriefingSettingsResponseSchema,
      permissionId: "email.manage"
    },
    {
      method: "GET",
      path: "/api/email/task-creation-mode",
      responseSchema: emailTaskCreationModeResponseSchema,
      permissionId: "email.manage"
    },
    {
      method: "PUT",
      path: "/api/email/task-creation-mode",
      requestSchema: updateEmailTaskCreationModeRequestSchema,
      responseSchema: emailTaskCreationModeResponseSchema,
      permissionId: "email.manage"
    }
  ],
  assistantActionFamilies: [
    {
      id: "email_drafts",
      label: "Draft email replies",
      description:
        "Let your assistant draft replies to your emails. Drafts land in Gmail for you to review — " +
        "nothing is sent without your say-so.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "email.listVisibleMessages",
      description:
        "List the actor's recent email, read live from each connected account with triage " +
        "(actionability, importance) attached; falls back to cache only on transient provider " +
        "failures, with source and gap metadata.",
      permissionId: "email.view",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {}
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["messages", "accounts", "gaps"],
        properties: {
          messages: {
            type: "array",
            items: emailToolMessageOutputSchema
          },
          accounts: {
            type: "array",
            items: {
              type: "object",
              description: "Per-account read outcome: source live|cache and any degradedReason"
            }
          },
          gaps: {
            type: "array",
            items: {
              type: "object",
              description:
                "Accounts that could not be read at all (auth_error, connector_revoked, " +
                "feature_grant_disabled, unsupported_provider, service_unavailable)"
            }
          }
        }
      },
      execute: emailListVisibleMessagesExecute
    },
    {
      name: "email.draftReply",
      description:
        "Draft a reply to a cached email and (on approval) save it as a threaded Gmail draft for " +
        "the user to review. The reply is addressed to the ORIGINAL SENDER on the existing thread " +
        "— the server derives recipient/subject/thread from the cached message; you supply only " +
        "the message id and the reply body. No arbitrary recipients, reply-all, or attachments.",
      permissionId: "email.manage",
      risk: "write",
      actionFamilyId: "email_drafts",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      requiresServices: ["emailWrite"],
      inputSchema: {
        type: "object",
        required: ["cacheMessageId", "body"],
        properties: {
          cacheMessageId: {
            type: "string",
            description: "Moss email message id (uuid) from listVisibleMessages"
          },
          body: { type: "string", description: "Plain-text reply body composed for the sender" }
        }
      },
      execute: emailDraftReplyExecute,
      summarize: summarizeDraftReply,
      preview: emailReplyPreview
    },
    {
      name: "email.sendReply",
      description:
        "Send a reply to a cached email on the existing thread. ALWAYS asks for confirmation and " +
        "sends immediately on approval. Addressed to the ORIGINAL SENDER — the server derives " +
        "recipient/subject/thread from the cached message; you supply only the message id and the " +
        "reply body. No arbitrary recipients, reply-all, or attachments.",
      permissionId: "email.manage",
      risk: "destructive",
      // No actionFamilyId / executionPolicy → the gateway's destructive floor always confirms
      // (policy.ts unchanged). There is no tier that can promote this to auto-send.
      // Ben's ruling, 2026-07-26 (#1263 Task 11): "Jarvis should approve for email" — this
      // REPLACES an earlier granted_at_install classification for this tool, which is withdrawn.
      // selfOperationGrant below declares confirm_always to make that guarantee visible to the
      // Task 2 assertion; it changes no runtime behavior. The only escape hatch is global YOLO
      // mode, never a per-family email auto-send path.
      selfOperationGrant: "confirm_always",
      requiresServices: ["emailWrite"],
      inputSchema: {
        type: "object",
        required: ["cacheMessageId", "body"],
        properties: {
          cacheMessageId: {
            type: "string",
            description: "Moss email message id (uuid) from listVisibleMessages"
          },
          body: { type: "string", description: "Plain-text reply body composed for the sender" }
        }
      },
      execute: emailSendReplyExecute,
      summarize: summarizeSendReply,
      preview: emailReplyPreview
    }
  ],
  proactiveMonitor: emailMonitorProvider
} satisfies MossModuleManifest;
