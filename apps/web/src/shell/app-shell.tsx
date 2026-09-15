import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Menu, MessageSquare } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { useLocation, useNavigate } from "react-router";

import { listNotifications, listThemes, sendChatTurn, signOut } from "../api/client";
import { useAssistantName } from "../api/use-assistant-name";
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
import { ChatControlsProvider } from "./chat-controls-context";
import { applyThemeTokens } from "../theme/theme-runtime";
import { CommandPalette } from "./command-palette";
import {
  PageTrailProvider,
  TopbarMoreActions,
  TopbarTrail,
  usePageTrailDisplay,
  useRequestPageTrailEdit
} from "./page-trail";
import { WORKSHOP_MODULE_ID } from "@moss/shared";
import {
  loadShellColorMode,
  loadShellTheme,
  saveShellColorMode,
  saveShellTheme,
  type ShellTheme
} from "./theme-storage";
import { loadShellNav, saveShellNav, type ShellNavMode } from "./nav-storage";
import { ShellNav } from "./shell-nav";
import {
  DEFAULT_CHAT_SURFACE,
  type ChatSurface,
  type MeResponse,
  type ModuleDto
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
  const [navMode, setNavMode] = useState<ShellNavMode>(() => loadShellNav());
  const openNavButtonRef = useRef<HTMLButtonElement | null>(null);
  const toggleNav = () => {
    setNavMode((prev) => {
      const next: ShellNavMode = prev === "rail" ? "expanded" : "rail";
      saveShellNav(next);
      return next;
    });
  };
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
    <div className="app-frame" data-nav={navMode}>
      <PageTrailProvider>
        <ShellNav
          navMode={navMode}
          onToggleNav={toggleNav}
          mobileNavOpen={mobileNavOpen}
          closeMobileNav={closeMobileNav}
          openNavButtonRef={openNavButtonRef}
          me={props.me}
          modulesLoading={props.modulesLoading}
          navSections={navSections}
          unreadByModule={unreadByModule}
          unreadCount={unreadCount}
          signOutPending={signOutMutation.isPending}
          onSignOut={() => signOutMutation.mutate()}
          onNavigate={(to) => {
            closeMobileNav();
            navigate(to);
          }}
        />

        <div className="workspace-area">
          <header className="topbar">
            <button
              aria-label="Open navigation"
              className="icon-button mobile-only"
              ref={openNavButtonRef}
              title="Open navigation"
              type="button"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu size={20} aria-hidden="true" />
            </button>

            <TopbarTitles
              title={title}
              subtitle={subtitle}
              showSettingsButton={showSettingsButton}
              moduleId={activeModuleId}
            />

            <div className="topbar-actions">
              <TrailMoreButton />
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
      </PageTrailProvider>
    </div>
  );
}

const RENAME_TRAIL_ACTION = { id: "__trail_rename", label: "Rename" } as const;

/**
 * The page's "More" button at the bar's right, ahead of the assistant button. It exists only
 * while a page holds the trail with actions or a rename handler — any other page shows no More
 * button at all. "Rename" is the shell's own item, prepended whenever the page allows renaming:
 * choosing it puts the title itself into edit mode rather than opening anything.
 */
function TrailMoreButton() {
  const trail = usePageTrailDisplay();
  const requestEdit = useRequestPageTrailEdit();
  if (!trail) return null;
  const actions = trail.onRename ? [RENAME_TRAIL_ACTION, ...trail.actions] : trail.actions;
  if (actions.length === 0) return null;
  return (
    <TopbarMoreActions
      actions={actions}
      onAction={(id) => {
        if (id === RENAME_TRAIL_ACTION.id) requestEdit();
        else trail.onAction?.(id);
      }}
    />
  );
}

/**
 * The top bar's title area. While a page holds the trail (a Workshop project), the bar shows
 * the section as the way back, then the page name and its meta note — in place of the plain
 * title, never beside it. Otherwise the ordinary title and subtitle render unchanged.
 */
function TopbarTitles(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly showSettingsButton: boolean;
  readonly moduleId: string | null;
}) {
  const trail = usePageTrailDisplay();
  if (!trail) {
    return (
      <div className="topbar-titles">
        <div className="topbar-title-row">
          <span className="topbar-title">{props.title}</span>
          {props.showSettingsButton && props.moduleId ? (
            <ModuleSettingsButton moduleId={props.moduleId} moduleName={props.title} />
          ) : null}
        </div>
        {props.subtitle ? <span className="topbar-subtitle">{props.subtitle}</span> : null}
      </div>
    );
  }
  return (
    <div className="topbar-titles">
      <TopbarTrail
        sectionLabel={trail.sectionLabel}
        sectionPath={trail.sectionPath}
        name={trail.name}
        meta={trail.meta}
        onRename={trail.onRename}
        trailing={
          props.showSettingsButton && props.moduleId ? (
            <ModuleSettingsButton moduleId={props.moduleId} moduleName={trail.name} />
          ) : null
        }
      />
    </div>
  );
}
