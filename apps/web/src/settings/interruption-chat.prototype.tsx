/** THROWAWAY #3103: the accepted conversation overlay, with fictional memory-only state. */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, Menu, Plus, X } from "lucide-react";
import {
  BrandMark,
  Button,
  EmptyState,
  Eyebrow,
  IconButton,
  NavIndex,
  NavIndexItem,
  Thread
} from "@moss/ui";
import type { TranscriptRecord } from "@moss/shared";

export function InterruptionChat({
  records,
  onSend,
  onClose,
  modal = false
}: {
  records: TranscriptRecord[];
  onSend: (text: string) => string;
  onClose: () => void;
  modal?: boolean;
}) {
  const [active, setActive] = useState("main");
  const [topics, setTopics] = useState([{ id: "reading", title: "AI reading" }]);
  const [local, setLocal] = useState<Record<string, TranscriptRecord[]>>({});
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const title =
    active === "main" ? "Main chat" : (topics.find((t) => t.id === active)?.title ?? "Side chat");
  function close() {
    setOpen(false);
    toggle.current?.focus();
  }
  useEffect(() => {
    composer.current?.focus();
  }, []);
  useEffect(() => {
    if (open) document.querySelector<HTMLButtonElement>("#conversation-menu button")?.focus();
    function key(e: KeyboardEvent) {
      if (!open) {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        if (e.key === "Tab" && modal) {
          const controls = Array.from(
            document.querySelectorAll<HTMLElement>(
              ".proto-chat button:not(:disabled), .proto-chat textarea"
            )
          );
          const first = controls[0],
            last = controls.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
          if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const buttons = Array.from(
          document.querySelectorAll<HTMLButtonElement>("#conversation-menu button")
        );
        const first = buttons[0],
          last = buttons.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose, modal]);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [records, local, active]);
  function select(id: string) {
    setActive(id);
    setDraft("");
    close();
  }
  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (active === "main") {
      onSend(text);
      return;
    }
    if (active.startsWith("new-") && !local[active]?.length)
      setTopics((prev) =>
        prev.map((t) =>
          t.id === active ? { ...t, title: text.split(/\s+/).slice(0, 4).join(" ") } : t
        )
      );
    setLocal((prev) => ({
      ...prev,
      [active]: [
        ...(prev[active] ?? []),
        { kind: "user", text },
        {
          kind: "reply",
          text: "We can keep working on this here. Your alert preferences are managed in Main chat in this sample."
        }
      ]
    }));
  }
  return (
    <section
      className="proto-chat"
      aria-label="Moss conversation"
      role={modal ? "dialog" : undefined}
      aria-modal={modal || undefined}
    >
      <header className="proto-chat-head">
        <div className="proto-chat-brand">
          <IconButton
            ref={toggle}
            aria-label="Conversations"
            aria-expanded={open}
            aria-controls="conversation-menu"
            onClick={() => (open ? close() : setOpen(true))}
          >
            <Menu size={21} />
          </IconButton>
          <div>
            <strong>Moss</strong>
            <span>Your chief of staff</span>
          </div>
        </div>
        <IconButton aria-label="Close chat" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="proto-chat-layout">
        {open && (
          <>
            <button
              className="proto-conversation-scrim"
              aria-label="Close conversation menu"
              onClick={close}
            />
            <aside
              id="conversation-menu"
              className="proto-conversation-overlay"
              aria-label="Conversations"
            >
              <div className="proto-list-top">
                <Eyebrow tone="muted">Your conversations</Eyebrow>
                <IconButton aria-label="Close conversation list" onClick={close}>
                  <X size={18} />
                </IconButton>
              </div>
              <NavIndex ariaLabel="Main conversation">
                <NavIndexItem
                  label="Main chat"
                  selected={active === "main"}
                  onSelect={() => select("main")}
                />
              </NavIndex>
              <div className="proto-topic-heading">
                <Eyebrow tone="muted">Side chats</Eyebrow>
                <Button
                  variant="quiet"
                  icon={<Plus size={17} />}
                  onClick={() => {
                    const id = `new-${topics.length}`;
                    setTopics((prev) => [...prev, { id, title: "New side chat" }]);
                    select(id);
                    setTimeout(() => composer.current?.focus(), 0);
                  }}
                >
                  New side chat
                </Button>
              </div>
              <NavIndex ariaLabel="Side conversations">
                {topics.map((t) => (
                  <NavIndexItem
                    key={t.id}
                    label={t.title}
                    selected={active === t.id}
                    onSelect={() => select(t.id)}
                  />
                ))}
              </NavIndex>
              <p className="proto-nav-note">
                Separate topics.
                <br />
                The same Moss.
              </p>
            </aside>
          </>
        )}
        <div className="proto-conversation" inert={open || undefined}>
          <div className="proto-conversation-title">
            <div>
              <h1>{title}</h1>
              <p>
                {active === "main"
                  ? "Your ongoing conversation with Moss"
                  : "A side chat · same Moss, focused on this topic"}
              </p>
            </div>
            <BrandMark size={20} />
          </div>
          <div ref={thread} className="proto-thread" aria-live="polite">
            {(active === "main" ? records : (local[active] ?? [])).length ? (
              <Thread records={active === "main" ? records : (local[active] ?? [])} />
            ) : (
              <EmptyState
                title="What’s on your mind?"
                description="Start typing. Moss will name this chat as you go."
              />
            )}
          </div>
          <form
            className="proto-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              ref={composer}
              className="jds-input"
              aria-label={`Message ${title}`}
              placeholder="Message Moss…"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="proto-composer-foot">
              <span>{title}</span>
              <IconButton aria-label="Send message" disabled={!draft.trim()} onClick={send}>
                <ArrowDown className="proto-send-arrow" size={18} />
              </IconButton>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
