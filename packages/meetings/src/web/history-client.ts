import { requestJson } from "@moss/module-web-sdk";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  MeetingHistoryFilter,
  MeetingHistoryItem,
  MeetingHistoryPage,
  SearchMeetingHistoryInput
} from "@moss/shared";
import { meetingKeys } from "./client.js";

export const historyKeys = {
  view: ["meetings", "history-view"] as const,
  lists: [...meetingKeys.history, "search"] as const,
  search: (query: string, filter: MeetingHistoryFilter) =>
    [...meetingKeys.history, "search", { query, filter }] as const,
  item: (id: string) => [...meetingKeys.history, "item", id] as const
};

/** Search text stays in the request body and signed-in memory, never a URL. */
export function searchMeetingHistory(
  input: SearchMeetingHistoryInput,
  signal?: AbortSignal
): Promise<MeetingHistoryPage> {
  return requestJson("/api/meetings/history/search", { method: "POST", body: input, signal });
}

export function getMeetingHistoryItem(
  id: string,
  signal?: AbortSignal
): Promise<{ meeting: MeetingHistoryItem }> {
  return requestJson(`/api/meetings/history/${encodeURIComponent(id)}`, { signal });
}

/** Keep the active denial visible; remove other pages/details and cancel their in-flight reads. */
export function discardDeniedHistory(client: QueryClient, currentKey: readonly unknown[]): void {
  const current = client.getQueryCache().find({ queryKey: currentKey, exact: true });
  client.removeQueries({
    queryKey: meetingKeys.history,
    predicate: (query) => query !== current
  });
}

/** A denied detail read must also remove that identity from cached result pages. */
export function forgetHistoryItem(client: QueryClient, id: string): void {
  client.setQueriesData<InfiniteData<MeetingHistoryPage>>(
    {
      queryKey: historyKeys.lists,
      // Writing cache data marks a query successful. Preserve existing denial/error states.
      predicate: (query) => query.state.status === "success"
    },
    (current) =>
      current && {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          meetings: page.meetings.filter((meeting) => meeting.id !== id)
        }))
      }
  );
}
