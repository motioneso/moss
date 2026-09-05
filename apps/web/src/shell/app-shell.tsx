import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronUp, Layers3, LogOut, Menu, MessageSquare, Settings } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router";

import { listNotifications, listThemes, sendChatTurn, signOut } from "../api/client";
import { useAssistantName } from "../api/use-assistant-name";
import { getWeatherToday } from "../api/weather-client";
import { buildShellNavigation, resolvePageHeading, webRoutes } from "../app-route-metadata";
import { ModuleSettingsButton } from "./module-settings-button";
import { useUserLocale } from "../locale/locale-format";
import { queryKeys, resolveQueryKeyToken } from "../api/query-keys";
import { ChatDrawer } from "../chat/chat-drawer";
import {
  AssistantSurfaceHostProvider,
  getActiveModuleSurface,
  subscribeActiveModuleSurface,
  type AssistantRecordV1,
  type AssistantSurfaceHostValue
} from "../chat/assistant-surface";
import { useChatStream } from "../chat/use-chat-stream";
import { usePageContextSync } from "../chat/use-page-context-sync";
import { BrandMark } from "./brand-mark";
import { ChatControlsProvider } from "./chat-controls-context";
import { HeaderWeather } from "../today/header-weather";
import { applyThemeTokens } from "../theme/theme-runtime";
import { CommandPalette } from "./command-palette";
import { NAV_ICON_MAP } from "./nav-icons";
import { WORKSHOP_MODULE_ID } from "@moss/shared";
import {
  loadShellColorMode,
  loadShellTheme,
  saveShellColorMode,
  saveShellTheme,
  type ShellTheme
} from "./theme-storage";
import {
  DEFAULT_CHAT_SURFACE,
  type ChatSurface,
  type MeResponse,
  type ModuleDto,
  type ModuleNavigationEntryDto
} from "@moss/shared";

const KNOWN_MODULES_WITH_SETTINGS = new Set(["calendar", "news", "sports", "tasks", "wellness"]);

export function hasModuleSettings(moduleId: string, modules: readonly ModuleDto[] = []): boolean {
  if (KNOWN_MODULES_WITH_SETTINGS.has(moduleId)) return true;
  return modules.some(
    (m) => m.id === moduleId && Array.isArray(m.settings) && m.settings.length > 0
  );
}

export function resolveActiveModuleId(pathname: string): string | null {
  const externalMatch = pathname.match(/^\/m\/([^/]+)/)?.[1];
  if (externalMatch) return externalMatch;
  const route = webRoutes.find((item) => item.match(pathname));
  if (!route) return null;
  if (route.id !== "today" && route.id !== "notifications" && route.id !== "settings") {
    return route.id;
  }
  return null;
}

interface AppShellProps {
  readonly children: ReactNode;
  readonly me: MeResponse;
  readonly modules: readonly ModuleDto[];
  readonly modulesLoading: boolean;
  readonly disabledModuleIds?: readonly string[];
}

export function AppShell(props: AppShellProps) {
  usePageContextSync();
  // Keep this usable while the cosmetic persona query is pending, without briefly naming a
  // custom assistant "Moss". All other shell content continues to render immediately.
  const assistantName = useAssistantName("");
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // #916 — a module-authored starter draft handed up via ChatControls.openAssistantWithDraft.
  const [moduleDraft, setModuleDraft] = useState<string | undefined>(undefined);
  const [focusActionRequestId, setFocusActionRequestId] = useState<string | null>(null);
  const embeddedComposerRef = useRef<((draft: string) => void) | null>(null);
  const [theme] = useState<ShellTheme>(() => loadShellTheme());
  const [colorMode] = useState(() => loadShellColorMode());
  const openChatWith = useCallback((prompt: string) => {
    setChatOpen(true);
    void sendChatTurn(prompt);
  }, []);
  const openChat = useCallback(() => setChatOpen(true), []);
  // #916 — open the drawer with a module-authored draft the user edits + submits (NEVER auto-sent;
  // contrast openChatWith, which sends). Direct setState in an event handler is correct here — this
  // is NOT a render-phase updater, so it is not the StrictMode double-fire trap #368 warned about.
  const openAssistantWithDraft = useCallback((draft: string) => {
    const embeddedComposer = embeddedComposerRef.current;
    if (embeddedComposer) {
      embeddedComposer(draft);
      return;
    }
    setModuleDraft(draft);
    setChatOpen(true);
  }, []);
  // #1284 — which module surface (if any) currently owns the shell's one chat stream. A module
  // claims one via assistantSurface.setSurfaceKey (handle.ts's module-level store, #1196/#1232's
  // "one external route mounts at a time" is what makes a single subscribable value sufficient
  // here); this is the sole subscriber, turning a claim into an actual stream switch below and
  // into the drawer-isolation check recordsForSurface performs.
  const activeModuleSurface = useSyncExternalStore(
    subscribeActiveModuleSurface,
    getActiveModuleSurface,
    getActiveModuleSurface
  );
  // activeModuleSurface is `string | null` per useSyncExternalStore's snapshot type, but every
  // non-null value it can ever hold came from moduleChatSurface (handle.ts's setSurfaceKey), whose
  // fixed 18-char output already satisfies CHAT_SURFACE_PATTERN by construction — so this cast
  // (rather than a redundant normalizeChatSurface re-validation) just recovers that branding.
  const activeModuleSurfaceBranded = activeModuleSurface as ChatSurface | null;
  const activeSurface = activeModuleSurfaceBranded ?? DEFAULT_CHAT_SURFACE;
  // Lifted to the shell so the SSE stream + transcript persist while the drawer is closed and as
  // the user navigates between pages — the chat follows the user. Always pass the defaulted
  // `activeSurface`, never the raw `activeModuleSurfaceBranded ?? undefined` — the latter left
  // useChatStream's rehydration effect permanently gated off for the default drawer (#1449).
  const { records, clearRecords, streamErrorCount } = useChatStream(activeSurface);
  const assistantRecordListeners = useRef(
    new Set<(records: readonly AssistantRecordV1[]) => void>()
  );
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const subscribeAssistantRecords = useCallback<AssistantSurfaceHostValue["subscribeRecords"]>(
    (listener) => {
      const listeners = assistantRecordListeners.current;
      listeners.add(listener);
      listener(recordsRef.current);
      return () => listeners.delete(listener);
    },
    []
  );
  useEffect(() => {
    for (const listener of assistantRecordListeners.current) listener(records);
  }, [records]);
  // #1196/#1232 — one external route mounts at a time. Route hosts receive drafts inline while
  // the ordinary shell controls remain available for the visible drawer-isolation check.
  const registerAssistantComposer = useCallback<AssistantSurfaceHostValue["registerComposer"]>(
    (acceptDraft) => {
      embeddedComposerRef.current = acceptDraft;
      setChatOpen(false);
      setModuleDraft(undefined);
      setFocusActionRequestId(null);
      return () => {
        if (embeddedComposerRef.current !== acceptDraft) return;
        embeddedComposerRef.current = null;
      };
    },
    []
  );
  const seedAssistantComposer = useCallback((draft: string) => {
    embeddedComposerRef.current?.(draft);
  }, []);
  // #1284/#1332 — Ben's ruling, refined 2026-07-28: the drawer shows the chat you are actually
  // in, and nothing else. `records` is whichever surface's stream is currently live (see the
  // useChatStream call above); this hands it back for the ONE surface that's active right now, so
  // any other surface gets `[]`.
  //
  // #1284's "a module's thread must never appear in the main drawer" is a LEAKAGE rule, not a
  // blanket one: it means a module's transcript must not survive your leaving the module. That is
  // enforced here by construction — `setSurfaceKey(null)` on unmount flips `activeSurface` back to
  // DEFAULT_CHAT_SURFACE, and the module's records stop matching on the very next render.
  const recordsForSurface = useCallback(
    (surface: string) => (surface === activeSurface ? records : []),
    [records, activeSurface]
  );
  const assistantSurfaceHost = useMemo<AssistantSurfaceHostValue>(
    () => ({
      records,
      recordsForSurface,
      registerComposer: registerAssistantComposer,
      seedComposer: seedAssistantComposer,
      subscribeRecords: subscribeAssistantRecords
    }),
    [
      records,
      recordsForSurface,
      registerAssistantComposer,
      seedAssistantComposer,
      subscribeAssistantRecords
    ]
  );
  const pendingNotesDelete = useMemo(() => {
    const results = new Set(
      records
        .filter((record) => record.kind === "action_result" && record.actionRequestId)
        .map((record) => record.actionRequestId)
    );
    return (
      [...records]
        .reverse()
        .find(
          (record) =>
            record.kind === "action_request" &&
            record.toolName === "notes.delete" &&
            Boolean(record.actionRequestId) &&
            !results.has(record.actionRequestId)
        ) ?? null
    );
  }, [records]);
  // #1310: generic, declaration-driven cache invalidation. A tool's manifest entry
  // declares which frontend query-key tokens its write affects; this effect resolves
  // each token via resolveQueryKeyToken (fail-closed) and invalidates only that key —
  // never a blanket invalidation, and never anything theme-specific hardcoded here.
  const invalidatedActionRequestIds = useRef(new Set<string>());
  useEffect(() => {
    for (const record of records) {
      if (record.kind !== "action_result" || record.outcome !== "executed") continue;
      if (!record.affectsQueryKeys || record.affectsQueryKeys.length === 0) continue;
      const actionRequestId = record.actionRequestId;
      if (!actionRequestId || invalidatedActionRequestIds.current.has(actionRequestId)) continue;
      invalidatedActionRequestIds.current.add(actionRequestId);
      for (const token of record.affectsQueryKeys) {
        const queryKey = resolveQueryKeyToken(token);
        if (queryKey) {
          void queryClient.invalidateQueries({ queryKey: [...queryKey] });
        }
      }
    }
  }, [records, queryClient]);
  const openActionRequest = useCallback((actionRequestId: string) => {
    setFocusActionRequestId(actionRequestId);
    setChatOpen(true);
  }, []);
  const isInstanceAdmin = props.me.user.isInstanceAdmin;
  const navModules = useMemo(
    () =>
      isInstanceAdmin
        ? props.modules
        : props.modules.filter((module) => module.id !== WORKSHOP_MODULE_ID),
    [props.modules, isInstanceAdmin]
  );
  const navSections = useMemo(
    () => buildShellNavigation(navModules, props.disabledModuleIds ?? []),
    [navModules, props.disabledModuleIds]
  );
  const notificationsQuery = useQuery({
    queryKey: queryKeys.notifications.list,
    queryFn: () => listNotifications()
  });
  const themesQuery = useQuery({
    queryKey: queryKeys.settings.themes,
    queryFn: () => listThemes()
  });
  const activeThemeId = themesQuery.data?.activeId ?? theme;
  useEffect(() => {
    const customTheme =
      themesQuery.data?.custom.find((custom) => custom.id === activeThemeId) ?? null;
    const isCustomTheme = Boolean(customTheme);
    const mode = isCustomTheme ? "light" : (themesQuery.data?.mode ?? colorMode);
    document.documentElement.setAttribute(
      "data-theme",
      isCustomTheme ? activeThemeId : activeThemeId === "dark" ? "light" : activeThemeId
    );
    document.documentElement.setAttribute("data-color-mode", mode);
    applyThemeTokens(document.documentElement.style, customTheme?.tokens ?? null);
    saveShellTheme(activeThemeId);
    saveShellColorMode(mode);
  }, [activeThemeId, colorMode, themesQuery.data?.custom, themesQuery.data?.mode]);
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;
  // #1285: per-module breakdown of the same unread count, for the nav badge. Defaults to `{}`
  // while loading or if an older cached response lacks the field — never renders a badge in
  // that case (NavItem only shows a badge for a strictly-positive count).
  const unreadByModule = notificationsQuery.data?.unreadByModule ?? {};
  const onTodayPage = location.pathname.startsWith("/today");
  const weatherQuery = useQuery({
    queryKey: queryKeys.weather.today,
    queryFn: getWeatherToday,
    staleTime: 30 * 60 * 1000,
    enabled: onTodayPage
  });
  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/");
    }
  });

  // #1756: dock the chat drawer beside the page only while the visible route is the caller's
  // own running draft (ModuleDto.draft — set only for a draft the caller owns; see
  // apps/api/src/module-dto.ts's serializeExternalModule). Everywhere else the drawer stays the
  // ordinary floating overlay.
  const dockChat = useMemo(() => {
    if (!location.pathname.startsWith("/m/")) return false;
    const moduleId = location.pathname.slice("/m/".length).split("/")[0];
    return props.modules.some((module) => module.id === moduleId && module.draft === true);
  }, [location.pathname, props.modules]);

  const locale = useUserLocale();
  const { title, subtitle } = resolvePageHeading(
    location.pathname,
    new Date(),
    locale,
    props.modules
  );
  const activeModuleId = resolveActiveModuleId(location.pathname);
  const showSettingsButton =
    activeModuleId !== null && hasModuleSettings(activeModuleId, props.modules);
  const closeMobileNav = () => setMobileNavOpen(false);

  // #1756: exactly one ChatDrawer element, rendered in one of two spots below (docked beside
  // the page, or in its ordinary floating overlay spot) depending on dockChat — never both at
  // once, and never a second instance.
  const chatDrawer = (
    <ChatDrawer
      open={chatOpen}
      docked={dockChat}
      onClose={() => {
        setChatOpen(false);
        setFocusActionRequestId(null);
        // #916: starters are one-shot — a later manual open starts from a blank composer.
        setModuleDraft(undefined);
      }}
      // #1332 — the drawer renders whichever surface is LIVE, which is what makes opening the
      // header control inside a profile give you that profile's thread (job-search spec §7)
      // instead of an empty panel. Outside a module `activeSurface` is DEFAULT_CHAT_SURFACE, so
      // this is the ordinary drawer thread; no module content can survive the exit, because the
      // surface key is also the history lookup key all the way down to the repository.
      records={recordsForSurface(activeSurface)}
      clearRecords={clearRecords}
      streamErrorCount={streamErrorCount}
      isFounder={props.me.user.isBootstrapOwner}
      initialText={moduleDraft}
      focusActionRequestId={focusActionRequestId}
      onActionRequestFocused={() => setFocusActionRequestId(null)}
      surface={activeSurface}
    />
  );

  return (
    <div className="app-frame">
      <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div className="brand-lockup">
          <span className="brand-mark">
            <BrandMark />
          </span>
          <span className="brand-wordmark">Moss</span>
        </div>

        {/* #1734: the accessible name is what a screen reader announces on entering this
            landmark, so "Modules" leaked our packaging word to exactly the users least able to
            ignore it. "Main" names what the list is for. */}
        <nav className="module-nav" aria-label="Main">
          {navSections.map((section) => (
            <div className="nav-group" key={section.key}>
              {section.label ? <p className="nav-group__label">{section.label}</p> : null}
              {section.items.map((entry) => (
                <NavItem
                  key={entry.id}
                  entry={entry}
                  unreadByModule={unreadByModule}
                  onClick={closeMobileNav}
                />
              ))}
            </div>
          ))}
          {/* #1734: "Loading modules" named our packaging; the user is just waiting for the list. */}
          {props.modulesLoading ? <span className="nav-loading">Loading</span> : null}
        </nav>

        <div className="rail-foot">
          <RailUserMenu
            me={props.me}
            unreadCount={unreadCount}
            signOutPending={signOutMutation.isPending}
            onSignOut={() => signOutMutation.mutate()}
            onNavigate={(to) => {
              closeMobileNav();
              navigate(to);
            }}
          />
        </div>
      </aside>

      {mobileNavOpen ? (
        <button
          aria-label="Close navigation"
          className="sidebar-scrim"
          type="button"
          onClick={closeMobileNav}
        />
      ) : null}

      <div className="workspace-area">
        <header className="topbar">
          <button
            aria-label="Open navigation"
            className="icon-button mobile-only"
            title="Open navigation"
            type="button"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </button>

          <div className="topbar-titles">
            <div className="topbar-title-row">
              <span className="topbar-title">{title}</span>
              {showSettingsButton ? (
                <ModuleSettingsButton moduleId={activeModuleId} moduleName={title} />
              ) : null}
            </div>
            {subtitle ? <span className="topbar-subtitle">{subtitle}</span> : null}
          </div>

          {onTodayPage ? (
            <div className="topbar-context">
              <HeaderWeather weather={weatherQuery.data?.data ?? null} />
            </div>
          ) : null}

          <div className="topbar-actions">
            <button
              aria-label={assistantName ? `Chat with ${assistantName}` : "Open chat"}
              aria-pressed={chatOpen}
              className={`icon-button ${chatOpen ? "active" : ""}`}
              title={assistantName ? `Ask ${assistantName}` : "Open chat"}
              type="button"
              onClick={() => setChatOpen((open) => !open)}
            >
              <MessageSquare size={19} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className={`workspace-body ${dockChat && chatOpen ? "workspace-body--docked" : ""}`}>
          <main className="content-surface">
            <AssistantSurfaceHostProvider value={assistantSurfaceHost}>
              <ChatControlsProvider
                value={{
                  openChat,
                  openChatWith,
                  openAssistantWithDraft,
                  pendingNotesDelete: pendingNotesDelete
                    ? {
                        actionRequestId: pendingNotesDelete.actionRequestId!,
                        summary: pendingNotesDelete.summary ?? pendingNotesDelete.text
                      }
                    : null,
                  openActionRequest
                }}
              >
                {props.children}
              </ChatControlsProvider>
            </AssistantSurfaceHostProvider>
          </main>

          {dockChat ? chatDrawer : null}
        </div>
      </div>

      <CommandPalette
        modules={props.modules}
        disabledModuleIds={props.disabledModuleIds ?? []}
        themes={themesQuery.data}
        navigate={navigate}
      />

      {dockChat ? null : chatDrawer}
    </div>
  );
}

function formatUnreadCount(unreadCount: number): string {
  return unreadCount > 99 ? "99+" : String(unreadCount);
}

function initialOf(value: string): string {
  return (value.trim()[0] ?? "?").toUpperCase();
}

/** Account quick-menu at the rail foot: click the profile to open Notifications,
    Settings, the dark-mode toggle, and Log out in a popover. */
function RailUserMenu(props: {
  readonly me: MeResponse;
  readonly unreadCount: number;
  readonly signOutPending: boolean;
  readonly onSignOut: () => void;
  readonly onNavigate: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const name = props.me.user.name.trim() || props.me.user.email;

  return (
    <div className={`jds-usermenu ${open ? "is-open" : ""}`} ref={ref}>
      <button
        className={`jds-usermenu__trigger ${open ? "is-open" : ""}`}
        type="button"
        aria-label={
          props.unreadCount > 0
            ? `Account menu, ${formatUnreadCount(props.unreadCount)} unread notification${props.unreadCount === 1 ? "" : "s"}`
            : "Account menu"
        }
        onClick={() => setOpen((o) => !o)}
      >
        <span className="jds-usermenu__av">
          <span className="jds-avatar jds-avatar--sm">{initialOf(name)}</span>
        </span>
        <span className="jds-usermenu__id">
          <span className="jds-usermenu__nm">{name}</span>
          <span className="jds-usermenu__sub">{props.me.user.email}</span>
        </span>
        {!open && props.unreadCount > 0 ? (
          <span className="jds-badge-count" aria-hidden="true">
            {formatUnreadCount(props.unreadCount)}
          </span>
        ) : null}
        <span className="jds-usermenu__chev">
          <ChevronUp size={16} aria-hidden="true" />
        </span>
      </button>
      {open ? (
        <div className="jds-usermenu__pop">
          <div className="jds-usermenu__list">
            <button
              className="jds-usermenu__item"
              type="button"
              onClick={() => {
                setOpen(false);
                props.onNavigate("/notifications");
              }}
            >
              <span className="jds-usermenu__ic">
                <Bell size={16} aria-hidden="true" />
              </span>
              <span className="jds-usermenu__lbl">Notifications</span>
              {props.unreadCount > 0 ? (
                <span className="jds-usermenu__tr">
                  <span className="jds-badge-count">{formatUnreadCount(props.unreadCount)}</span>
                </span>
              ) : null}
            </button>
            <button
              className="jds-usermenu__item"
              type="button"
              onClick={() => {
                setOpen(false);
                props.onNavigate("/settings");
              }}
            >
              <span className="jds-usermenu__ic">
                <Settings size={16} aria-hidden="true" />
              </span>
              <span className="jds-usermenu__lbl">Settings &amp; permissions</span>
            </button>
            <div className="jds-usermenu__div" />
            <button
              className="jds-usermenu__item is-danger"
              type="button"
              disabled={props.signOutPending}
              onClick={props.onSignOut}
            >
              <span className="jds-usermenu__ic">
                <LogOut size={16} aria-hidden="true" />
              </span>
              <span className="jds-usermenu__lbl">Log out</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * #1285: `ModuleNavigationEntryDto` (packages/shared/src/platform-api.ts) does not yet declare
 * a `badge` field — extending it there, and re-emitting it from `serializeExternalModule` in
 * apps/api/src/server.ts, is outside this task's file boundary pending a scope decision from
 * team-lead. This local extension keeps NavItem forward-compatible without touching that DTO:
 * `badge` is simply always `undefined` until the DTO gains the field, so this is inert, not a
 * behavior change. The manifest-facing counterpart (`ExternalModuleNavigationEntry.badge` in
 * module-sdk) is already validated and re-emitted end-to-end by validate.ts.
 */
type NavEntryWithBadge = ModuleNavigationEntryDto & {
  readonly badge?: { readonly source: "notifications" };
};

function NavItem(props: {
  readonly entry: ModuleNavigationEntryDto;
  readonly unreadByModule: Readonly<Record<string, number>>;
  readonly onClick: () => void;
}) {
  const Icon = props.entry.icon ? (NAV_ICON_MAP[props.entry.icon] ?? Layers3) : Layers3;
  const entry = props.entry as NavEntryWithBadge;
  // #1285: a nav entry id is always exactly the owning module's id, or "<moduleId>.<slug>"
  // (validate.ts's #1019 anti-spoof rule enforces this at manifest-validation time), so
  // splitting on "." reliably recovers the true module id without needing a separate
  // moduleId prop threaded through app-route-metadata.ts's buildShellNavigation.
  const moduleId = entry.id.split(".")[0] ?? entry.id;
  const unreadCount =
    entry.badge?.source === "notifications" ? (props.unreadByModule[moduleId] ?? 0) : 0;

  return (
    <NavLink
      className={({ isActive }) => `module-link ${isActive ? "active" : ""}`}
      to={props.entry.path}
      onClick={props.onClick}
    >
      <Icon size={17} />
      <span>{props.entry.label}</span>
      {unreadCount > 0 ? (
        // #1285: a module can only ever select WHICH core-owned count to display
        // (badge.source is a closed enum), never supply its own number — this renders
        // exactly `unreadByModule`, never anything module-authored. Inline flex override
        // is needed because `.module-link span` (styles.css) sets flex:1 on every span
        // descendant, including this one, and styles.css is outside this task's file
        // boundary to edit.
        <span className="jds-badge-count" style={{ flex: "0 0 auto" }}>
          {formatUnreadCount(unreadCount)}
        </span>
      ) : null}
    </NavLink>
  );
}
