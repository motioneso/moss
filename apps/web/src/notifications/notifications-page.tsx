import "./notifications.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LocaleSettingsDto, NotificationDto } from "@moss/shared";
import {
  Button,
  buttonLinkClassName,
  EmptyState,
  IconButton,
  RowIndex,
  RowIndexItem,
  Segmented
} from "@moss/ui";
import { Bell, Check, CheckCheck, Inbox, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { formatDateTime, useUserLocale } from "../locale/locale-format";
import { personalize } from "../api/use-assistant-name.js";

type NotificationFilter = "all" | "unread";

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const notificationsQuery = useQuery({
    queryKey: queryKeys.notifications.list,
    queryFn: () => listNotifications()
  });
  const markReadMutation = useMutation({
    mutationFn: (notificationId: string) => markNotificationRead(notificationId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.list })
  });
  const markAllReadMutation = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.list })
  });
  const notifications = useMemo(() => {
    const items = notificationsQuery.data?.notifications ?? [];

    return filter === "unread" ? items.filter((notification) => !notification.readAt) : items;
  }, [filter, notificationsQuery.data?.notifications]);
  const totalCount = notificationsQuery.data?.notifications.length;
  const unreadCount = notificationsQuery.data?.unreadCount;

  return (
    <section className="notifications-page" aria-label="Notifications">
      <section className="notifications-toolbar" aria-label="Notification filters">
        <Segmented
          ariaLabel="Read filter"
          options={[
            { value: "all", label: totalCount === undefined ? "All" : `All (${totalCount})` },
            {
              value: "unread",
              label: unreadCount === undefined ? "Unread" : `Unread (${unreadCount})`
            }
          ]}
          value={filter}
          onChange={setFilter}
        />

        <Button
          disabled={!unreadCount || markAllReadMutation.isPending || markReadMutation.isPending}
          icon={
            markAllReadMutation.isPending ? (
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
            ) : (
              <CheckCheck size={18} aria-hidden="true" />
            )
          }
          variant="secondary"
          onClick={() => markAllReadMutation.mutate()}
        >
          {markAllReadMutation.isPending ? "Marking all read…" : "Mark all read"}
        </Button>
      </section>

      {markAllReadMutation.isError ? (
        <p role="alert">Could not mark notifications read. Try again.</p>
      ) : null}
      {notificationsQuery.isError ? (
        <p role="status">
          {notificationsQuery.data
            ? "Could not refresh notifications. Showing the last loaded list."
            : "Could not load notifications."}{" "}
          <Button variant="link" onClick={() => void notificationsQuery.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      <section aria-label="Notification list">
        {!notificationsQuery.data ? (
          notificationsQuery.isPending ? (
            <p role="status">Loading notifications…</p>
          ) : null
        ) : notifications.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} aria-hidden="true" />}
            title={filter === "unread" ? "No unread notifications" : "No notifications"}
          />
        ) : (
          <RowIndex density="compact">
            {notifications.map((notification) => (
              <NotificationRow
                isUpdating={
                  markReadMutation.isPending && markReadMutation.variables === notification.id
                }
                isDisabled={markReadMutation.isPending || markAllReadMutation.isPending}
                hasError={
                  markReadMutation.isError && markReadMutation.variables === notification.id
                }
                key={notification.id}
                notification={notification}
                onMarkRead={() => markReadMutation.mutate(notification.id)}
              />
            ))}
          </RowIndex>
        )}
      </section>
    </section>
  );
}

function NotificationRow(props: {
  readonly isUpdating: boolean;
  readonly isDisabled: boolean;
  readonly hasError: boolean;
  readonly notification: NotificationDto;
  readonly onMarkRead: () => void;
}) {
  const locale = useUserLocale();
  const unread = !props.notification.readAt;
  const upgrade = props.notification.metadata.kind === "upgrade_available";

  return (
    <article aria-busy={props.isUpdating}>
      <RowIndexItem
        title={
          <span className="notifications-title">
            <Bell size={18} aria-hidden="true" />
            {personalize(props.notification.title)}
          </span>
        }
        excerpt={
          <div className="notifications-body">
            {props.notification.body ? <p>{personalize(props.notification.body)}</p> : null}
            {upgrade ? (
              <Link className={buttonLinkClassName("link", "sm")} to="/settings?section=host">
                View changes
              </Link>
            ) : props.notification.href ? (
              <Link className={buttonLinkClassName("link", "sm")} to={props.notification.href}>
                View
              </Link>
            ) : null}
            {props.hasError ? (
              <p role="alert">Could not mark this notification read. Try again.</p>
            ) : null}
          </div>
        }
        meta={
          <span className="notifications-meta">
            <span>{unread ? "Unread" : "Read"}</span>
            <span>{formatNotificationDate(props.notification.createdAt, locale)}</span>
            <IconButton
              aria-label={`Mark ${personalize(props.notification.title)} read`}
              disabled={props.isDisabled || !unread}
              title="Mark read"
              onClick={props.onMarkRead}
            >
              {props.isUpdating ? (
                <LoaderCircle className="spin" size={18} aria-hidden="true" />
              ) : (
                <Check size={18} aria-hidden="true" />
              )}
            </IconButton>
          </span>
        }
      />
    </article>
  );
}

function formatNotificationDate(value: string | null, locale: LocaleSettingsDto): string {
  if (!value) {
    return "No date";
  }

  return formatDateTime(value, locale);
}
