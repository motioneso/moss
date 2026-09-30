import type { MailMessageKey } from "./email-read-provider.js";
import { GMAIL_READ_FOLDER } from "./email-read-provider.js";
import type { SyncLogger } from "./sync-jobs.js";

export type WalkMode = "history" | "full";

export interface HistoryWalkInput {
  readonly phase: string;
  readonly cursor: string | undefined;
  readonly walkMode: WalkMode | undefined;
  readonly walkAnchor: string | undefined;
  readonly listedCursor: string | undefined;
  readonly pageLimit: number;
  readonly client: {
    getProfileHistoryId?(input: { accessToken: string }): Promise<string>;
    listHistoryPage?(input: {
      accessToken: string;
      startHistoryId: string;
      pageToken?: string;
      maxResults?: number;
    }): Promise<{ messageIds: string[]; nextPageToken?: string }>;
  };
  readonly logger: SyncLogger;
  readonly getStoredPosition: () => Promise<string | null | undefined>;
  readonly withToken: <T>(run: (token: string) => Promise<T>) => Promise<T>;
  readonly failureFields: (error: unknown) => Record<string, unknown>;
}

export interface HistoryWalkResult {
  readonly walkMode: WalkMode | undefined;
  readonly walkAnchor: string | undefined;
  readonly listedCursor: string | undefined;
  /** Set when change history answered; otherwise the caller lists the whole window. */
  readonly page?: { keys: MailMessageKey[]; nextCursor?: string };
}

/**
 * Decides the backlog walk mode on its first page and, in history mode, lists the changed mail.
 * Any history failure (an expired position answers 404) falls back to listing the whole window
 * from its first page; that walk then saves a fresh position.
 */
export async function resolveHistoryWalk(input: HistoryWalkInput): Promise<HistoryWalkResult> {
  const { client, logger } = input;
  let { walkMode, walkAnchor, listedCursor } = input;
  if (input.phase !== "email" || !client.getProfileHistoryId || !client.listHistoryPage) {
    return { walkMode, walkAnchor, listedCursor };
  }
  const listHistoryPage = client.listHistoryPage.bind(client);
  const getProfileHistoryId = client.getProfileHistoryId.bind(client);
  let page: HistoryWalkResult["page"];
  // A continuation queued before the walk state existed has a cursor and no mode: it is a
  // plain listing with no position to save.
  if (!walkMode) {
    if (input.cursor) walkMode = "full";
    else {
      const stored = await input.getStoredPosition();
      try {
        walkAnchor = await input.withToken((token) => getProfileHistoryId({ accessToken: token }));
      } catch (error) {
        logger.warn(
          { stage: "email-history", ...input.failureFields(error) },
          "google-sync mailbox position read failed; listing the whole window"
        );
      }
      walkMode = stored && walkAnchor ? "history" : "full";
    }
  }
  if (walkMode === "history") {
    const stored = await input.getStoredPosition();
    try {
      if (!stored) throw new Error("no saved mailbox position");
      const changed = await input.withToken((token) =>
        listHistoryPage({
          accessToken: token,
          startHistoryId: stored,
          pageToken: listedCursor,
          maxResults: input.pageLimit
        })
      );
      page = {
        keys: changed.messageIds.map((id) => ({ folder: GMAIL_READ_FOLDER, id })),
        nextCursor: changed.nextPageToken
      };
    } catch (error) {
      logger.warn(
        { stage: "email-history", ...input.failureFields(error) },
        "google-sync change history failed; listing the whole window"
      );
      walkMode = "full";
      listedCursor = undefined;
    }
  }
  return { walkMode, walkAnchor, listedCursor, page };
}
