/**
 * THROWAWAY: three main/side-chat navigation layouts on one preview route.
 * ?variant=A|B|C; shared real UI primitives, sample content, memory-only interactions.
 * No auth, provider, worker, API requests or persistent changes. Never imported by the app.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bell,
  CalendarDays,
  CheckCheck,
  ChevronDown,
  ChevronsUpDown,
  FileText,
  House,
  Mail,
  Maximize2,
  MessageSquare,
  Minimize2,
  Moon,
  Paperclip,
  Plus,
  Search,
  Settings,
  Sun,
  X
} from "lucide-react";
import {
  Avatar,
  BrandMark,
  Button,
  Dialog,
  EmptyState,
  Eyebrow,
  IconButton,
  Masthead,
  NavIndex,
  NavIndexItem,
  SectionHead,
  Thread
} from "@moss/ui";
import type { TranscriptRecord } from "@moss/shared";
import "../styles/index.css";
import "../styles/kit-chat.css";
import "./main-side-chats.prototype.css";

type Variant = "A" | "B" | "C";
type View = "docked" | "expanded" | "phone";
type Topic = { id: string; title: string; note: string };
const variants: { key: Variant; name: string; description: string }[] = [
  {
    key: "A",
    name: "Conversation sidebar",
    description: "Main chat and topics are always in view."
  },
  {
    key: "B",
    name: "Compact tabs",
    description: "Switch topics across the top of the conversation."
  },
  {
    key: "C",
    name: "Conversation picker",
    description: "Keep the chat open; bring up topics when you need them."
  }
];
const initialTopics: Topic[] = [
  { id: "home", title: "Home projects", note: "Kitchen plans and the next few weekends" },
  { id: "trip", title: "Summer trip", note: "A little planning for next year" },
  { id: "reading", title: "AI reading", note: "Ideas worth coming back to" }
];
const firstUpdate: TranscriptRecord = {
  kind: "reply",
  text: "Heads up — Maya replied to your proposal. She's happy with the direction and asked for the final version by Friday.\n\n[Open the email](https://example.invalid/moss-preview-email)\n\n*10:12 AM · Inbox watch*"
};
const initialRecords: Record<string, TranscriptRecord[]> = {
  main: [
    { kind: "user", text: "What should I keep an eye on today?" },
    {
      kind: "reply",
      text: "Your morning is clear until 10:30. The proposal is the one thing worth finishing today. I'll keep an eye out for Maya's feedback."
    },
    { kind: "user", text: "Great. Watch for her reply for the next three hours." },
    {
      kind: "reply",
      text: "I'll check for Maya's reply for the next three hours and let you know here. You can pause or stop the watch in Settings."
    },
    firstUpdate
  ],
  home: [
    { kind: "user", text: "Let's keep the kitchen plans in here." },
    {
      kind: "reply",
      text: "Of course. We've got the cabinet measurements, the two countertop options, and your preference for keeping the window clear. Where would you like to start?"
    }
  ],
  trip: [
    { kind: "user", text: "I'd like a slower trip next summer. More time in fewer places." },
    {
      kind: "reply",
      text: "Let's start with two bases, with a few unplanned days in each. We can use this chat for routes, places to stay, and anything you want to save."
    }
  ],
  reading: [
    { kind: "user", text: "A place for the AI articles we want to come back to." },
    {
      kind: "reply",
      text: "Good idea. Let's keep the reading and discussion here. Any scheduled news checks will still report to main chat unless you ask me to put them here."
    }
  ]
};
const params = new URLSearchParams(location.search);
const initialVariant = variants.find((v) => v.key === params.get("variant"))?.key ?? "A";
const initialView: View =
  params.get("view") === "phone"
    ? "phone"
    : params.get("view") === "expanded"
      ? "expanded"
      : "docked";

function Prototype() {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [view, setView] = useState<View>(initialView);
  const [active, setActive] = useState("main");
  const [topics, setTopics] = useState(initialTopics);
  const [records, setRecords] = useState(initialRecords);
  const [unread, setUnread] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [topicName, setTopicName] = useState("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dark, setDark] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const activeTopic = topics.find((topic) => topic.id === active);
  const title = activeTopic?.title ?? "Main chat";
  const currentVariant = variants.find((item) => item.key === variant) ?? variants[0];
  const visibleTopics = topics.filter((topic) =>
    topic.title.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("variant", variant);
    url.searchParams.set("view", view);
    history.replaceState(null, "", url);
    console.info("Design preview", {
      variant,
      view,
      conversation: title,
      sideChats: topics.map((t) => t.title)
    });
  }, [variant, view, title, topics]);
  useEffect(() => {
    const element = bodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [active, records]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setNewChatOpen(false);
        setSourceOpen(false);
      }
      if (event.key === "Tab") {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          const controls = Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input, textarea, [tabindex="0"]'
            )
          );
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest("input, textarea, [contenteditable], [role=tablist], [role=dialog]")
      )
        return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = variants.findIndex((v) => v.key === variant);
      setVariant(variants[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3]?.key ?? "A");
      setMenuOpen(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [variant]);

  function selectTopic(id: string) {
    setDrafts((previous) => ({ ...previous, [active]: draft }));
    setDraft(drafts[id] ?? "");
    setActive(id);
    setMenuOpen(false);
    setSearch("");
    if (id === "main") setUnread(0);
  }
  function startSideChat() {
    const name = topicName.trim();
    if (!name) return;
    const id = `topic-${topics.length + 1}`;
    setTopics((previous) => [
      ...previous,
      { id, title: name, note: "A new topic, with the same Moss" }
    ]);
    setRecords((previous) => ({ ...previous, [id]: [] }));
    selectTopic(id);
    setTopicName("");
    setNewChatOpen(false);
  }
  function send() {
    if (!draft.trim()) return;
    setRecords((previous) => ({
      ...previous,
      [active]: [...(previous[active] ?? []), { kind: "user", text: draft.trim() }]
    }));
    setDraft("");
  }
  function addUpdate() {
    if (records.main?.some((record) => record.id === "sample-reminder")) return;
    setRecords((previous) => ({
      ...previous,
      main: [
        ...(previous.main ?? []),
        {
          id: "sample-reminder",
          kind: "reply",
          text: "Quick reminder: send the proposal before you wrap up today. The latest draft is ready when you are."
        }
      ]
    }));
    setUnread((count) => count + 1);
  }
  function conversationList() {
    return (
      <>
        <div className="proto-list-top">
          <Eyebrow tone="muted">Your conversations</Eyebrow>
          {menuOpen && (
            <IconButton
              size="sm"
              aria-label="Close conversation list"
              onClick={() => setMenuOpen(false)}
            >
              <X size={16} />
            </IconButton>
          )}
        </div>
        <NavIndex ariaLabel="Main conversation">
          <NavIndexItem
            label={
              <span className="proto-nav-label">
                <House size={16} /> Main chat
              </span>
            }
            selected={active === "main"}
            count={unread || undefined}
            onSelect={() => selectTopic("main")}
          />
        </NavIndex>
        <div className="proto-topic-heading">
          <Eyebrow tone="muted">Side chats</Eyebrow>
          <IconButton
            size="sm"
            aria-label="New side chat"
            onClick={() => {
              setMenuOpen(false);
              setNewChatOpen(true);
            }}
          >
            <Plus size={17} />
          </IconButton>
        </div>
        <label className="proto-search">
          <Search size={15} />
          <input
            aria-label="Find a side chat"
            placeholder="Find a topic"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <NavIndex ariaLabel="Side conversations">
          {visibleTopics.map((topic) => (
            <NavIndexItem
              key={topic.id}
              label={topic.title}
              selected={active === topic.id}
              onSelect={() => selectTopic(topic.id)}
            />
          ))}
        </NavIndex>
        {!visibleTopics.length && <p className="proto-muted">No matching topics.</p>}
        <p className="proto-nav-note">
          Separate topics.
          <br />
          The same Moss.
        </p>
      </>
    );
  }
  const mainButton = (
    <Button
      variant={active === "main" ? "accentSoft" : "quiet"}
      size="sm"
      icon={<House size={15} />}
      onClick={() => selectTopic("main")}
    >
      Main chat {unread > 0 && <span className="proto-unread">{unread}</span>}
    </Button>
  );

  return (
    <div className="proto-preview">
      <div className="proto-toolbar">
        <div className="proto-preview-label">
          <Eyebrow tone="accent">Chat design</Eyebrow>
          <span>Sample conversations · nothing is saved</span>
        </div>
        <div className="proto-toolbar-actions">
          <div className="proto-view-buttons" aria-label="Preview size">
            {(["docked", "expanded", "phone"] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={view === option ? "accentSoft" : "quiet"}
                aria-pressed={view === option}
                onClick={() => {
                  setView(option);
                  setMenuOpen(false);
                }}
              >
                {option === "docked"
                  ? "Alongside Today"
                  : option === "expanded"
                    ? "Expanded"
                    : "Phone"}
              </Button>
            ))}
          </div>
          <IconButton
            aria-label={dark ? "Use light theme" : "Use dark theme"}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </IconButton>
        </div>
      </div>
      <div className="proto-stage" data-view={view} data-variant={variant}>
        <aside className="sidebar proto-app-nav">
          <div className="brand-lockup">
            <BrandMark size={28} />
            <strong className="brand-wordmark">Moss</strong>
          </div>
          <div className="module-nav" aria-label="App context">
            {[
              { label: "Today", icon: House },
              { label: "Calendar", icon: CalendarDays },
              { label: "Tasks", icon: CheckCheck },
              { label: "Notes", icon: FileText },
              { label: "Email", icon: Mail }
            ].map(({ label, icon: Icon }) => (
              <div key={label} className={`module-link ${label === "Today" ? "active" : ""}`}>
                <Icon />
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="proto-account">
            <Avatar name="Alex" size="sm" />
            <div>
              <strong>Alex</strong>
              <span>Your workspace</span>
            </div>
            <Settings size={17} />
          </div>
        </aside>
        <div className="proto-workspace">
          <div className="proto-app-topbar">
            <span>Today</span>
            <span>
              Wednesday, 7 October <Bell size={17} />
              <Avatar name="Alex" size="sm" />
            </span>
          </div>
          <div className="proto-content">
            {view !== "expanded" && (
              <section className="proto-today" aria-label="Sample Today page">
                <Masthead
                  tone="field"
                  eyebrow="Wednesday · Your day, at a glance"
                  title="A little room to focus."
                  lede="A clear morning, one proposal to finish, and a few things Moss is keeping an eye on."
                />
                <div className="proto-today-body">
                  <SectionHead number="01" title="Your day" meta="Three things ahead" />
                  {[
                    ["10:30", "Project catch-up", "30 minutes · Video call"],
                    ["13:00", "Finish the proposal", "A little quiet time to get it over the line"],
                    ["16:00", "Wrap up", "Check tomorrow before you call it a day"]
                  ].map(([time, item, note]) => (
                    <div className="proto-agenda" key={time}>
                      <span>{time}</span>
                      <div>
                        <strong>{item}</strong>
                        <p>{note}</p>
                      </div>
                    </div>
                  ))}
                  <div className="proto-today-note">
                    <Eyebrow tone="accent">Moss is on it</Eyebrow>
                    <p>
                      Watching for Maya's reply. You'll hear from Moss when there is something
                      useful.
                    </p>
                  </div>
                  <SectionHead number="02" title="Worth a look" />
                  <p className="proto-muted">
                    A few stories saved for later. Your next step can wait until after the proposal.
                  </p>
                </div>
              </section>
            )}
            <section className="proto-chat" aria-label="Moss conversation">
              <header className="proto-chat-head">
                <div className="proto-chat-brand">
                  <BrandMark size={23} />
                  <div>
                    <strong>Moss</strong>
                    <span>Your chief of staff</span>
                  </div>
                </div>
                <div className="proto-chat-head-actions">
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={<Plus size={15} />}
                    onClick={() => setNewChatOpen(true)}
                  >
                    Side chat
                  </Button>
                  <IconButton
                    aria-label={view === "expanded" ? "Show Today alongside chat" : "Expand chat"}
                    onClick={() => setView(view === "expanded" ? "docked" : "expanded")}
                  >
                    {view === "expanded" ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                  </IconButton>
                </div>
              </header>
              {variant === "A" && (
                <div className="proto-mobile-navigation">
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={<MessageSquare size={16} />}
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen(!menuOpen)}
                  >
                    Chats <ChevronDown size={14} />
                  </Button>
                  {active !== "main" && mainButton}
                  <span>{title}</span>
                </div>
              )}
              {variant === "B" && (
                <div className="proto-tabs" role="tablist" aria-label="Conversations">
                  {[{ id: "main", title: "Main chat" }, ...topics].map((topic) => (
                    <button
                      key={topic.id}
                      role="tab"
                      id={`topic-tab-${topic.id}`}
                      aria-controls="conversation-panel"
                      tabIndex={active === topic.id ? 0 : -1}
                      onKeyDown={(event) => {
                        const all = [{ id: "main", title: "Main chat" }, ...topics];
                        const index = all.findIndex((item) => item.id === topic.id);
                        const next =
                          event.key === "ArrowRight"
                            ? (index + 1) % all.length
                            : event.key === "ArrowLeft"
                              ? (index + all.length - 1) % all.length
                              : event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? all.length - 1
                                  : null;
                        if (next === null) return;
                        event.preventDefault();
                        const item = all[next];
                        if (item) {
                          selectTopic(item.id);
                          document.getElementById(`topic-tab-${item.id}`)?.focus();
                        }
                      }}
                      aria-selected={active === topic.id}
                      onClick={() => selectTopic(topic.id)}
                    >
                      {topic.id === "main" && <House size={14} />}
                      {topic.title}
                      {topic.id === "main" && unread > 0 && (
                        <span className="proto-unread">{unread}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {variant === "C" && (
                <div className="proto-picker-bar">
                  {mainButton}
                  <div className="proto-picker-anchor">
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<MessageSquare size={15} />}
                      aria-expanded={menuOpen}
                      onClick={() => setMenuOpen(!menuOpen)}
                    >
                      {active === "main" ? "Side chats" : title}
                      <ChevronsUpDown size={14} />
                    </Button>
                  </div>
                </div>
              )}
              <div className="proto-chat-layout">
                {variant === "A" && (
                  <aside className="proto-conversation-rail">{conversationList()}</aside>
                )}
                {menuOpen && <div className="proto-conversation-popover">{conversationList()}</div>}
                <div
                  className="proto-conversation"
                  id="conversation-panel"
                  role={variant === "B" ? "tabpanel" : undefined}
                  aria-labelledby={variant === "B" ? `topic-tab-${active}` : undefined}
                >
                  <div className="proto-conversation-title">
                    <div>
                      <h1>{title}</h1>
                      <p>
                        {active === "main"
                          ? "Your ongoing conversation with Moss"
                          : "A side chat · same Moss, focused on this topic"}
                      </p>
                    </div>
                    {active !== "main" && variant === "B" && (
                      <IconButton
                        aria-label="Back to main chat"
                        onClick={() => selectTopic("main")}
                      >
                        <House size={17} />
                      </IconButton>
                    )}
                  </div>
                  <div
                    ref={bodyRef}
                    className="proto-thread"
                    onClick={(event) => {
                      const target = event.target;
                      if (
                        target instanceof Element &&
                        target.closest('a[href="https://example.invalid/moss-preview-email"]')
                      ) {
                        event.preventDefault();
                        setSourceOpen(true);
                      }
                    }}
                  >
                    {(records[active]?.length ?? 0) > 0 ? (
                      <>
                        <div className="proto-date">Today</div>
                        <Thread
                          records={
                            active === "main"
                              ? (records.main ?? []).slice(0, 4)
                              : (records[active] ?? [])
                          }
                          working={false}
                        />
                      </>
                    ) : (
                      <EmptyState
                        icon={<MessageSquare size={24} />}
                        title={`Let's talk about ${title.toLowerCase()}.`}
                        description="A separate conversation, with everything Moss already knows about you."
                      />
                    )}
                    {active === "main" && (
                      <>
                        <div className="proto-update-divider">
                          <span>While you were away</span>
                        </div>
                        <Thread records={(records.main ?? []).slice(4)} working={false} />
                      </>
                    )}
                  </div>
                  {active !== "main" && unread > 0 && (
                    <button className="proto-main-alert" onClick={() => selectTopic("main")}>
                      <BrandMark size={16} />
                      <span>
                        {unread === 1
                          ? "Moss has an update in main chat"
                          : `${unread} updates in main chat`}
                      </span>
                      <ArrowRight size={15} />
                    </button>
                  )}
                  <form
                    className="proto-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      send();
                    }}
                  >
                    <textarea
                      className="jds-input"
                      aria-label={`Message ${title}`}
                      placeholder={
                        active === "main"
                          ? "Message Moss…"
                          : `Message about ${title.toLowerCase()}…`
                      }
                      rows={2}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          send();
                        }
                      }}
                    />
                    <div className="proto-composer-foot">
                      <span>
                        <Paperclip size={15} /> {active === "main" ? "Main chat" : "Side chat"}
                      </span>
                      <IconButton aria-label="Send message" disabled={!draft.trim()} onClick={send}>
                        <ArrowDown className="proto-send-arrow" size={18} />
                      </IconButton>
                    </div>
                  </form>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
      <div className="proto-demo-actions">
        <Button
          variant="link"
          size="sm"
          icon={<Bell size={14} />}
          onClick={addUpdate}
          disabled={records.main?.some((record) => record.id === "sample-reminder")}
        >
          Add an update to main chat
        </Button>
        <span>Try switching chats, starting a topic, or typing a message.</span>
      </div>
      {import.meta.env.DEV && (
        <div className="proto-switcher" aria-label="Compare design options">
          <IconButton
            aria-label="Previous design"
            onClick={() => {
              setVariant(
                variants[(variants.findIndex((v) => v.key === variant) + 2) % 3]?.key ?? "A"
              );
              setMenuOpen(false);
            }}
          >
            <ArrowLeft size={18} />
          </IconButton>
          <div>
            <div className="proto-option-buttons">
              {variants.map((option) => (
                <button
                  key={option.key}
                  aria-label={`Option ${option.key}: ${option.name}`}
                  aria-pressed={variant === option.key}
                  onClick={() => {
                    setVariant(option.key);
                    setMenuOpen(false);
                  }}
                >
                  {option.key}
                </button>
              ))}
            </div>
            <strong>{currentVariant?.name}</strong>
            <span>{currentVariant?.description}</span>
          </div>
          <IconButton
            aria-label="Next design"
            onClick={() => {
              setVariant(
                variants[(variants.findIndex((v) => v.key === variant) + 1) % 3]?.key ?? "A"
              );
              setMenuOpen(false);
            }}
          >
            <ArrowRight size={18} />
          </IconButton>
        </div>
      )}
      {newChatOpen && (
        <Dialog
          title={<span id="new-topic-title">New side chat</span>}
          aria-labelledby="new-topic-title"
          description="A place for one topic. You can always return to main chat."
          onClose={() => setNewChatOpen(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setNewChatOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!topicName.trim()} onClick={startSideChat}>
                Start side chat
              </Button>
            </>
          }
        >
          <label className="proto-new-topic">
            Topic
            <input
              autoFocus
              className="jds-input"
              placeholder="For example, home projects"
              value={topicName}
              onChange={(event) => setTopicName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") startSideChat();
              }}
            />
          </label>
        </Dialog>
      )}
      {sourceOpen && (
        <Dialog
          title={<span id="source-title">Maya's reply</span>}
          aria-labelledby="source-title"
          description="Sample email · Today, 10:12 AM"
          onClose={() => setSourceOpen(false)}
          footer={<Button onClick={() => setSourceOpen(false)}>Back to chat</Button>}
        >
          <p>The direction looks great. Could you send the final version by Friday?</p>
          <p>
            Thanks,
            <br />
            Maya
          </p>
        </Dialog>
      )}
    </div>
  );
}

const mount = document.getElementById("root");
if (mount && import.meta.env.DEV) createRoot(mount).render(<Prototype />);
