import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Note } from "@moss/ui";
import type { OutlookCalendarStatus } from "@moss/shared";
import { requestJson } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { formatDateTime, useUserLocale } from "../locale/locale-format.js";

const statusKey = ["outlook-calendar-status"] as const;
const messages = {
  collecting: "Updating Outlook calendar.",
  current: "Outlook calendar is current within the covered dates.",
  partial:
    "Calendar may be incomplete; the last complete refresh is retained. Retry or inspect the dedicated browser.",
  stale: "Outlook calendar is out of date. Retry or inspect the dedicated browser.",
  "sign-in-needed":
    "Outlook sign-in required; calendar is not current. Open the dedicated browser and sign in, then retry.",
  "source-changed":
    "Outlook calendar layout or event identity is unsupported. Collection is paused; the collector needs repair.",
  disconnected: "Outlook calendar updates paused. Cached events remain available."
};
export function OutlookCalendarStatusPanel({ settings = false }: { readonly settings?: boolean }) {
  const cache = useQueryClient();
  const locale = useUserLocale();
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => requestJson<OutlookCalendarStatus>("/api/connectors/outlook-calendar"),
    refetchInterval: 15_000,
    retry: false
  });
  const action = useMutation({
    mutationFn: (verb: "connect" | "refresh" | "disconnect") =>
      requestJson<OutlookCalendarStatus>(`/api/connectors/outlook-calendar/${verb}`, {
        method: "POST",
        body: {}
      }),
    onSuccess: async (result) => {
      cache.setQueryData(statusKey, result);
      await cache.invalidateQueries({ queryKey: queryKeys.calendar.list });
      await cache.invalidateQueries({ queryKey: queryKeys.connectors.accounts });
    }
  });
  const s = status.data;
  if (!s || (!s.available && !s.lastCompleteAt)) return null;
  return (
    <Note variant="practical" aria-label="Outlook calendar connection">
      <p>
        <strong>Outlook calendar · Read only</strong>
      </p>
      <p role="status">{messages[s.state]}</p>
      {s.lastCompleteAt ? (
        <p>
          Last complete refresh: {formatDateTime(s.lastCompleteAt, locale)}. Covered dates:{" "}
          {s.windowStart} through {s.windowEnd} (end date excluded).
        </p>
      ) : null}
      {s.unconfirmed > 0 ? (
        <p>
          {s.unconfirmed} previously seen {s.unconfirmed === 1 ? "meeting needs" : "meetings need"}{" "}
          verification in Outlook. These times remain reserved.
        </p>
      ) : null}
      {settings && s.available ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-2)",
            marginTop: "var(--space-3)"
          }}
        >
          <Button
            disabled={action.isPending}
            onClick={() => action.mutate(s.connected ? "refresh" : "connect")}
          >
            {s.connected ? "Sync now" : "Connect Outlook calendar"}
          </Button>
          {s.connected ? (
            <Button disabled={action.isPending} onClick={() => action.mutate("disconnect")}>
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}
      {action.isError ? <p role="alert">That did not save. Try again.</p> : null}
    </Note>
  );
}
