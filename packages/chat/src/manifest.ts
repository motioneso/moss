import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  getChatPrivacyStateResponseSchema,
  listChatThreadMessagesResponseSchema,
  listChatThreadsResponseSchema,
  listMemoryCorrectionsResponseSchema
} from "@moss/shared";

import { chatListTodaysTurnsExecute } from "./tools.js";
import { chatGetCurrentViewExecute, chatGetCurrentViewOutputSchema } from "./current-view-tool.js";
import { chatGetCurrentTimeExecute, chatGetCurrentTimeOutputSchema } from "./current-time-tool.js";
import { chatReadAttachmentExecute } from "./attachment-tool.js";
import {
  chatSetResponseStyleExecute,
  chatResponseStylePresentation,
  chatSetResponseStyleInputSchema,
  chatSetResponseStyleOutputSchema
} from "./response-style-tool.js";
import {
  chatDeleteClassifierShadowRecordsExecute,
  shadowDeletePresentation,
  shadowDeleteRoutePresentation,
  chatDeleteClassifierShadowRecordsInputSchema,
  chatDeleteClassifierShadowRecordsOutputSchema
} from "./classifier-shadow-tool.js";

const CHAT_MODULE_ID = "chat";
export const chatModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const chatModuleManifest = {
  id: CHAT_MODULE_ID,
  name: "Chat",
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
      "sql/0014_chat_module.sql",
      "sql/0025_chat_owner_or_share.sql",
      "sql/0034_chat_status_activity.sql",
      "sql/0035_chat_messages_update_grant.sql",
      "sql/0036_chat_worker_runtime_grants.sql",
      "sql/0038_chat_live_runtime.sql",
      "sql/0042_chat_memory_settings.sql",
      "sql/0049_chat_conversation_summary.sql",
      "sql/0057_revoke_app_runtime_chat_update.sql",
      "sql/0058_chat_threads_incognito_immutable.sql",
      "sql/0060_chat_memory_settings_to_role.sql",
      "sql/0146_private_chat_cleanup.sql",
      "sql/0149_chat_skills.sql",
      "sql/0174_chat_surface.sql",
      "sql/0251_chat_classifier_shadow_records.sql",
      "sql/0252_chat_classifier_release_eligibility.sql",
      "sql/0255_chat_classifier_shadow_retention.sql",
      "sql/0271_chat_classifier_shadow_reviews.sql",
      "sql/0276_meeting_chat_cleanup.sql",
      "sql/0277_chat_surface_immutable.sql",
      "sql/0291_chat_conversation_provenance.sql",
      "sql/0293_chat_automatic_action_reservations.sql",
      "sql/0297_chat_action_history_permissions.sql",
      "sql/0299_main_chat.sql",
      "sql/0305_chat_summary_frontier.sql",
      "sql/0306_chat_relative_reminders.sql",
      "sql/0307_chat_summary_worker_publish.sql",
      "sql/0308_chat_reminder_cancel.sql",
      "sql/0309_chat_reminder_context_acknowledged.sql",
      "sql/0310_chat_live_turns.sql"
    ],
    migrationDirectories: ["packages/chat/sql"],
    ownedTables: [
      "app.chat_threads",
      "app.chat_messages",
      "app.chat_user_memory_settings",
      "app.chat_skills",
      "app.chat_classifier_shadow_records",
      "app.chat_classifier_release_eligibility",
      "app.chat_classifier_shadow_reviews",
      "app.chat_conversation_provenance",
      "app.chat_automatic_action_reservations",
      "app.chat_live_turns"
    ]
  },
  permissions: [
    {
      id: "chat.view",
      label: "View chat",
      description: "Read chat threads and messages visible to the active actor.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "chat.create",
      label: "Create chat",
      description: "Create chat threads for the active actor.",
      scope: "user",
      actions: ["create"]
    },
    {
      id: "chat.message",
      label: "Append chat messages",
      description:
        "Append user messages and record assistant-side safe routing/tool metadata without execution.",
      scope: "user",
      actions: ["create"]
    }
  ],
  featureFlags: [
    {
      id: "chat.module",
      label: "Chat module",
      description: "Enables the built-in Chat thin slice.",
      scope: "system",
      defaultEnabled: true
    }
  ],
  features: [
    {
      id: "chat.main_conversation",
      description:
        "Reopening Moss returns to your stable Main chat and saved history. The composer waits while Main is restored, " +
        "and the next turn waits for an active conversation resume to finish. Explicit new and private chats keep their selection.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.resume_keeps_decisions",
      description:
        "Returning to the same chat after Moss restarts keeps earlier decisions. Older turns are condensed into a summary " +
        "in the background, and the summary plus every newer turn is restored. Private chats are never condensed.",
      featureFlagId: "chat.module",
      errors: [
        {
          code: "conversation_too_long_to_resume",
          class: "transient",
          description:
            "The conversation is too long to restore in full, so Moss is condensing it. Your history is kept. Try again shortly or start a new chat."
        },
        {
          code: "conversation_could_not_condense",
          class: "transient",
          description:
            "The conversation is too long to restore in full and Moss could not start condensing it. Your history is kept. Try again later or start a new chat."
        },
        {
          code: "conversation_needs_summary_model",
          class: "prerequisite",
          remediationRef: "chat.add_summary_model",
          description:
            "The conversation is too long to restore in full and no AI model that can summarize is set up. Add one in Settings or start a new chat."
        }
      ],
      remediations: [
        {
          id: "chat.add_summary_model",
          description:
            "Set up a model in Settings, AI providers, or ask an admin, then reopen the chat. Starting a new chat also works.",
          path: "/settings?section=aiproviders"
        }
      ]
    },
    {
      id: "chat.automatic_session_handoff",
      description:
        "Moss counts what a chat's model session holds. Before a turn passes the budget, Moss starts a fresh session " +
        "for the same chat and model from its summary and newer turns, once a summary is ready. Not in private chats.",
      featureFlagId: "chat.module",
      errors: [
        {
          code: "chat_changed_during_handoff",
          class: "transient",
          description:
            "You switched chats while Moss was starting the fresh session, so the message was not sent. Moss says your chat changed while it was starting. Send it again."
        },
        {
          code: "chat_model_changed_during_handoff",
          class: "transient",
          description:
            "The chat's AI provider or model changed while Moss was starting the fresh session, so the message was not sent. Send it again."
        }
      ]
    },
    {
      id: "chat.interrupted_reply_recovery",
      description:
        "If Moss restarts or its model stops mid-reply, reopening the chat keeps every finished message once and " +
        "shows the unfinished question with a note that the reply was interrupted. Moss never redoes it on its own. " +
        "Not in private chats.",
      featureFlagId: "chat.module",
      errors: [
        {
          code: "chat_reply_interrupted",
          class: "transient",
          description:
            "Moss was interrupted before finishing a reply. Anything it started may not have completed, so check first, then ask again."
        }
      ]
    },
    {
      id: "chat.relative_reminders",
      description:
        "In Main chat, 'remind me in 10 minutes to stretch' saves a reminder Moss posts once in Main, " +
        "noting if late; its next reply knows it and frees the slot. Up to 20 at once, 30 days ahead. " +
        "No clock times, repeats or private chats.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.reminder_list",
      description:
        "In Main chat, 'list my reminders' shows reminders set in chat: waiting ones with time left, then " +
        "up to 10 recent ones marked sent, cancelled or couldn't be sent. Task reminders are not included.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.reminder_cancel",
      description:
        "In Main chat, 'cancel the reminder to stretch' stops a waiting chat reminder so it never arrives. " +
        "If already sent, Moss says so and frees its place under the limit of 20. " +
        "If different reminders match, Moss names them and cancels none.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.pending_action_disclosure",
      description:
        "App cards show exact server targets and human-readable changes. Memory and note deletion use red Approve. " +
        "Native permissions keep exact commands or paths. Missing details keep Reject only. Outside content adds one notice.",
      errors: [
        {
          code: "invalid_input",
          class: "validation",
          description:
            "Invalid fields or impossible target changes return a correction before approval; nothing executes. The quiet row says details need correcting. Extra-field errors identify safe field names, never values. Correct the fields and ask again."
        },
        {
          code: "approval_setup_required",
          class: "prerequisite",
          remediationRef: "chat.configure_action_source",
          description:
            "Required setup is missing before this action can be prepared. Follow its safe prerequisite reason; notes need a linked folder in Settings, Connections."
        },
        {
          code: "approval_preparation_failed",
          class: "transient",
          description:
            "An unexpected error prevented the app or connected tool from preparing this action. Try again; private dependency details stay hidden. This does not mean setup is missing."
        },
        {
          code: "approval_unavailable",
          class: "prerequisite",
          description:
            "Complete server details are unavailable, so this request cannot be approved.",
          remediationRef: "chat.request_fresh_action"
        }
      ],
      remediations: [
        {
          id: "chat.configure_action_source",
          description:
            "Review the source or connection setup in Settings, Connections. Choose a notes folder if none is linked.",
          path: "/settings?section=sources"
        },
        {
          id: "chat.request_fresh_action",
          description: "Reject the request and ask Moss to find the action again.",
          path: "/today"
        }
      ],
      featureFlagId: "chat.module"
    },
    {
      id: "chat.legacy_memory_delete",
      description:
        "Chat cannot call the old memory-store delete endpoint. Use saved-memory forgetting, which shows the exact memory for approval. Existing screen actions are unchanged."
    },
    {
      id: "chat.conversation_write_confirmation",
      description:
        "Every write, including installed and connected tools, asks on outside or unknown history, even in YOLO. " +
        "Admission is recorded before exposure and survives restart. Native vault reads stop if their conversation cannot be recorded.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.approval_outcomes",
      description:
        "Decided cards become quiet outcomes in their original chat, also after reload. Thinking stays unchanged. " +
        "Failures are explicit. Quiet results retain focus and announcements without a box outline; controls retain visible keyboard focus.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.restored_action_details",
      description:
        "Restored requests use full server details when available. Without them, approval is hidden and decline remains available. " +
        "Expired requests become timed out; outcomes stay with their original conversation.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.action_outcome_delivery",
      description:
        "Live results refresh the originating chat while Moss is answering; history saves separately. " +
        "Opening chat resumes expiry recovery in bounded batches without replaying already saved outcomes.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.automatic_action_outcomes",
      description:
        "Automatic writes show Done or a short failure with a safe action title. Refusals name the action. " +
        "No approval is implied; grants are not completion. Lines stay before the reply after reload.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.acp_answers",
      description:
        "Outside-agent chats require approval for Moss changes from launch because not all native reads can be observed. Selected-meeting questions use the configured API-key model without tools.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.meeting_questions",
      description:
        "Meeting questions use notes and transcript with exact citations. Failed questions remain above their error in the open chat. API-key only, no tools; enabled choices fail closed and admin pins apply. No unrelated memory or automatic export.",
      featureFlagId: "chat.module",
      errors: [
        {
          code: "meeting_chat_unsupported",
          class: "prerequisite",
          remediationRef: "chat.meeting_questions.configure",
          description:
            "Meeting questions need an available API-key model. Remove the About this meeting chip to continue ordinary subscription chat. Enabled overrides fail closed; contact an admin when locked."
        },
        {
          code: "meeting_context_unavailable",
          class: "permission",
          description:
            "The selected meeting was deleted, disabled or is unavailable to this person. Its answer and evidence are withheld."
        },
        {
          code: "meeting_chat_changed",
          class: "transient",
          description:
            "The meeting question was stopped or its selected model or conversation changed. Ask again in the selected meeting."
        },
        {
          code: "meeting_chat_failed",
          class: "transient",
          description:
            "The selected model failed or no transcript evidence fits the current answer-size limit. No ungrounded fallback answer is generated."
        }
      ],
      remediations: [
        {
          id: "chat.meeting_questions.configure",
          description:
            "Remove the About this meeting chip for ordinary subscription chat. To ask about a meeting, choose an allowed active API-key chat model in AI providers; administrator pins still apply.",
          path: "/settings?section=aiproviders"
        }
      ]
    },
    {
      id: "chat.acp_sign_in_expired",
      description:
        "Shows when a provider rejects its sign-in and explains the provider-specific recovery path.",
      featureFlagId: "chat.module",
      errors: [
        {
          code: "chat.acp_sign_in_expired",
          class: "prerequisite",
          remediationRef: "chat.acp_sign_in_expired.settings",
          description:
            "The provider rejected its sign-in; this is distinct from a missing or malformed Codex runner credential."
        }
      ],
      remediations: [
        {
          id: "chat.acp_sign_in_expired.settings",
          description:
            "For Codex, an administrator connects it once for everyone under Settings, AI providers; other providers keep their existing sign-in path.",
          path: "/settings?section=aiproviders"
        }
      ]
    },
    {
      id: "chat.acp_per_user_mode_required",
      description:
        "Explains how to fix chat when the host runs the chat runner without per-user mode.",
      featureFlagId: "chat.module",
      errors: [
        {
          code: "chat.acp_per_user_mode_required",
          class: "prerequisite",
          remediationRef: "chat.acp_per_user_mode_required.host",
          description:
            "The chat runner refuses to start an agent because the host runs without per-user mode."
        }
      ],
      remediations: [
        {
          id: "chat.acp_per_user_mode_required.host",
          description:
            "An administrator turns on per-user mode in the host environment file and recreates the app container; no Settings control does this. Dev hosts may set MOSS_CLI_ALLOW_SHARED_UID=1 with NODE_ENV=development instead.",
          path: "/settings?section=aiproviders"
        }
      ]
    },
    {
      id: "chat.acp_queued_sends",
      description: "A second message during an active answer is queued and shown in the composer.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.acp_turn_activity_fold",
      description:
        "Each ACP reply carries a collapsed Thinking fold with its thoughts, tool calls and outcomes, updated live and restored from chat history.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.acp_turn_stats_strip",
      description:
        "Each ACP reply shows elapsed time and the token counts reported by the provider.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.model_picker",
      description:
        "Pick the chat model from the button above the message box: starred favorites first, " +
        "then providers you open to see their models. Stars follow your account across " +
        "devices. Search appears past eight models."
    },
    {
      id: "chat.response_styles",
      description:
        "Set how long answers should be (concise, balanced or detailed), in your own settings or " +
        "by asking during a conversation; the choice carries over to later chats."
    },
    {
      id: "chat.classifier_gate",
      description:
        "Classifier switch: Off, Shadow or On. Shadow records what the gate would do and runs " +
        "nothing. On needs a release; then a tool the classifier is sure of runs with no card, " +
        "else the main model answers.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.classifier_shadow_records",
      description:
        "Private shadow records compare the gate's guess with the main model's first tool call " +
        "and keep message text. A first tool outside the classifier stays unnamed; later calls " +
        "never replace it. Private chats never sent. Ask Moss to delete them.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.message_order",
      description:
        "Saved messages keep your question before Moss's reply when they share a timestamp, " +
        "including reloaded history, conversation archives and account exports.",
      featureFlagId: "chat.module"
    },
    {
      id: "chat.thread_history",
      description:
        "Reopen your own Main chat and older side chats, or start a side chat, from Conversations, ordered by recent activity. " +
        "A chat another person shared with you is listed as a side chat but does not open, and it never replaces your Main."
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/chat/threads",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      responseSchema: listChatThreadsResponseSchema,
      permissionId: "chat.view"
    },
    {
      method: "GET",
      path: "/api/chat/threads/:id/messages",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      responseSchema: listChatThreadMessagesResponseSchema,
      permissionId: "chat.view"
    },
    {
      method: "GET",
      path: "/api/chat/meeting-context",
      chat: { access: "read" },
      permissionId: "chat.view"
    },
    {
      method: "POST",
      path: "/api/chat/turn",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    // #1133 — file/image upload staged for the next turn; sending is what needs the
    // message permission, so the upload shares it.
    {
      method: "POST",
      path: "/api/chat/attachments",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/api/chat/evening-interview",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    // #1284 — the generic seed seam (evening-interview above is one dedicated caller).
    // `chat.message` because a seed carries exactly the authority of a user turn: it frames
    // what the assistant sees before the first message, so it is a write to the conversation,
    // not a read of it. Missing this entry does not fail a unit test — it fails
    // assertRouteCoverage at server BOOT, taking down every integration test that stands the
    // API up. tests/unit/chat-route-coverage.test.ts now catches it here instead.
    {
      method: "POST",
      path: "/api/chat/seed",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/api/chat/turn/cancel",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "GET",
      path: "/api/chat/stream",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.view"
    },
    {
      method: "POST",
      path: "/api/chat/clear",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/api/chat/private/end",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "GET",
      path: "/api/chat/privacy",
      chat: { access: "read", content: "user_authored" },
      responseSchema: getChatPrivacyStateResponseSchema,
      permissionId: "chat.view"
    },
    {
      method: "POST",
      path: "/api/chat/switch",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "PUT",
      path: "/api/chat/page-context",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/api/chat/threads/:id/resume",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "GET",
      path: "/api/chat/settings",
      chat: { access: "read", content: "user_authored" },
      permissionId: "chat.view"
    },
    {
      method: "PUT",
      path: "/api/chat/settings",
      chat: { access: "blocked", blockedBecause: "assistant_brain" },
      permissionId: "chat.message"
    },
    {
      method: "GET",
      path: "/api/chat/memory/settings",
      chat: { access: "read", content: "user_authored" },
      permissionId: "chat.view"
    },
    {
      method: "PATCH",
      path: "/api/chat/memory/settings",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "GET",
      path: "/api/chat/memory/facts",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      permissionId: "chat.view"
    },
    {
      method: "GET",
      path: "/api/chat/memory/corrections",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      responseSchema: listMemoryCorrectionsResponseSchema,
      permissionId: "chat.view"
    },
    {
      method: "DELETE",
      path: "/api/chat/memory/facts/:id",
      chat: {
        access: "blocked",
        blockedBecause: "data_scope_consent",
        title: "Use memory.forget for saved memory",
        coveredBy: "memory.forget"
      },
      permissionId: "chat.message"
    },
    // #2908 — the owner deletes their own classifier shadow records on request. RLS scopes the
    // delete; there is no admin path and no separate verb for another actor.
    {
      method: "DELETE",
      path: "/api/chat/classifier/shadow-records",
      chat: {
        access: "destructive",
        title: "Delete the tool-picking trial records",
        content: "user_authored",
        coveredBy: "chat.deleteClassifierShadowRecords",
        presentation: shadowDeleteRoutePresentation,
        presentationContent: "user_authored"
      },
      permissionId: "chat.message"
    },
    // #2957 — temporary shadow report: the viewer's own classifier shadow counts and
    // disagreements. Owner-only through row security, including for admins.
    {
      method: "GET",
      path: "/api/chat/classifier/shadow-report",
      chat: { access: "read", content: "user_authored" },
      permissionId: "chat.view"
    },
    {
      method: "PATCH",
      path: "/api/chat/memory/facts/:id",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/api/chat/memory/facts/:id/confirm",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/api/chat/memory/facts/:id/reject",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/api/chat/action-requests/:id/resolve",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "chat.message"
    },
    {
      method: "GET",
      path: "/api/chat/messages/:messageId/provenance",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      permissionId: "chat.view"
    },
    {
      method: "GET",
      path: "/api/chat/messages/:messageId/provenance/:supportId/dereference",
      chat: { access: "read" },
      permissionId: "chat.view"
    },
    {
      method: "POST",
      path: "/api/mcp",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/internal/permission",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/internal/vault-read-report",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "chat.message"
    },
    {
      method: "GET",
      path: "/api/chat/skills",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.view"
    },
    {
      method: "GET",
      path: "/api/chat/skills/:id",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.view"
    },
    {
      method: "POST",
      path: "/api/chat/skills",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "PATCH",
      path: "/api/chat/skills/:id",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "PATCH",
      path: "/api/chat/skills/:id/enabled",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "DELETE",
      path: "/api/chat/skills/:id",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    },
    {
      method: "POST",
      path: "/api/chat/skills/import",
      chat: { access: "blocked", blockedBecause: "prompt_shaping" },
      permissionId: "chat.message"
    }
  ],
  assistantActionFamilies: [
    {
      id: "chat.preference-write",
      label: "Chat preference changes",
      description: "Update personal chat preferences such as response style.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "chat.listTodaysTurns",
      description: "List today's non-incognito chat turns for the active actor.",
      permissionId: "chat.view",
      risk: "read",
      content: "outside",
      inputSchema: { type: "object", properties: {} },
      execute: chatListTodaysTurnsExecute
    },
    {
      name: "chat.getCurrentView",
      description:
        "Read the active actor's latest bounded, redacted Moss web view and capability-level server facts.",
      permissionId: "chat.view",
      risk: "read",
      content: "outside",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: chatGetCurrentViewOutputSchema,
      execute: chatGetCurrentViewExecute
    },
    {
      name: "chat.getCurrentTime",
      description:
        "Read the server's current time and the user's timezone as of right now. Use when unsure of the current date or time.",
      permissionId: "chat.view",
      risk: "read",
      content: "user_authored",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: chatGetCurrentTimeOutputSchema,
      execute: chatGetCurrentTimeExecute
    },
    {
      name: "chat.readAttachment",
      description:
        "Read a file the user attached to the current chat turn, by attachmentId from the turn's <attachments> manifest. Images return as viewable images; PDFs and text files return extracted text.",
      permissionId: "chat.view",
      risk: "read",
      content: "outside",
      // #1133 — no outputSchema: the image case returns a `media` payload that schema
      // projection would drop (see gateway.runHandler media pass-through).
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId"],
        properties: { attachmentId: { type: "string" } }
      },
      execute: chatReadAttachmentExecute
    },
    {
      name: "chat.setResponseStyle",
      actionLabel: "Change answer length",
      approvalPresentation: chatResponseStylePresentation,
      approvalContent: "user_authored",
      description: "Set the assistant's default response style (concise, balanced, or detailed).",
      permissionId: "chat.message",
      risk: "write",
      content: "user_authored",
      selfOperationGrant: "granted_at_install",
      actionFamilyId: "chat.preference-write",
      executionPolicy: "auto",
      inputSchema: chatSetResponseStyleInputSchema,
      outputSchema: chatSetResponseStyleOutputSchema,
      execute: chatSetResponseStyleExecute
    },
    {
      // #2911 — a person asks Moss in chat to delete their classifier shadow records. Destructive
      // and confirm_always, so nothing is removed before an approval card. RLS scopes the delete
      // to the caller, and there is no admin or cross-user variant.
      name: "chat.deleteClassifierShadowRecords",
      actionLabel: "Delete tool-picking trial records",
      approvalPresentation: shadowDeletePresentation,
      approvalContent: "user_authored",
      description:
        "Delete all of the current user's classifier shadow records - the private trial records " +
        "kept while the classifier gate runs in shadow mode. Use only when the user asks to " +
        "delete that trial data.",
      permissionId: "chat.message",
      risk: "destructive",
      content: "user_authored",
      selfOperationGrant: "confirm_always",
      inputSchema: chatDeleteClassifierShadowRecordsInputSchema,
      outputSchema: chatDeleteClassifierShadowRecordsOutputSchema,
      execute: chatDeleteClassifierShadowRecordsExecute
    }
  ]
} satisfies MossModuleManifest;
