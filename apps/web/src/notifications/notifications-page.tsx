import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LocaleSettingsDto, NotificationDto } from "@moss/shared";
import { Button, buttonLinkClassName, EmptyState, IconButton, Segmented } from "@moss/ui";
import { Bell, Check, CheckCheck, Inbox, LoaderCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { formatDateTime, useUserLocale } from "../locale/locale-format";

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
  const totalCount = notificationsQuery.data?.notifications.length ?? 0;
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;

  return (
    <section
      className="page-stack"
      aria-label="Notifications"
      style={{ marginTop: "var(--space-4)" }}
    >
      <section
        className="tk-toolbar"
        aria-label="Notification filters"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <Segmented
          ariaLabel="Read filter"
          options={[
            { value: "all", label: `All (${totalCount})` },
            { value: "unread", label: `Unread (${unreadCount})` }
          ]}
          value={filter}
          onChange={setFilter}
        />

        <Button
          disabled={unreadCount === 0 || markAllReadMutation.isPending}
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
          Mark all read
        </Button>
      </section>

      <section className="tk-list tk-list--loose" aria-live="polite">
        {notificationsQuery.isLoading ? (
          <EmptyState
            icon={<LoaderCircle className="spin" size={22} aria-hidden="true" />}
            title="Loading notifications"
          />
        ) : notificationsQuery.error ? (
          <EmptyState
            icon={<Inbox size={22} aria-hidden="true" />}
            title={notificationsQuery.error.message}
          />
        ) : notifications.length === 0 ? (
          <EmptyState icon={<Inbox size={22} aria-hidden="true" />} title="No notifications" />
        ) : (
          notifications.map((notification) => (
            <NotificationRow
              isUpdating={markReadMutation.isPending}
              key={notification.id}
              notification={notification}
              onMarkRead={() => markReadMutation.mutate(notification.id)}
            />
          ))
        )}
      </section>
    </section>
  );
}

function NotificationRow(props: {
  readonly isUpdating: boolean;
  readonly notification: NotificationDto;
  readonly onMarkRead: () => void;
}) {
  const locale = useUserLocale();
  const unread = !props.notification.readAt;
  const upgrade = props.notification.metadata.kind === "upgrade_available";

  return (
    <article className={`jds-task ${unread ? "jds-task--unread" : ""}`}>
      <div className="jds-task__check" aria-hidden="true">
        <Bell size={22} />
      </div>
      <div className="jds-task__main">
        <div className="jds-task__title">{props.notification.title}</div>
        {props.notification.body ? <p>{props.notification.body}</p> : null}
        {upgrade ? (
          <Link className={buttonLinkClassName("secondary", "sm")} to="/settings?section=host">
            View changes
          </Link>
        ) : props.notification.href ? (
          // Task 2b (#1283): module-supplied deep link. Always same-origin — validated at
          // the RPC boundary and again in NotificationsRepository — so a plain router Link
          // (not a full page anchor) is safe here.
          <Link className={buttonLinkClassName("secondary", "sm")} to={props.notification.href}>
            View
          </Link>
        ) : null}
        <div className="jds-task__meta">
          <span>{unread ? "Unread" : "Read"}</span>
          <span>{formatNotificationDate(props.notification.createdAt, locale)}</span>
        </div>
      </div>
      <div className="tk-row-actions">
        <IconButton
          aria-label={`Mark ${props.notification.title} read`}
          disabled={props.isUpdating || !unread}
          title="Mark read"
          onClick={props.onMarkRead}
        >
          {props.isUpdating ? (
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
          ) : (
            <Check size={18} aria-hidden="true" />
          )}
        </IconButton>
      </div>
    </article>
  );
}

function formatNotificationDate(value: string | null, locale: LocaleSettingsDto): string {
  if (!value) {
    return "No date";
  }

  return formatDateTime(value, locale);
}
