import { useSignOutGuard } from "./use-sign-out-guard";
import { hasSessionUnsavedChanges } from "@moss/module-web-sdk";
import { SignOutConfirmation } from "./sign-out-confirmation";
import { randomUuid, validMeetingChatInput, type OpenMeetingChatInput } from "@moss/module-web-sdk";
import { meetingIdOnRoute } from "./meeting-route-context";
import { MeetingChatDrawer } from "../chat/meeting-chat-drawer";
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
import { useAssistantName } from "../api/use-assistant-name.js";
import { buildShellNavigation, resolvePageHeading, webRoutes } from "../app-route-metadata";
import { ModulePersistentControls } from "./module-persistent-controls";
import { ModuleSettingsButton } from "./module-settings-button";
import { useUserLocale } from "../locale/locale-format";
import { queryKeys } from "../api/query-keys";
import { useActionQueryRefresh } from "../chat/use-action-query-refresh";
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
import { saveShellColorMode, saveShellTheme, saveShellPageTone } from "./theme-storage";
import { resolveShellAppearance } from "./shell-appearance";
import { syncThemeColorMeta } from "./theme-color-meta";
import { loadShellNav, saveShellNav, type ShellNavMode } from "./nav-storage";
import { ShellNav } from "./shell-nav";
import {
  DEFAULT_CHAT_SURFACE,
  type ChatSurface,
  type MeResponse,
  type ModuleDto
} from "@moss/shared";

// Narrowest window where the page and a 380px chat panel fit side by side without crowding.
const WIDE_QUERY = "(min-width: 1280px)";
const PHONE_QUERY = "(max-width: 720px)";

const KNOWN_MODULES_WITH_SETTINGS = new Set(["calendar", "news", "sports", "tasks", "wellness"]);

export function hasModuleSettings(moduleId: string, modules: readonly ModuleDto[] = []): boolean {
  if (KNOWN_MODULES_WITH_SETTINGS.has(moduleId)) return true;
  return modules.some(
    (m) =>
      m.id === moduleId &&
      (Boolean(m.settingsPath) || (Array.isArray(m.settings) && m.settings.length > 0))
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
  const [explicitMeetingSelection, setMeetingSelection] = useState<
    (OpenMeetingChatInput & { selectionId: string; route: string; actor: string }) | null
  >(null);
  const routeMeetingId = meetingIdOnRoute(location.pathname, location.search);
  const [dismissedMeetingId, setDismissedMeetingId] = useState<string | null>(null);
  const routeSelection = useMemo(
    () =>
      routeMeetingId
        ? {
            meetingId: routeMeetingId,
            title: "About this meeting",
            selectionId: randomUuid()
          }
        : null,
    [routeMeetingId, props.me.user.id]
  );
  const routeIdentity = `${location.pathname}:${routeMeetingId ?? ""}`;
  const meetingSelection =
    explicitMeetingSelection?.route === routeIdentity &&
    explicitMeetingSelection.actor === props.me.user.id
      ? explicitMeetingSelection
      : dismissedMeetingId === routeMeetingId
        ? null
        : routeSelection;
  useEffect(() => {
    setMeetingSelection(null);
    setDismissedMeetingId(null);
  }, [routeMeetingId, props.me.user.id]);
  const openMeetingChat = useCallback(
    (input: OpenMeetingChatInput) => {
      if (!validMeetingChatInput(input)) return;
      setDismissedMeetingId(null);
      setMeetingSelection({
        ...input,
        selectionId: randomUuid(),
        route: routeIdentity,
        actor: props.me.user.id
      });
      setChatOpen(true);
      setModuleDraft(undefined);
    },
    [routeIdentity, props.me.user.id]
  );
  const currentMeetingSelection = useRef(meetingSelection);
  currentMeetingSelection.current = meetingSelection;
  const clearMeetingChat = useCallback(
    (meetingId: string) => {
      if (
        currentMeetingSelection.current !== meetingSelection ||
        meetingSelection?.meetingId !== meetingId
      )
        return;
      setDismissedMeetingId(meetingId);
      setMeetingSelection(null);
      setChatOpen(false);
    },
    [meetingSelection]
  );
  const [chatOpen, setChatOpen] = useState(false);
  // #916 — a module-authored starter draft handed up via ChatControls.openAssistantWithDraft.
  const [moduleDraft, setModuleDraft] = useState<string | undefined>(undefined);
  const [focusActionRequestId, setFocusActionRequestId] = useState<string | null>(null);
  const embeddedComposerRef = useRef<((draft: string) => void) | null>(null);
  const openChatWith = useCallback(
    (prompt: string) => {
      setDismissedMeetingId(routeMeetingId);
      setMeetingSelection(null);
      setChatOpen(true);
      void sendChatTurn(prompt);
    },
    [routeMeetingId]
  );
  const openChat = useCallback(() => {
    setMeetingSelection(null);
    setChatOpen(true);
  }, []);
  // #916 — open the drawer with a module-authored draft the user edits + submits (NEVER auto-sent;
  // contrast openChatWith, which sends). Direct setState in an event handler is correct here — this
  // is NOT a render-phase updater, so it is not the StrictMode double-fire trap #368 warned about.
  const openAssistantWithDraft = useCallback(
    (draft: string) => {
      setDismissedMeetingId(routeMeetingId);
      setMeetingSelection(null);
      const embeddedComposer = embeddedComposerRef.current;
      if (embeddedComposer) {
        embeddedComposer(draft);
        return;
      }
      setModuleDraft(draft);
      setChatOpen(true);
    },
    [routeMeetingId]
  );
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
  const { records, clearRecords, streamErrorCount } = useChatStream(
    activeSurface,
    meetingSelection === null
  );
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
  useActionQueryRefresh(records, props.modules, props.modulesLoading);
  const openActionRequest = useCallback((actionRequestId: string) => {
    setMeetingSelection(null);
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
  useEffect(() => {
    // Until the theme list loads, keep what the boot script applied from the same saved values.
    // Re-applying from storage here would flash a dark custom theme light and save that tone.
    if (!themesQuery.data) return;
    const appearance = resolveShellAppearance(themesQuery.data);
    document.documentElement.setAttribute("data-theme", appearance.dataTheme);
    document.documentElement.setAttribute("data-color-mode", appearance.colorMode);
    applyThemeTokens(document.documentElement.style, appearance.tokens);
    document.documentElement.toggleAttribute(
      "data-nav-color",
      document.documentElement.style.getPropertyValue("--nav-bg") !== ""
    );
    document.documentElement.toggleAttribute(
      "data-header-color",
      document.documentElement.style.getPropertyValue("--header-bg") !== ""
    );
    syncThemeColorMeta();
    saveShellTheme(appearance.themeId);
    saveShellColorMode(appearance.colorMode);
    saveShellPageTone(appearance.pageTone);
  }, [themesQuery.data]);
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

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!hasSessionUnsavedChanges(queryClient)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [queryClient]);
  const signOutGuard = useSignOutGuard(queryClient, () => {
    setMeetingSelection(null);
    setChatOpen(false);
    signOutMutation.mutate();
  });

  // Chat sits beside the page when the window is wide enough for both, on every screen. A
  // running draft module keeps the docked layout down to the mobile breakpoint. Below that the
  // drawer is the ordinary floating overlay.
  const [wideWindow, setWideWindow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(WIDE_QUERY).matches
  );
  useEffect(() => {
    const media = window.matchMedia?.(WIDE_QUERY);
    if (!media) return;
    const sync = () => setWideWindow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const [phoneWindow, setPhoneWindow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_QUERY).matches
  );
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    if (!media) return;
    const sync = () => setPhoneWindow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const dockChat = useMemo(() => {
    if (wideWindow) return true;
    if (!location.pathname.startsWith("/m/")) return false;
    const moduleId = location.pathname.slice("/m/".length).split("/")[0];
    return props.modules.some((module) => module.id === moduleId && module.draft === true);
  }, [wideWindow, location.pathname, props.modules]);

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

  // Exactly one ChatDrawer element, always rendered in the same spot so it stays mounted (and
  // keeps unsent text) when the window crosses the dock breakpoint. dockChat only switches its
  // layout between beside-the-page and the floating overlay.
  const [chatExpanded, setChatExpanded] = useState(false);
  const expanded = chatExpanded && dockChat && chatOpen && !phoneWindow;
  // Picking another screen drops back to docked so the chosen page is visible.
  useEffect(() => {
    setChatExpanded(false);
  }, [location.pathname]);
  const chatDrawer =
    meetingSelection && chatOpen ? (
      <MeetingChatDrawer
        key={meetingSelection.selectionId}
        selection={meetingSelection}
        onRemoveContext={() => {
          setDismissedMeetingId(meetingSelection.meetingId);
          setMeetingSelection(null);
        }}
        docked={dockChat}
        expanded={expanded}
        onToggleExpanded={dockChat && !phoneWindow ? () => setChatExpanded((v) => !v) : undefined}
        isFounder={props.me.user.isBootstrapOwner}
        onClose={() => {
          setMeetingSelection(null);
          setChatOpen(false);
          setChatExpanded(false);
        }}
      />
    ) : (
      <ChatDrawer
        open={chatOpen}
        docked={dockChat}
        expanded={expanded}
        onToggleExpanded={dockChat && !phoneWindow ? () => setChatExpanded((v) => !v) : undefined}
        onClose={() => {
          setChatOpen(false);
          setChatExpanded(false);
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
    <div className="app-frame" data-nav={navMode} data-chat-expanded={expanded || undefined}>
      {signOutGuard.confirming ? (
        <SignOutConfirmation onCancel={signOutGuard.cancel} onConfirm={signOutGuard.confirm} />
      ) : null}
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
          onSignOut={signOutGuard.request}
          onNavigate={(to) => {
            closeMobileNav();
            navigate(to);
          }}
        />

        <div className="workspace-area">
          <header className="topbar" hidden={expanded}>
            <button
              aria-label="Open navigation"
              aria-controls="moss-main-navigation"
              aria-expanded={mobileNavOpen}
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
              modules={props.modules}
            />

            <div className="topbar-actions">
              <ModulePersistentControls disabledModuleIds={props.disabledModuleIds ?? []} />
              <TrailMoreButton />
              <button
                aria-label={assistantName ? `Chat with ${assistantName}` : "Open chat"}
                aria-pressed={chatOpen}
                className={`icon-button ${chatOpen ? "active" : ""}`}
                title={assistantName ? `Ask ${assistantName}` : "Open chat"}
                type="button"
                onClick={() => {
                  if (chatOpen) setChatOpen(false);
                  else openChat();
                }}
              >
                <MessageSquare size={19} aria-hidden="true" />
              </button>
            </div>
          </header>

          <div
            className={`workspace-body ${dockChat && chatOpen ? "workspace-body--docked" : ""} ${expanded ? "workspace-body--expanded" : ""}`}
          >
            <main className="content-surface" hidden={expanded}>
              <AssistantSurfaceHostProvider value={assistantSurfaceHost}>
                <ChatControlsProvider
                  value={{
                    openChat,
                    openChatWith,
                    openMeetingChat,
                    clearMeetingChat,
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

            {chatDrawer}
          </div>
        </div>

        <CommandPalette
          modules={props.modules}
          disabledModuleIds={props.disabledModuleIds ?? []}
          themes={themesQuery.data}
          navigate={navigate}
        />
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
 * title, never beside it. Either way the date line sits under the title row.
 */
function TopbarTitles(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly showSettingsButton: boolean;
  readonly moduleId: string | null;
  readonly modules: readonly ModuleDto[];
}) {
  const trail = usePageTrailDisplay();
  if (!trail) {
    return (
      <div className="topbar-titles">
        <div className="topbar-title-row">
          <span className="topbar-title">{props.title}</span>
          {props.showSettingsButton && props.moduleId ? (
            <ModuleSettingsButton
              moduleId={props.moduleId}
              moduleName={props.title}
              modules={props.modules}
            />
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
            <ModuleSettingsButton
              moduleId={props.moduleId}
              moduleName={trail.name}
              modules={props.modules}
            />
          ) : null
        }
      />
      {props.subtitle ? <span className="topbar-subtitle">{props.subtitle}</span> : null}
    </div>
  );
}
