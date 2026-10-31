import type { ReactNodeLike } from "@moss/module-web-sdk";

/* Three dots for a row's actions menu. */
export function MoreIcon(): ReactNodeLike {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
    </svg>
  );
}
