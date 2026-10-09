import { House, Menu, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { Button, Eyebrow, IconButton, NavIndex, NavIndexItem } from "@moss/ui";
import type { ChatThreadDto } from "@moss/shared";

import { useDismissableMenu } from "../shared/use-dismissable-menu.js";
import { trapFocus } from "../shell/command-palette";

export function SideChatOverlay(props: {
  readonly threads: readonly ChatThreadDto[];
  readonly selectedThreadId: string | null;
  readonly onSelect: (threadId: string) => void;
  readonly onNewSideChat: () => void;
  readonly disabled: boolean;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly onRetry?: () => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    props.onOpenChange(typeof next === "function" ? next(props.open) : next);
  };
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const { ref } = useDismissableMenu<HTMLDivElement>({ open: props.open, onClose: close });
  const main = props.threads.find((thread) => thread.isMain);
  const sideChats = props.threads.filter((thread) => !thread.isMain);

  useEffect(() => {
    if (!props.open) return;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [props.open, ref]);

  const select = (threadId: string) => {
    close();
    props.onSelect(threadId);
  };

  return (
    <div className="chatd-conversations">
      <IconButton
        ref={triggerRef}
        aria-controls="chat-conversations"
        aria-expanded={props.open}
        aria-label="Open conversations"
        disabled={props.disabled}
        title="Conversations"
        onClick={() => setOpen((current) => !current)}
      >
        <Menu aria-hidden="true" />
      </IconButton>
      {props.open ? (
        <div
          ref={ref}
          className="chatd-conversations__overlay"
          id="chat-conversations"
          aria-label="Conversations"
          onKeyDown={(event) => {
            if (event.key === "Tab") trapFocus(event, ref.current);
          }}
        >
          <div className="chatd-conversations__head">
            <Eyebrow tone="muted">Your conversations</Eyebrow>
            <IconButton aria-label="Close conversations" size="sm" title="Close" onClick={close}>
              <X aria-hidden="true" />
            </IconButton>
          </div>
          {props.loading ? (
            <p className="chatd-conversations__empty" role="status">
              Loading conversations…
            </p>
          ) : props.error ? (
            <div className="chatd-conversations__empty" role="alert">
              <p>Could not load conversations.</p>
              {props.onRetry ? (
                <Button size="sm" variant="quiet" onClick={props.onRetry}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : main ? (
            <NavIndex ariaLabel="Main conversation" label="Main chat">
              <NavIndexItem
                ariaLabel="Main chat"
                label={
                  <span className="chatd-conversations__label">
                    <House aria-hidden="true" />
                    {main.title}
                  </span>
                }
                selected={props.selectedThreadId === main.id}
                onSelect={() => select(main.id)}
              />
            </NavIndex>
          ) : null}
          {!props.loading && !props.error ? (
            <div className="chatd-conversations__side-head">
              <Eyebrow tone="muted">Side chats</Eyebrow>
              <Button
                aria-label="New side chat"
                disabled={props.disabled}
                icon={<Plus aria-hidden="true" />}
                size="sm"
                variant="quiet"
                onClick={() => {
                  close();
                  props.onNewSideChat();
                }}
              >
                New side chat
              </Button>
            </div>
          ) : null}
          {!props.loading && !props.error && sideChats.length > 0 ? (
            <NavIndex ariaLabel="Side conversations">
              {sideChats.map((thread) => (
                <NavIndexItem
                  ariaLabel={thread.title}
                  key={thread.id}
                  label={thread.title}
                  selected={props.selectedThreadId === thread.id}
                  onSelect={() => select(thread.id)}
                />
              ))}
            </NavIndex>
          ) : !props.loading && !props.error ? (
            <p className="chatd-conversations__empty" role="status">
              Start a side chat to keep a topic together.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
