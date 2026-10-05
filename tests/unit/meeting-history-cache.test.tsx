import { describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { ApiError } from "@moss/module-web-sdk";
import type { MeetingHistoryPage } from "@moss/shared";
import { forgetHistoryItem, historyKeys } from "../../packages/meetings/src/web/history-client.js";
import { historyItem } from "./fixtures/meeting-history.js";

const draft = historyItem({
  id: "11223344-1122-4122-8122-112233445566",
  title: "Synthetic review",
  personalNotes: "",
  notesRevision: 0,
  createdAt: "2026-10-03T12:00:00Z",
  updatedAt: "2026-10-03T12:00:00Z"
});

describe("history cache pruning", () => {
  it.each([403, 503])(
    "prunes a deleted row without clearing an existing %s list error",
    async (status) => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } }
      });
      const key = historyKeys.search("private words", "all");
      const other = { ...draft, id: "22334455-1122-4122-8122-112233445566" };
      const data: InfiniteData<MeetingHistoryPage> = {
        pages: [{ meetings: [draft, other], nextCursor: null }],
        pageParams: [undefined]
      };
      const error = new ApiError(status, "Unavailable");
      client.setQueryData(key, data);
      await expect(
        client.fetchInfiniteQuery({
          queryKey: key,
          initialPageParam: undefined,
          queryFn: async () => {
            throw error;
          }
        })
      ).rejects.toBe(error);
      const before = client.getQueryState(key);
      forgetHistoryItem(client, draft.id);
      expect(client.getQueryState(key)).toEqual({
        ...before,
        data: { ...data, pages: [{ meetings: [other], nextCursor: null }] }
      });
      expect(client.getQueryState(key)?.status).toBe("error");
      expect(client.getQueryState(key)?.error).toBe(error);
      client.clear();
    }
  );
});
