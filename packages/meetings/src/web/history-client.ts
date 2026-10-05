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

/** Remove an unavailable identity without treating cached lists as freshly authorized reads. */
export function forgetHistoryItem(client: QueryClient, id: string): void {
  for (const query of client.getQueryCache().findAll({ queryKey: historyKeys.lists })) {
    const current = client.getQueryData<InfiniteData<MeetingHistoryPage>>(query.queryKey);
    if (!current) continue;
    // setQueryData would clear a list's existing denial/error. Prune its data only.
    query.setState({
      data: {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          meetings: page.meetings.filter((meeting) => meeting.id !== id)
        }))
      }
    });
  }
}
