import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode
} from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { MODULE_WEB_CONTRIBUTIONS, MODULE_WEB_ROUTES } from "virtual:moss-module-web";
import { confineModuleCss } from "@moss/module-css-confine";
import { WORKSHOP_MODULE_ID, workshopModuleManifest } from "@moss/workshop";

import {
  ApiError,
  getBootstrapStatus,
  getMe,
  getModules,
  getMyModules,
  getOnboardingStatus,
  getPersonaSettings,
  shipExternalModule,
  throwAwayExternalModuleDraft
} from "./api/client";
import { webRoutePath } from "./app-route-metadata";
import { queryKeys } from "./api/query-keys";
import { AuthScreen } from "./auth/auth-screen";
import { createAssistantSurfaceHandle, useAssistantSurfaceHost } from "./chat/assistant-surface";
import { DraftBanner } from "./chat/draft-banner";
import { ThrowAwayDraftDialog } from "./chat/throw-away-draft-dialog";
import {
  installModuleHostRuntime,
  loadExternalModuleContribution,
  type ExternalWebContributionProps
} from "./external-modules/loader";
import { createModuleHostActions } from "./external-modules/host-actions";
import { shouldShowOnboarding } from "./onboarding/resume";
import { OnboardingWizard } from "./onboarding/onboarding-wizard";
import { AppShell } from "./shell/app-shell";
import { useChatControls } from "./shell/chat-controls-context";

// #918: install the host React runtime before any external module bundle can ever be
// imported (module scope — runs once at app boot, well before the first lazy() fires).
installModuleHostRuntime();

const CalendarPage = lazy(() =>
  import("./calendar/calendar-page").then((module) => ({ default: module.CalendarPage }))
);
const NotificationsPage = lazy(() =>
  import("./notifications/notifications-page").then((module) => ({
    default: module.NotificationsPage
  }))
);
const SettingsPage = lazy(() =>
  import("./settings/settings-page").then((module) => ({ default: module.SettingsPage }))
);
const TodayPage = lazy(() =>
  import("./today/today-page").then((module) => ({ default: module.TodayPage }))
);
const TasksPage = lazy(() =>
  import("./tasks/tasks-page").then((module) => ({ default: module.TasksPage }))
);
const WellnessPage = lazy(() =>
  import("./wellness/wellness-page").then((module) => ({ default: module.WellnessPage }))
);

/**
 * Generic module-web route docking (#799). Each `virtual:moss-module-web` route entry names a
 * moduleId + path from the module's backend manifest; the matching `./web` contribution is lazily
 * loaded and its declared `routes[].element` (matched by path) is rendered. Computed once at
 * module scope (not per-render) so each route keeps a stable `lazy()` identity across App renders.
 */
/**
 * #1890: where a user lands after throwing a draft away. Read from the workshop module's own
 * navigation declaration rather than typed as a literal, so it cannot drift from the route the
 * shell actually registers.
 */
const WORKSHOP_PATH =
  workshopModuleManifest.navigation.find((item) => item.id === WORKSHOP_MODULE_ID)?.path ?? "/";

const moduleRoutes = MODULE_WEB_ROUTES.map((route) => ({
  path: route.path,
  moduleId: route.moduleId,
  Component: lazy(async (): Promise<{ default: ComponentType }> => {
    const entry = MODULE_WEB_CONTRIBUTIONS.find(
      (candidate) => candidate.moduleId === route.moduleId
    );
    if (!entry) return { default: () => null };
    const contribution = (await entry.load()).default;
    const matched = contribution.routes?.find((candidate) => candidate.path === route.path);
    return { default: () => <>{matched?.element ?? null}</> };
  })
}));

export function App() {
  const queryClient = useQueryClient();
  const bootstrapQuery = useQuery({
    queryKey: queryKeys.auth.bootstrap,
    queryFn: getBootstrapStatus
  });
  const meQuery = useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: () => getMe(),
    retry: false
  });
  const modulesQuery = useQuery({
    enabled: meQuery.isSuccess,
    queryKey: queryKeys.modules,
    queryFn: () => getModules(),
    retry: false
  });
  /**
   * External-module web routes (#918). Distinct from the built-in `moduleRoutes` const
   * above: external bundles are untrusted at build time, so each Component is loaded via
   * `loadExternalModuleContribution` (host-runtime pinning + contract-version gate,
   * fails closed to a no-op component) rather than a static `import()`. Recomputed only
   * when the modules list changes so each route keeps a stable `lazy()` identity.
   */
  const externalModuleRoutes = useMemo(
    () =>
      (modulesQuery.data?.modules ?? [])
        .filter((m) => m.external === true && m.web !== undefined)
        .map((m) => ({
          moduleId: m.id,
          path: `/m/${m.id}/*`,
          // #1756: true only for the caller's own still-running draft (ModuleDto.draft — see
          // apps/api/src/module-dto.ts's serializeExternalModule, which only ever sets this for
          // a draft the caller owns; #1753's active-module resolver already hides anyone else's).
          isDraft: m.draft === true,
          // D9 (#1388): the module's Root and its raw css load together; wrap Root in the
          // host-owned ModuleCssScope here (not inside ExternalModuleMount) so the css that
          // travels with THIS lazy load is the css that gets scoped — no separate state to
          // keep in sync across the async boundary.
          Component: lazy(async () => {
            const { Component: Root, css } = await loadExternalModuleContribution({
              moduleId: m.id,
              entrypoint: m.web!.entrypoint,
              contractVersion: m.web!.contractVersion
            });
            const ScopedRoot: ComponentType<ExternalWebContributionProps> = (rootProps) => (
              <ModuleCssScope moduleId={m.id} css={css}>
                <Root {...rootProps} />
              </ModuleCssScope>
            );
            return { default: ScopedRoot };
          })
        })),
    [modulesQuery.data]
  );
  // Phase 4: onboarding is no longer founder-only. Any ACTIVE authenticated user fetches their
  // role-appropriate status (founder = instance-global; member = per-user). Pending/deactivated
  // identities never reach here (handled by the error branches below before the shell renders).
  const activeForOnboarding = meQuery.data?.user.status === "active";
  const myModulesQuery = useQuery({
    enabled: meQuery.isSuccess,
    queryKey: queryKeys.myModules,
    queryFn: () => getMyModules(),
    retry: false
  });
  const disabledModuleIds =
    myModulesQuery.data?.modules.filter((m) => !m.active).map((m) => m.id) ?? [];
  // A disabled module's SPA route must not render its UI on a deep-link, not just hide its
  // nav entry — for a health-data module that means the page (and its API calls) never mount
  // for a disabled actor. We can only confirm the module is ENABLED once /api/me/modules
  // resolves successfully; until then the gate shows a loader. The gate FAILS CLOSED: if that
  // request errors we cannot prove the actor is enabled, so we redirect rather than risk
  // rendering the health-data UI for a disabled actor (Codex code-review).
  const myModulesEnabled = (moduleId: string): "loading" | "enabled" | "denied" => {
    if (myModulesQuery.isError) return "denied"; // fail closed: cannot prove enabled
    if (!myModulesQuery.isSuccess) return "loading";
    // Affirmative enablement only: require an explicit active row. "Not listed" (backend skew,
    // partial/malformed response) is NOT proof of enablement for a health-data route — deny it
    // (Codex code-review R3).
    const module = myModulesQuery.data.modules.find((m) => m.id === moduleId);
    return module?.active === true ? "enabled" : "denied";
  };
  const wellnessGate = myModulesEnabled("wellness");
  const onboardingQuery = useQuery({
    enabled: activeForOnboarding,
    queryKey: queryKeys.onboarding.status,
    queryFn: getOnboardingStatus,
    retry: false // getOnboardingStatus is itself bounded by a 4s timeout (client.ts)
  });
  // Kept as a background prefetch only — useAssistantName (and other consumers) read this
  // same cache entry and fall back gracefully while it's pending, so boot must not gate on it.
  useQuery({
    queryKey: queryKeys.settings.persona,
    queryFn: getPersonaSettings,
    enabled: meQuery.isSuccess,
    retry: false // getPersonaSettings is itself bounded by a 4s timeout (client.ts)
  });

  const handleAuthenticated = async () => {
    // Data-isolation on the shared house instance: a newly authenticated identity
    // must never inherit the previous user's cached data. resetQueries() evicts
    // every cached query to its initial state — including inactive entries the
    // prior user left behind — and refetches the mounted identity queries under
    // the new session cookie. invalidateQueries was insufficient on two counts:
    // (1) it kept the prior user's data visible while refetching, and (2) its
    // prefix list omitted the "settings" and "connectors" namespaces, so that
    // cached data was never refreshed at all. (We use resetQueries, not clear():
    // clear() destroys queries without notifying their observers, so the mounted
    // `me`/`bootstrap` queries would never refetch and sign-in would hang.)
    await queryClient.resetQueries();
  };

  if (bootstrapQuery.isLoading || meQuery.isLoading) {
    return <LoadingScreen />;
  }

  if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
    return (
      <AuthScreen
        needsBootstrap={bootstrapQuery.data?.needsBootstrap ?? false}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  if (meQuery.error instanceof ApiError && meQuery.error.code === "account_pending_approval") {
    return <PendingApprovalScreen />;
  }

  if (meQuery.error instanceof ApiError && meQuery.error.code === "account_deactivated") {
    return <DeactivatedScreen />;
  }

  if (!meQuery.data) {
    return (
      <FatalState
        message={readErrorMessage(meQuery.error)}
        onRetry={() => void queryClient.invalidateQueries({ queryKey: ["auth"] })}
      />
    );
  }

  if (activeForOnboarding) {
    // A hung status read cannot trap the user: getOnboardingStatus is bounded to 4s, so
    // isLoading resolves to data-or-error within that window. We show a bounded loader only
    // on first boot (avoids a shell flash before the wizard); on error/timeout
    // onboardingQuery.data is undefined ⇒ we fall through to the app shell below.
    if (onboardingQuery.isLoading) {
      return <LoadingScreen />;
    }
    const onboardingStatus = onboardingQuery.data;
    // Phase 4: the gate fires for any active user whose role-appropriate onboarding is incomplete.
    //   Founder: shouldShowOnboarding (bootstrap owner + instance-global state === "pending").
    //   Member:  per-user completion — the wizard shows until app.member_onboarding.completed_at
    //            is stamped (skip == complete).
    // On a status error/timeout onboardingStatus is undefined ⇒ neither branch fires ⇒ shell.
    const incomplete =
      onboardingStatus !== undefined &&
      (onboardingStatus.role === "founder"
        ? shouldShowOnboarding(meQuery.data, onboardingStatus)
        : !onboardingStatus.completed);
    if (incomplete) {
      // The wizard is wrapped in BrowserRouter because member steps (api-key-opt-out,
      // section-tour) render react-router <Link> elements; rendering a <Link> outside a Router
      // throws a context invariant and crashes the app the moment the member advances into
      // those steps. The shell below mounts its own BrowserRouter — the two are never mounted
      // at once (this is an early return), so there is no nested-router conflict.
      return (
        <BrowserRouter>
          <OnboardingWizard
            initialStatus={onboardingStatus}
            onDone={() =>
              void queryClient.invalidateQueries({ queryKey: queryKeys.onboarding.status })
            }
          />
        </BrowserRouter>
      );
    }
    // else: terminal/complete state OR errored/timed-out ⇒ fall through to the shell.
  }

  return (
    <BrowserRouter>
      <AppShell
        me={meQuery.data}
        modules={modulesQuery.data?.modules ?? []}
        modulesLoading={modulesQuery.isLoading}
        disabledModuleIds={disabledModuleIds}
      >
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route index element={<Navigate to={webRoutePath("today")} replace />} />
            <Route
              path={webRoutePath("today")}
              element={
                <TodayPage
                  me={meQuery.data}
                  wellnessEnabled={wellnessGate === "enabled"}
                  disabledModuleIds={disabledModuleIds}
                />
              }
            />
            <Route path={webRoutePath("tasks")} element={<TasksPage />} />
            <Route path={webRoutePath("notifications")} element={<NotificationsPage />} />
            <Route path={webRoutePath("calendar")} element={<CalendarPage />} />
            <Route
              path={webRoutePath("wellness")}
              element={
                <ModuleGatedRoute gate={wellnessGate}>
                  <WellnessPage />
                </ModuleGatedRoute>
              }
            />
            {moduleRoutes.map(({ path, moduleId, Component }) => (
              <Route
                key={path}
                path={path}
                element={
                  <ModuleGatedRoute gate={myModulesEnabled(moduleId)}>
                    <Component />
                  </ModuleGatedRoute>
                }
              />
            ))}
            {externalModuleRoutes.map((route) => (
              <Route
                key={`ext:${route.moduleId}`}
                path={route.path}
                element={
                  <ExternalModuleMount
                    moduleId={route.moduleId}
                    Component={route.Component}
                    actorScopeKey={meQuery.data.user.id}
                    isDraft={route.isDraft}
                  />
                }
              />
            ))}
            <Route path={webRoutePath("settings")} element={<SettingsPage me={meQuery.data} />} />
            <Route
              path="*"
              element={<NotFoundRedirect modulesLoading={modulesQuery.isLoading} />}
            />
          </Routes>
        </Suspense>
      </AppShell>
    </BrowserRouter>
  );
}

/**
 * Renders a module's SPA route only when the actor's per-user module state proves the module
 * is enabled. "loading" → a loader (no flash of the gated UI); "denied" (disabled OR the
 * state request errored — fail closed) → redirect to /tasks so the gated UI never mounts;
 * "enabled" → render the children.
 */
/**
 * #916 — the catch-all "*" route. External module routes are only added to the tree once
 * `modulesQuery` resolves (Task 4's `externalModuleRoutes` is derived from its data), so on a
 * hard navigation/deep link to `/m/:id` the module's specific Route doesn't exist yet for the
 * first render(s) and would otherwise fall through here and get redirected to Today before the
 * query ever has a chance to add it. Hold on a loading screen for `/m/*` paths while modules are
 * still loading; only redirect once we know the path truly isn't a module (or isn't external).
 */
function NotFoundRedirect(props: { readonly modulesLoading: boolean }) {
  const location = useLocation();
  if (props.modulesLoading && location.pathname.startsWith("/m/")) {
    return <LoadingScreen />;
  }
  return <Navigate to={webRoutePath("today")} replace />;
}

function ModuleGatedRoute(props: {
  readonly gate: "loading" | "enabled" | "denied";
  readonly children: ReactNode;
}) {
  if (props.gate === "loading") return <LoadingScreen />;
  if (props.gate === "denied") return <Navigate to="/tasks" replace />;
  return <>{props.children}</>;
}

/**
 * #916 — mount point for one external module's web Root. Rendered inside AppShell, so it can read
 * the shell's chat controls from context and build `hostActions` bound to THIS module id (closure
 * at a host-controlled call site — the module never supplies its own id). Recomputed only when the
 * id or the callback identity changes.
 */
/**
 * #1975: pulled out of ExternalModuleMount's effect so it has a plain unit test — mounting
 * ExternalModuleMount itself needs a chat-controls provider, an assistant-surface-host
 * provider, a query client and a router all wired up together, and this repo's test
 * convention (see app-shell-chat-surface.test.tsx) already prefers isolating the decision
 * from that wiring where it can.
 */
export function shouldOpenChatFromNavigation(isDraft: boolean, locationState: unknown): boolean {
  return isDraft && Boolean((locationState as { openChat?: boolean } | null)?.openChat);
}

function ExternalModuleMount(props: {
  readonly moduleId: string;
  readonly Component: ComponentType<ExternalWebContributionProps>;
  /** #1213: opaque actor token passed through hostActions only for client-side namespacing. */
  readonly actorScopeKey: string;
  /** #1756: true only for the caller's own still-running draft (see externalModuleRoutes above). */
  readonly isDraft: boolean;
}) {
  const { openAssistantWithDraft, openChat } = useChatControls();
  const { subscribeRecords, seedComposer } = useAssistantSurfaceHost();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmingThrowAway, setConfirmingThrowAway] = useState(false);
  // #1975: Workshop's "Ask for a change" button navigates here with { openChat: true } in
  // router state (packages/workshop can't reach this file's openChat directly — see the
  // spec's module-isolation note). Runs once on mount, then clears the flag via a
  // history replace so it does not refire on a later re-render or on back-navigation into
  // this same route.
  useEffect(() => {
    if (shouldOpenChatFromNavigation(props.isDraft, location.state)) {
      openChat();
      navigate(location.pathname, { replace: true, state: null });
    }
    // Intentionally run once on mount only — see the comment above.
  }, []);
  // #1756: ships the draft for real — POST /api/admin/modules/:id/ship (packages/settings/src/
  // routes-modules.ts). Success flips the DB row from draft to enabled and clears its owner;
  // refetching /api/modules is what makes ModuleDto.draft disappear and the banner unmount.
  const shipMutation = useMutation({
    mutationFn: () => shipExternalModule(props.moduleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.modules });
    }
  });
  // #1890: throws the draft away for real — DELETE /api/admin/modules/:id/draft. On success the
  // module's row, its installed folder and any leftover build folder are gone, so this page no
  // longer exists: refetch the module list (which unmounts this route) and leave for the
  // workshop. Order matters — navigate FIRST, so the route this component lives on is not pulled
  // out from under it while it is still mounted.
  const throwAwayMutation = useMutation({
    mutationFn: () => throwAwayExternalModuleDraft(props.moduleId),
    onSuccess: () => {
      setConfirmingThrowAway(false);
      navigate(WORKSHOP_PATH, { replace: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.modules });
      // The workshop reads the current user through its own key; refetch so its groups
      // recompute once they are wired to real data.
      void queryClient.invalidateQueries({ queryKey: ["workshop"] });
    }
  });
  const hostActions = useMemo(
    () => createModuleHostActions(props.moduleId, openAssistantWithDraft, props.actorScopeKey),
    [props.moduleId, props.actorScopeKey, openAssistantWithDraft]
  );
  // #1196/#1284 — same host-controlled binding as hostActions: the module id is host-bound at this
  // mount site; the module itself only ever supplies an opaque key via setSurfaceKey (never a raw
  // surface — see chat-surface-key.ts for why concatenation can't be trusted).
  const assistantSurface = useMemo(
    () => createAssistantSurfaceHandle(subscribeRecords, props.moduleId, seedComposer),
    [props.moduleId, seedComposer, subscribeRecords]
  );
  // #1284 — a module's claim on the shell's one chat stream must not outlive its own mount:
  // without this, navigating away from the module's route would leave the drawer permanently
  // reading a now-orphaned surface (the "reset to drawer" half of the setSurfaceKey contract).
  useEffect(() => {
    return () => assistantSurface.setSurfaceKey(null);
  }, [assistantSurface]);
  const Component = props.Component;
  const page = <Component hostActions={hostActions} assistantSurface={assistantSurface} />;
  if (!props.isDraft) return page;
  // #1756: a running draft gets the banner + its page, with the chat drawer docked beside it —
  // AppShell keys the docking off this same module's ModuleDto.draft, matched by the route.
  return (
    <div className="draft-workshop-page">
      <DraftBanner
        moduleId={props.moduleId}
        whatItReaches="only you, until you ship it"
        whatItKeeps="its own data, same as any module that's already shipped"
        restartRequired={
          shipMutation.isSuccess
            ? "Shipped. Everyone else can see it once the app restarts."
            : "Shipping makes it visible to everyone, once the app restarts."
        }
        onShip={() => shipMutation.mutate()}
        onAskForChange={openChat}
        onThrowAway={() => setConfirmingThrowAway(true)}
        throwAwayPending={throwAwayMutation.isPending}
        seeCodeUnavailableReason="Viewing the code isn't wired up yet."
      />
      {confirmingThrowAway ? (
        <ThrowAwayDraftDialog
          moduleId={props.moduleId}
          busy={throwAwayMutation.isPending}
          error={
            throwAwayMutation.isError
              ? "That didn't work, and the draft is still here. Try again in a moment."
              : undefined
          }
          onCancel={() => setConfirmingThrowAway(false)}
          onConfirm={() => throwAwayMutation.mutate()}
        />
      ) : null}
      <div className="draft-workshop-page__body">{page}</div>
    </div>
  );
}

const moduleCssRefCounts = new Map<string, number>();

/**
 * D9 (#1388): the host-owned CSS scope root. `data-module` is set here, never by the module
 * itself — packages/module-css-confine prefixes every module selector to `[data-module="<id>"]`,
 * so this attribute IS the scope boundary. Confinement + the `<style>` element's lifecycle both
 * live here, one level above ExternalModuleMount, because this is where the module's raw css
 * (loaded alongside its Root in the same lazy() call — see externalModuleRoutes above) is
 * actually in scope. Ref-counted by style element id so two mounts of the same module id (not
 * possible via routing today, but not assumed away) share one `<style>` tag.
 */
function ModuleCssScope(props: {
  readonly moduleId: string;
  readonly css: string;
  readonly children: ReactNode;
}) {
  const { moduleId, css } = props;
  useEffect(() => {
    if (!css) return undefined;
    const styleId = `moss-module-css-${moduleId}`;
    if (!document.getElementById(styleId)) {
      const { css: confined, rejectedAtRules } = confineModuleCss(css, moduleId);
      if (rejectedAtRules.length > 0) {
        console.warn(
          `Module "${moduleId}" css: dropped unscoped at-rule(s) ${rejectedAtRules.join(", ")}`
        );
      }
      const styleEl = document.createElement("style");
      styleEl.id = styleId;
      styleEl.textContent = confined;
      document.head.appendChild(styleEl);
    }
    moduleCssRefCounts.set(moduleId, (moduleCssRefCounts.get(moduleId) ?? 0) + 1);
    return () => {
      const next = (moduleCssRefCounts.get(moduleId) ?? 1) - 1;
      if (next <= 0) {
        moduleCssRefCounts.delete(moduleId);
        document.getElementById(styleId)?.remove();
      } else {
        moduleCssRefCounts.set(moduleId, next);
      }
    };
  }, [moduleId, css]);
  return <div data-module={moduleId}>{props.children}</div>;
}

function LoadingScreen() {
  return (
    <main className="center-screen">
      <div className="loading-mark" aria-hidden="true" />
      <p>Loading Moss</p>
    </main>
  );
}

function FatalState(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <main className="center-screen">
      <section className="auth-panel">
        <h1>Moss</h1>
        <p className="form-error">{props.message}</p>
        <button className="primary-button" type="button" onClick={props.onRetry}>
          Retry
        </button>
      </section>
    </main>
  );
}

function PendingApprovalScreen() {
  return (
    <main className="center-screen">
      <section className="auth-panel">
        <h1>Moss</h1>
        <p>Your account is pending approval by an administrator.</p>
        <p className="form-hint">
          You will be able to sign in once your account has been approved.
        </p>
      </section>
    </main>
  );
}

function DeactivatedScreen() {
  return (
    <main className="center-screen">
      <section className="auth-panel">
        <h1>Moss</h1>
        <p className="form-error">Your account has been deactivated.</p>
        <p className="form-hint">Please contact your administrator for assistance.</p>
      </section>
    </main>
  );
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load Moss";
}
