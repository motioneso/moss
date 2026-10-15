import { Badge } from "@moss/ui";

export function ChatUnreadBadge(props: { readonly count: number }) {
  if (props.count <= 0) return null;
  return (
    <span aria-hidden="true">
      <Badge tone="solid-pine" pill>
        {props.count > 99 ? "99+" : props.count}
      </Badge>
    </span>
  );
}

export function unreadMessageDescription(count: number): string {
  return `${count} unread ${count === 1 ? "message" : "messages"}`;
}
