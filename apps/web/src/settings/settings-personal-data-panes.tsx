import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Boxes,
  BrainCircuit,
  CalendarDays,
  FolderCheck,
  FolderOpen,
  FolderSearch,
  HeartPulse,
  ListChecks,
  Lock,
  Mail,
  MessagesSquare,
  Newspaper,
  NotebookText,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sunrise,
  Trophy,
  Unlink,
  Wallet,
  type LucideIcon
} from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { MODULE_SETTINGS_COMPONENTS, MODULE_SETTINGS_SURFACES } from "virtual:moss-module-settings";

import {
  getModules,
  getMyModules,
  listConnectorAccounts,
  revokeConnectorAccount,
  setMyModuleDisabled
} from "../api/client";
import { getConnectorFeatureGrants, updateConnectorFeatureGrants } from "../api/connectors-client";
import {
  getNotesLastSync,
  getNotesSource,
  postNotesSync,
  putNotesSource
} from "../api/notes-client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import { GOOGLE_CONNECT_SUCCESS_QUERY_KEYS } from "../connectors/use-google-connect-flow";
import { getConnectorAccountHealth, isConnectorSyncInFlight } from "./settings-connector-sync";
import { GoogleConnect } from "./settings-google-connect";
import { ImapConnect } from "./settings-imap-connect";
import {
  BriefingSettings,
  ChatSettingsView,
  NotificationSettings
} from "./settings-module-subviews";
import { useFeedback } from "./settings-feedback";
import { resolveModuleSettingsDeepLink } from "./module-settings-deep-link";
import { ModulePreferencesSettings } from "./settings-module-preferences";
import {
  settingsModuleControlModel,
  visibleConfigurableModules,
  type SettingsModule
} from "./settings-module-view-model";
import { moduleDescription, readError, type PaneProps } from "./settings-types";
import {
  Badge,
  formatTimestamp,
  Group,
  Indicator,
  findModuleSettingsEntrySurface,
  ModuleSettingsRouter,
  Note,
  PaneHead,
  Row,
  Switch
} from "./settings-ui";
import { VaultChooser } from "./settings-vault-chooser";
import { useChatControls } from "../shell/chat-controls-context";
import { type ConnectorAccountDto, type PutNotesSourceRequest } from "@moss/shared";
import { Button } from "@moss/ui";

const MODULE_ICONS: Record<string, LucideIcon> = {
  tasks: ListChecks,
  calendar: CalendarDays,
  briefings: Sunrise,
  chat: MessagesSquare,
  knowledge: BrainCircuit,
  wellness: HeartPulse,
  sports: Trophy,
  news: Newspaper,
  notifications: Bell,
  finance: Wallet,
  email: Mail
};

function moduleIcon(id: string): LucideIcon {
  return MODULE_ICONS[id] ?? Boxes;
}

/* ------------------------------------------------------- Connected accounts */

function AccountRow(props: {
  readonly account: ConnectorAccountDto;
  readonly onRevoke: () => void;
  readonly onReconnect: () => void;
}) {
  const { account } = props;
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const assistantName = useAssistantName();
  const health = getConnectorAccountHealth(account);
  const hasEmail = hasEmailScope(account.scopes);
  const hasCalendar = hasCalendarScope(account.scopes);
  const featureQuery = useQuery({
    queryKey: queryKeys.connectors.featureGrants(account.id),
    queryFn: () => getConnectorFeatureGrants(account.id),
    enabled: account.status !== "revoked" && (hasEmail || hasCalendar),
    retry: false
  });
  const featureMutation = useMutation({
    mutationFn: (input: { readonly email?: boolean; readonly calendar?: boolean }) =>
      updateConnectorFeatureGrants(account.id, input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.connectors.featureGrants(account.id), data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.connectors.accounts });
      toast("Access saved", { icon: <ShieldCheck size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const grants = featureQuery.data;
  return (
    <div className="acct">
      <div className="acct__logo">{account.providerDisplayName[0]?.toUpperCase() ?? "?"}</div>
      <div className="acct__main">
        <div className="acct__name">{account.providerDisplayName}</div>
        <div className="acct__sub">
          <span>{account.providerType}</span>
          <span className="acct__dot">·</span>
          <span>Live connection</span>
          <Indicator status={health.indicator} label={health.label} />
        </div>
        {account.scopes.length ? (
          <div className="acct__scopes">{account.scopes.join(" · ")}</div>
        ) : null}
        <div className="acct__scopes">
          Fallback cache{" "}
          {account.lastSyncFinishedAt
            ? `updated ${formatTimestamp(account.lastSyncFinishedAt, account.lastSyncFinishedAt)}`
            : "not yet populated"}
        </div>
        {health.alert ? <div className="acct__alert">{health.alert}</div> : null}
        {account.status !== "revoked" && (hasEmail || hasCalendar) ? (
          <div className="acct__features">
            {hasEmail ? (
              <FeatureGrantSwitch
                label="Email access"
                desc={`${assistantName} may read your email from this account.`}
                checked={grants?.email ?? true}
                disabled={featureQuery.isLoading || featureMutation.isPending}
                onChange={(email) => featureMutation.mutate({ email })}
              />
            ) : null}
            {hasCalendar ? (
              <FeatureGrantSwitch
                label="Calendar access"
                desc={`${assistantName} may read your calendar from this account.`}
                checked={grants?.calendar ?? true}
                disabled={featureQuery.isLoading || featureMutation.isPending}
                onChange={(calendar) => featureMutation.mutate({ calendar })}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="acct__actions">
        {health.canReconnect ? (
          <Button variant="secondary" size="sm" onClick={props.onReconnect}>
            Reconnect
          </Button>
        ) : null}
        {account.status !== "revoked" ? (
          <Button variant="quiet" size="sm" onClick={props.onRevoke}>
            Revoke
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function FeatureGrantSwitch(props: {
  readonly label: string;
  readonly desc: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="acct-feature">
      <div>
        <div className="acct-feature__label">{props.label}</div>
        <div className="acct-feature__desc">{props.desc}</div>
      </div>
      <Switch
        ariaLabel={props.label}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    </div>
  );
}

function hasEmailScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope.includes("gmail") || scope.includes("mail"));
}

function hasCalendarScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope.includes("calendar"));
}

function ServicePicker(props: { readonly onGoogle: () => void; readonly onImap: () => void }) {
  return (
    <div className="provpick" style={{ marginTop: 14 }}>
      <div className="provpick__hd">Connect an account</div>
      <div className="provpick__grid">
        <button type="button" className="provpick__item" onClick={props.onGoogle}>
          <span className="provpick__dot" />
          Google
        </button>
        <button type="button" className="provpick__item" onClick={props.onImap}>
          <span className="provpick__dot" />
          Email (IMAP)
        </button>
        <button
          type="button"
          className="provpick__item"
          disabled
          aria-label="GitHub — coming soon, tracked in issue #1061"
        >
          <span className="provpick__dot" />
          GitHub <span className="provpick__on">Coming soon · #1061</span>
        </button>
      </div>
      <div className="provpick__foot">
        Google and email (IMAP) connect through your own credentials — nothing passes through anyone
        else's servers.
      </div>
    </div>
  );
}

function ConnectedPane() {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const assistantName = useAssistantName();
  const [flow, setFlow] = useState<null | "picker" | "google" | "imap">(null);
  const accountsQuery = useQuery({
    queryKey: queryKeys.connectors.accounts,
    queryFn: listConnectorAccounts,
    retry: false,
    // Background refresh keeps the fallback-cache line honest while a first
    // snapshot is still landing after connect; there is no manual sync anymore.
    refetchInterval: (query) => {
      const accounts = query.state.data?.accounts ?? [];
      return accounts.some(isConnectorSyncInFlight) ? 2000 : false;
    },
    refetchIntervalInBackground: false
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeConnectorAccount(id),
    onSuccess: () => {
      // Revoking a connector flips connectors.done (derived from "an account exists"), so refresh
      // onboarding.status too — not just the accounts list — or the onboarding recap stays stale.
      // Same shared key set the Google connect/disconnect flow uses, so all revoke entry points
      // invalidate the onboarding status consistently.
      for (const queryKey of GOOGLE_CONNECT_SUCCESS_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
      toast("Access revoked", { tone: "drift", icon: <Unlink size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const accounts = accountsQuery.data?.accounts ?? [];

  if (flow === "google") {
    return <GoogleConnect onBack={() => setFlow(null)} />;
  }

  if (flow === "imap") {
    return <ImapConnect onBack={() => setFlow(null)} />;
  }

  return (
    <>
      <PaneHead
        title="Connected accounts"
        desc={`The external accounts ${assistantName} can reach, and how healthy each connection is. You stay in control — reconnect or revoke at any time.`}
      />
      <Group
        title="Accounts"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFlow((f) => (f === "picker" ? null : "picker"))}
            icon={<Plus size={15} />}
          >
            Connect account
          </Button>
        }
      >
        {accounts.length === 0 ? (
          <Row
            name="No accounts connected"
            desc={`Connect Google or another account to give ${assistantName} context.`}
          />
        ) : (
          accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onReconnect={() => setFlow(account.providerType === "google" ? "google" : "imap")}
              onRevoke={() =>
                confirm({
                  title: `Revoke ${account.providerDisplayName} access?`,
                  description: `${assistantName} will lose access to this account until you reconnect it. Nothing on the account itself is changed.`,
                  confirmLabel: "Revoke",
                  danger: true,
                  onConfirm: () => revokeMutation.mutate(account.id)
                })
              }
            />
          ))
        )}
        {flow === "picker" ? (
          <ServicePicker onGoogle={() => setFlow("google")} onImap={() => setFlow("imap")} />
        ) : null}
      </Group>
    </>
  );
}

/* ----------------------------------------------------------- Data sources */

function formatLastSync(at: string | null, lastError?: string): string {
  if (!at) return "Never synced";
  const relative = formatTimestamp(at, at);
  return lastError ? `Last sync failed: ${relative}` : `Last sync: ${relative}`;
}

function SourcesPane() {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const { pendingNotesDelete, openActionRequest } = useChatControls();
  const assistantName = useAssistantName();

  // Notes source (#449): real API calls replace the prior NotWired stub.
  const notesSourceQuery = useQuery({
    queryKey: queryKeys.settings.notesSource,
    queryFn: getNotesSource,
    retry: false
  });
  const putNotesSourceMutation = useMutation({
    mutationFn: (body: PutNotesSourceRequest) => putNotesSource(body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.notesSource, data);
      // Clear the stale last-sync read so it refetches after the next sync.
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.notesLastSync });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  // Self-correcting poll after "Sync now" (#449): the job runs async, so a fixed
  // setTimeout invalidate is wrong (cold/embedding load >2s, fires once, leaks on
  // unmount). Instead, flip a recently-started flag and poll the last-sync read
  // every 2s while it's up. The flag auto-clears after a bounded 30s window; the
  // poll observes the fresh `at` timestamp and the card updates without a remount.
  // refetchInterval reads `recentlySynced` (state) and `syncMutation.isPending`
  // DIRECTLY — both changes trigger a re-render, which is what makes React Query
  // re-evaluate the interval. A ref would be updated in an effect that fires no
  // re-render, so the poll would never start.
  const [recentlySynced, setRecentlySynced] = useState(false);
  // Bumped on every successful "Sync now" so a repeat sync within the 30s window
  // restarts the auto-clear timer. `setRecentlySynced(true)` no-ops when already
  // true (no re-render), so the clear effect must also depend on this counter —
  // otherwise the first timer fires mid-second-sync and cuts the poll short.
  const [syncTick, setSyncTick] = useState(0);
  const syncMutation = useMutation({
    mutationFn: () => postNotesSync(),
    onSuccess: () => {
      toast("Sync started", { icon: <FolderCheck size={17} /> });
      setRecentlySynced(true);
      setSyncTick((tick) => tick + 1);
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const notesLastSyncQuery = useQuery({
    queryKey: queryKeys.settings.notesLastSync,
    queryFn: getNotesLastSync,
    retry: false,
    refetchInterval: () => (syncMutation.isPending || recentlySynced ? 2000 : false),
    refetchIntervalInBackground: false
  });
  // Auto-clear the poll window 30s after the last "Sync now" (cleared on unmount).
  useEffect(() => {
    if (!recentlySynced) return;
    const stop = setTimeout(() => setRecentlySynced(false), 30_000);
    return () => clearTimeout(stop);
  }, [recentlySynced, syncTick]);

  const linkedPath = notesSourceQuery.data?.path ?? null;
  const lastSync = notesLastSyncQuery.data?.lastSync ?? null;
  const [choosing, setChoosing] = useState(false);

  const choose = (folder: string) => {
    putNotesSourceMutation.mutate(
      { path: folder },
      {
        onSuccess: () => {
          setChoosing(false);
          toast(`Linked ${folder}`, { icon: <FolderCheck size={17} /> });
        }
      }
    );
  };
  const unlink = () =>
    confirm({
      title: "Unlink this folder?",
      description: `${assistantName} will stop reading your notes. Your files are untouched.`,
      confirmLabel: "Unlink",
      danger: true,
      onConfirm: () => {
        putNotesSourceMutation.mutate({ path: null });
        toast("Folder unlinked", { tone: "drift", icon: <Unlink size={17} /> });
      }
    });

  if (choosing) {
    return (
      <VaultChooser
        current={linkedPath ?? ""}
        mode="notes"
        onCancel={() => setChoosing(false)}
        onChoose={choose}
      />
    );
  }

  return (
    <>
      <PaneHead
        title="Data sources"
        desc={`Connect a notes folder ${assistantName} can index and use as context.`}
      />

      <Group
        title={
          <span className="src-title">
            <NotebookText size={18} aria-hidden="true" />
            Notes &amp; documents
          </span>
        }
        desc={`Point ${assistantName} at a folder of notes on this server — a Markdown vault, a plain folder of text files, anything. Tool-agnostic by design.`}
      >
        <div className="vault">
          <span className="vault__ic">
            {linkedPath ? (
              <FolderCheck size={18} aria-hidden="true" />
            ) : (
              <FolderOpen size={18} aria-hidden="true" />
            )}
          </span>
          <div className="vault__main">
            {linkedPath ? (
              <>
                <div className="vault__path">{linkedPath}</div>
                <div className="vault__meta">
                  {lastSync
                    ? lastSync.lastError
                      ? formatLastSync(lastSync.at, lastSync.lastError)
                      : `${lastSync.ingested} ingested · ${lastSync.skipped} unchanged · ${lastSync.errors} errors · ${formatLastSync(lastSync.at)}`
                    : "Linked — run Sync now to ingest."}
                </div>
              </>
            ) : (
              <>
                <div className="vault__path vault__path--empty">No folder linked</div>
                <div className="vault__meta">
                  Choose a folder on the server to include your notes as context.
                </div>
              </>
            )}
          </div>
          <div className="vault__act">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setChoosing(true)}
              disabled={putNotesSourceMutation.isPending}
              icon={<FolderSearch size={15} />}
            >
              {linkedPath ? "Change folder" : "Browse…"}
            </Button>
            {linkedPath ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                  icon={<RefreshCw size={15} className={syncMutation.isPending ? "spin" : ""} />}
                >
                  {syncMutation.isPending ? "Syncing…" : "Sync now"}
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={unlink}
                  disabled={putNotesSourceMutation.isPending}
                >
                  Unlink
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </Group>
      <Note icon={<ShieldCheck size={13} />}>
        {assistantName} can create and edit Markdown notes in this folder.{" "}
        {pendingNotesDelete ? (
          <>
            <strong>{pendingNotesDelete.summary}</strong> is awaiting explicit approval before
            deletion.{" "}
            {openActionRequest ? (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => openActionRequest(pendingNotesDelete.actionRequestId)}
              >
                Review deletion
              </Button>
            ) : null}
          </>
        ) : (
          "Deleting a note always asks you in chat before anything is removed."
        )}
      </Note>
    </>
  );
}

/* ------------------------------------------------------------- Modules */

const CONFIG_IDS = new Set(["briefings", "chat", "notifications"]);
const CAT_BY_ID: Record<string, string> = { knowledge: "memory" };
const CONTRIBUTED_SETTINGS_MODULE_IDS = new Set(
  MODULE_SETTINGS_SURFACES.filter((surface) => surface.hasEntry).map((surface) => surface.moduleId)
);
type ModuleSub = "briefings" | "chat" | "notifications";
type ModuleSettingsView = ModuleSub | { readonly moduleId: string };

function hasImplementedModuleSettings(module: SettingsModule): boolean {
  if (CONFIG_IDS.has(module.id)) return true;
  if (CAT_BY_ID[module.id]) return true;
  // #1725: declared switches are a settings destination, so a required module that has them
  // keeps its row (same #986 rule that keeps rows for contributed surfaces below).
  if (module.hasPreferences) return true;
  // #1759: credential slots the user fills are a settings destination in their own right. A
  // module can declare them and no switches at all, and then this is its only reason to have a row.
  if (module.hasUserCredentials) return true;
  return (
    CONTRIBUTED_SETTINGS_MODULE_IDS.has(module.id) &&
    Boolean(findModuleSettingsEntrySurface(module.id, MODULE_SETTINGS_SURFACES))
  );
}

function ModulesPane({ onNavigate, onSelectSection }: PaneProps) {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const assistantName = useAssistantName();
  const [searchParams, setSearchParams] = useSearchParams();
  const myQuery = useQuery({ queryKey: queryKeys.myModules, queryFn: getMyModules, retry: false });
  // #1725: a module that only declares preferences has no contributed React surface, so it
  // needs its own reason to be a valid destination — otherwise the deep link resolves to
  // null and "Configure" lands back on the list.
  // #1759: same rule for user-fillable credentials, so Finance — credentials, no switches —
  // resolves instead of bouncing back to the list.
  const hasOwnSettingsPage = (moduleId: string): boolean =>
    myQuery.data?.modules.some(
      (module) => module.id === moduleId && (module.hasPreferences || module.hasUserCredentials)
    ) === true;
  const view: ModuleSettingsView | null = resolveModuleSettingsDeepLink(
    searchParams.get("module"),
    (moduleId) =>
      Boolean(findModuleSettingsEntrySurface(moduleId, MODULE_SETTINGS_SURFACES)) ||
      hasOwnSettingsPage(moduleId)
  );
  const modulesQuery = useQuery({ queryKey: queryKeys.modules, queryFn: getModules, retry: false });
  const toggleMutation = useMutation({
    mutationFn: (input: { id: string; disabled: boolean }) =>
      setMyModuleDisabled(input.id, input.disabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.myModules }),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const openModule = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("module", id);
    setSearchParams(next);
  };
  const closeModule = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("module");
    setSearchParams(next, { replace: true });
  };

  if (view === "briefings") return <BriefingSettings onBack={closeModule} />;
  if (view === "chat") return <ChatSettingsView onBack={closeModule} onCat={onSelectSection} />;
  if (view === "notifications")
    return (
      <NotificationSettings
        onBack={closeModule}
        onCat={onSelectSection}
        onModuleSettings={openModule}
      />
    );
  if (view && typeof view === "object") {
    // #1725: an in-repo module that contributes its own settings surface keeps it; anything
    // else that got here did so by declaring preferences, which the host renders generically.
    if (!findModuleSettingsEntrySurface(view.moduleId, MODULE_SETTINGS_SURFACES)) {
      const target = myQuery.data?.modules.find((module) => module.id === view.moduleId);
      return (
        <ModulePreferencesSettings
          moduleId={view.moduleId}
          moduleName={target?.name ?? view.moduleId}
          onBack={closeModule}
        />
      );
    }
    return (
      <ModuleSettingsRouter
        moduleId={view.moduleId}
        surfaces={MODULE_SETTINGS_SURFACES}
        components={MODULE_SETTINGS_COMPONENTS}
        onBack={closeModule}
        onSelectSection={onSelectSection}
        onNavigate={onNavigate}
      />
    );
  }

  const modules = visibleConfigurableModules(
    myQuery.data?.modules ?? [],
    hasImplementedModuleSettings
  );
  const pathFor = (id: string): string | null =>
    modulesQuery.data?.modules.find((m) => m.id === id)?.navigation[0]?.path ?? null;

  const renderRow = (module: (typeof modules)[number]) => {
    const Icon = moduleIcon(module.id);
    const control = settingsModuleControlModel(module);
    const locked = control.kind === "locked";
    const available = module.active || control.kind === "required";
    const config = CONFIG_IDS.has(module.id);
    const contributedSettings =
      CONTRIBUTED_SETTINGS_MODULE_IDS.has(module.id) &&
      findModuleSettingsEntrySurface(module.id, MODULE_SETTINGS_SURFACES);
    const cat = CAT_BY_ID[module.id];
    const path = pathFor(module.id);

    const badge = locked ? <Badge tone="neutral">Unavailable</Badge> : null;

    let action: React.ReactNode = null;
    if (locked) {
      action = (
        <span className="modrow__locked">
          <Lock size={13} aria-hidden="true" />
          Off for this instance
        </span>
      );
    } else if (!available) {
      action = <span className="modrow__disabled">Switch on to set up</span>;
    } else if (config) {
      action = (
        <button
          type="button"
          className="modrow__link"
          aria-label={`Configure ${module.name}`}
          onClick={() => openModule(module.id)}
        >
          Configure <ArrowRight size={14} aria-hidden="true" />
        </button>
      );
    } else if (contributedSettings) {
      action = (
        <button
          type="button"
          className="modrow__link"
          aria-label={`Configure ${module.name}`}
          onClick={() => openModule(module.id)}
        >
          Configure <ArrowRight size={14} aria-hidden="true" />
        </button>
      );
    } else if (module.hasPreferences || module.hasUserCredentials) {
      // #1725: an installed module with declared switches gets the same "Configure" link as
      // a built-in one — from the user's side there is no difference worth showing.
      // #1759: user-fillable credentials count the same way.
      action = (
        <button
          type="button"
          className="modrow__link"
          aria-label={`Configure ${module.name}`}
          onClick={() => openModule(module.id)}
        >
          Configure <ArrowRight size={14} aria-hidden="true" />
        </button>
      );
    } else if (cat) {
      action = (
        <button
          type="button"
          className="modrow__link"
          aria-label={`Configure ${module.name}`}
          onClick={() => onSelectSection?.(cat)}
        >
          Configure <ArrowRight size={14} aria-hidden="true" />
        </button>
      );
    } else if (path) {
      action = (
        <button type="button" className="modrow__link" onClick={() => onNavigate(path)}>
          Open <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      );
    }

    return (
      <div className={`modrow${locked ? " modrow--locked" : ""}`} key={module.id}>
        <div className="modrow__ic">
          <Icon size={19} aria-hidden="true" />
        </div>
        <div className="modrow__main">
          <div className="modrow__name">
            {module.name}
            {badge}
          </div>
          <div className="modrow__desc">
            {locked
              ? "An admin has turned this off for the whole instance."
              : moduleDescription(module.id, assistantName)}
          </div>
        </div>
        <div className="modrow__act">
          {control.kind === "toggle" ? (
            <Switch
              ariaLabel={`Use ${module.name}`}
              checked={control.checked}
              onChange={(value) => toggleMutation.mutate({ id: module.id, disabled: !value })}
            />
          ) : null}
          {action}
        </div>
      </div>
    );
  };

  return (
    <>
      <PaneHead title="Modules" desc="Choose which parts of Moss to use and configure." />
      <Group
        title="Available modules"
        desc="Required modules stay available; optional modules can be turned on or off."
      >
        {modules.length ? (
          modules.map(renderRow)
        ) : (
          <Row
            name={myQuery.isLoading ? "Loading modules…" : "No additional modules"}
            desc="Additional modules will appear here when available."
          />
        )}
      </Group>
    </>
  );
}

export { ConnectedPane, SourcesPane, ModulesPane };
