import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Indicator, Note } from "@moss/ui";
import type { OutlookCalendarStatus } from "@moss/shared";
import { requestJson } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { formatDateTime, useUserLocale } from "../locale/locale-format.js";

const statusKey = ["outlook-calendar-status"] as const;
const messages = {
  collecting: "Updating Outlook calendar.",
  current: "Up to date within covered dates",
  partial: "Incomplete refresh. Previous events retained; retry sync.",
  stale: "Out of date. Retry sync.",
  "sign-in-needed": "Outlook sign-in required. Sign in to the dedicated browser, then retry.",
  "source-changed": "Needs repair. Sync paused.",
  "settings-not-found":
    "Sync paused. Moss could not find Outlook's Settings button, even under the three-dot menu. Open the calendar in the dedicated browser, then retry.",
  disconnected: "Calendar updates paused. Cached events retained."
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
  if (!settings) {
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
            {s.unconfirmed} previously seen{" "}
            {s.unconfirmed === 1 ? "meeting needs" : "meetings need"} verification in Outlook. These
            times remain reserved.
          </p>
        ) : null}
      </Note>
    );
  }
  return (
    <div className="acct acct--outlook" aria-label="Outlook calendar connection">
      <div className="acct__logo" aria-hidden="true">
        O
      </div>
      <div className="acct__main">
        <div className="acct__name">Outlook calendar</div>
        <div className="acct__sub">
          <span>Read only</span>
          <span role="status">
            <Indicator
              status={
                s.state === "current"
                  ? "ready"
                  : s.state === "source-changed" || s.state === "settings-not-found"
                    ? "error"
                    : s.state === "collecting" || s.state === "disconnected"
                      ? "idle"
                      : "drift"
              }
              label={messages[s.state]}
            />
          </span>
        </div>
        {s.lastCompleteAt ? (
          <div className="acct__sub">
            Last complete refresh: {formatDateTime(s.lastCompleteAt, locale)}. Covered dates:{" "}
            {s.windowStart} through {s.windowEnd} (end date excluded).
          </div>
        ) : null}
        {s.unconfirmed > 0 ? (
          <div className="acct__sub">
            {s.unconfirmed} previously seen{" "}
            {s.unconfirmed === 1 ? "meeting needs" : "meetings need"} verification in Outlook. These
            times remain reserved.
          </div>
        ) : null}
        {action.isError ? <p role="alert">That did not save. Try again.</p> : null}
      </div>
      {settings && s.available ? (
        <div className="acct__actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate(s.connected ? "refresh" : "connect")}
          >
            {s.connected ? "Sync now" : "Connect Outlook calendar"}
          </Button>
          {s.connected ? (
            <Button
              variant="quiet"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate("disconnect")}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
