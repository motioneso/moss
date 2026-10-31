import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import {
  heartbeatMuteResultSchema,
  type HeartbeatMute,
  type HeartbeatMuteResult
} from "@moss/shared";

import { HeartbeatMuteRepository, type RecentHeartbeatItem } from "./mute-repository.js";

const MAX_CANDIDATES = 3;
const MIN_PHRASE_LENGTH = 3;

export const chatHeartbeatMuteInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    findingId: {
      type: "string",
      description:
        "The finding ID of one item in a check-in message the user is replying to or pointing at. Use it when the user says 'that' or 'this'."
    },
    phrase: {
      type: "string",
      description:
        "The topic the user named, such as 'timecards' or a team name. Use it only when the user named the topic in their own words."
    }
  }
} as const;

export const chatHeartbeatMuteOutputSchema = heartbeatMuteResultSchema;

/** Lowercases and drops a plural "s" so "timecards" finds "timecard". */
function normalizePhrase(phrase: string): string {
  const lowered = phrase.trim().toLowerCase();
  return lowered.length > MIN_PHRASE_LENGTH && lowered.endsWith("s")
    ? lowered.slice(0, -1)
    : lowered;
}

function capitalize(text: string): string {
  const trimmed = text.trim();
  return trimmed === "" ? trimmed : trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

async function muteItem(
  repository: HeartbeatMuteRepository,
  scopedDb: DataContextDb,
  item: RecentHeartbeatItem
): Promise<HeartbeatMute> {
  // An item whose saved finding is gone cannot be matched by key, so its title becomes the topic.
  return item.entityKey
    ? repository.create(scopedDb, {
        scope: "item",
        source: item.source,
        entityKey: item.entityKey,
        label: item.title
      })
    : repository.create(scopedDb, {
        scope: "topic",
        topic: item.title.toLowerCase(),
        label: item.title
      });
}

/**
 * Saves a mute for one published item, or for a named topic. A phrase that matches several
 * different published items saves nothing and returns up to three candidates to pick from.
 */
export async function resolveHeartbeatMute(
  scopedDb: DataContextDb,
  input: { readonly findingId?: string; readonly phrase?: string },
  repository: HeartbeatMuteRepository = new HeartbeatMuteRepository()
): Promise<HeartbeatMuteResult> {
  assertDataContextDb(scopedDb);
  const recent = await repository.recentItems(scopedDb);

  if (input.findingId) {
    const item = recent.find((entry) => entry.findingId === input.findingId);
    if (!item) return { status: "not_found" };
    return { status: "muted", mute: await muteItem(repository, scopedDb, item) };
  }

  const phrase = normalizePhrase(input.phrase ?? "");
  if (phrase.length < MIN_PHRASE_LENGTH) return { status: "not_found" };

  const seen = new Set<string>();
  const matches = recent.filter((entry) => {
    const title = entry.title.toLowerCase();
    if (!title.includes(phrase) || seen.has(title)) return false;
    seen.add(title);
    return true;
  });
  if (matches.length > 1) {
    return {
      status: "choose",
      candidates: matches
        .slice(0, MAX_CANDIDATES)
        .map((entry) => ({ label: entry.title, findingId: entry.findingId }))
    };
  }
  const mute = await repository.create(scopedDb, {
    scope: "topic",
    topic: phrase,
    label: capitalize(input.phrase ?? phrase)
  });
  return { status: "muted", mute };
}

export const chatHeartbeatMuteExecute: ToolExecute = async (
  scopedDb,
  input
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const args = input as { findingId?: string; phrase?: string };
  const result = await resolveHeartbeatMute(scopedDb, args);
  return { data: result as unknown as Record<string, unknown> };
};

/** The assistant tool entry. Saving a mute is the owner's own preference, so it runs without a prompt. */
export const chatHeartbeatMuteTool = {
  name: "chat.heartbeatMute",
  actionLabel: "Stop mentioning a check-in topic",
  description:
    "Stop Moss's periodic check-ins from mentioning an item or topic. Call it when the user says to stop telling them about something from a check-in. Pass findingId for an item in a check-in message, or phrase for a topic the user named. Returns the saved mute, or up to three candidates to ask about when several items match.",
  permissionId: "chat.message",
  risk: "write",
  content: "user_authored",
  selfOperationGrant: "granted_at_install",
  actionFamilyId: "chat.preference-write",
  streamsStructuredResult: true,
  executionPolicy: "auto",
  inputSchema: chatHeartbeatMuteInputSchema,
  outputSchema: chatHeartbeatMuteOutputSchema,
  execute: chatHeartbeatMuteExecute
} as const;
