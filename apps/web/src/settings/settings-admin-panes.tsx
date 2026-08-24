import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { compareMossVersions } from "@moss/module-sdk/core-version";
import {
  KeyRound,
  LogOut,
  MoreHorizontal,
  ServerCog,
  ShieldCheck,
  Stethoscope,
  Terminal,
  Trash2,
  UserCheck,
  UserMinus
} from "lucide-react";
import { useRef, useState } from "react";

import {
  approveUser,
  deactivateUser,
  deleteAdminUser,
  demoteUser,
  getChatMultiplexerSettings,
  getHostDiagnostics,
  getRegistrationSettings,
  getHostRestartStatus,
  installHerdr,
  requestHostRestart,
  listAdminConnectorAccounts,
  listAdminUsers,
  promoteUser,
  putRegistrationSettings,
  reactivateUser,
  revokeAdminUserSessions,
  rejectUser,
  setChatMultiplexerSettings
} from "../api/client";
import { getAdminUserAiPin, putAdminUserAiPin } from "../api/client-admin";
import { queryKeys } from "../api/query-keys";
import { useDismissableMenu } from "../shared/use-dismissable-menu.js";
import {
  adminUserActions,
  createAdminUserPolicyContext,
  type AdminUserAction
} from "./settings-admin-policy";
import { getConnectorAccountHealth } from "./settings-connector-sync";
import { useFeedback } from "./settings-feedback";
import { readError, type PaneProps } from "./settings-types";
import { MarkdownMessage } from "../chat/markdown-message";
import {
  Avatar,
  Badge,
  formatTimestamp,
  Group,
  Indicator,
  Note,
  PaneHead,
  Row,
  Segmented,
  Select,
  Switch,
  type BadgeTone
} from "./settings-ui";
import { Button, IconButton } from "@moss/ui";
import {
  describeHerdrInstallOutcome,
  healthSummary,
  orderChecksBySeverity
} from "./host-health-summary";
import type {
  ChatMultiplexerChoice,
  HostDiagnosticStatus,
  PutAiAdminUserPinRequest,
  RegistrationSettingsDto,
  UserDto
} from "@moss/shared";

function roleLabel(user: UserDto): string {
  return user.isBootstrapOwner ? "Owner" : user.isInstanceAdmin ? "Admin" : "Member";
}

function diagnosticTone(status: HostDiagnosticStatus): BadgeTone {
  return status === "pass" ? "forest" : status === "warn" ? "amber" : "red";
}

function diagnosticLabel(status: HostDiagnosticStatus): string {
  return status === "pass" ? "Pass" : status === "warn" ? "Warn" : "Fail";
}

function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

/* --------------------------------------------------------- People & access */

function PersonRow(props: {
  readonly user: UserDto;
  readonly isCurrent: boolean;
  readonly actions: readonly AdminUserAction[];
  readonly onAction: (action: AdminUserAction, user: UserDto) => void;
}) {
  const { user } = props;
  const [menu, setMenu] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const off = user.status === "deactivated";
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setMenu(false);
    menuTriggerRef.current?.focus();
  };
  const { ref: menuRef } = useDismissableMenu<HTMLDivElement>({
    open: menu,
    onClose: closeMenu
  });
  const act = (action: AdminUserAction) => {
    closeMenu();
    props.onAction(action, user);
  };
  const canAdmin = props.actions.includes("admin");
  const statusAction = props.actions.find(
    (action) => action === "deactivate" || action === "reactivate"
  );
  const canRevokeSessions = props.actions.includes("revokeSessions");
  const canRemove = props.actions.includes("remove");
  const rowLabel = props.isCurrent ? "You" : props.actions.length === 0 ? "Protected" : null;
  return (
    <div className={`ppl__row${off ? " ppl__row--off" : ""}`}>
      <div className="ppl__id">
        <Avatar name={user.name || user.email} size="sm" />
        <div className="ppl__idmain">
          <div className="ppl__name">
            {user.name || "Unnamed"}
            {rowLabel ? <span className="ppl__you">{rowLabel}</span> : null}
          </div>
          <div className="ppl__email">{user.email}</div>
        </div>
      </div>
      <div className="ppl__role">{roleLabel(user)}</div>
      <div className="ppl__status">
        {off ? (
          <Badge tone="neutral" dot>
            Deactivated
          </Badge>
        ) : (
          <Badge tone="forest" dot>
            Active
          </Badge>
        )}
      </div>
      <div className="ppl__actions">
        {props.actions.length === 0 ? null : (
          <div className="ppl__menu" ref={menuRef}>
            <IconButton
              ref={menuTriggerRef}
              size="sm"
              aria-label={`Actions for ${user.name || user.email}`}
              aria-expanded={menu}
              onClick={() => (menu ? closeMenu() : setMenu(true))}
            >
              <MoreHorizontal size={16} />
            </IconButton>
            {menu ? (
              <div className="ppl__menupop" role="menu">
                {canAdmin ? (
                  <button className="ppl__menuitem" role="menuitem" onClick={() => act("admin")}>
                    <ShieldCheck size={15} />
                    {user.isInstanceAdmin ? "Revoke admin" : "Make admin"}
                  </button>
                ) : null}
                {statusAction ? (
                  <button
                    className="ppl__menuitem"
                    role="menuitem"
                    onClick={() => act(statusAction)}
                  >
                    {off ? <UserCheck size={15} /> : <UserMinus size={15} />}
                    {off ? "Reactivate" : "Deactivate"}
                  </button>
                ) : null}
                <button
                  className="ppl__menuitem"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    setAiOpen((open) => !open);
                  }}
                >
                  <ServerCog size={15} />
                  AI provider
                </button>
                {canRevokeSessions || canRemove ? <div className="ppl__menusep" /> : null}
                {canRevokeSessions ? (
                  <button
                    className="ppl__menuitem ppl__menuitem--danger"
                    role="menuitem"
                    onClick={() => act("revokeSessions")}
                  >
                    <LogOut size={15} />
                    Sign out everywhere
                  </button>
                ) : null}
                {canRemove ? (
                  <button
                    className="ppl__menuitem ppl__menuitem--danger"
                    role="menuitem"
                    onClick={() => act("remove")}
                  >
                    <Trash2 size={15} />
                    Remove from instance
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {aiOpen ? <AiPinRow user={user} /> : null}
    </div>
  );
}

function AiPinRow(props: { readonly user: UserDto }) {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const queryKey = queryKeys.ai.adminUserAiPin(props.user.id);
  const pinQuery = useQuery({
    queryKey,
    queryFn: () => getAdminUserAiPin(props.user.id),
    retry: false
  });
  // #870/M4a Slice 1: an admin can pin this user to either a PROVIDER (hard-locks ALL their
  // traffic — chat, voice, workers — to that provider; no capable model => visible needs-config,
  // no cross-provider escape) OR a specific MODEL (exact model for chat/voice, workers routed
  // inside that model's provider). The two are mutually exclusive; the backend clears the sibling
  // pin, so the UI just sends whichever was chosen (or clears both).
  const mutation = useMutation({
    mutationFn: (input: PutAiAdminUserPinRequest) => putAdminUserAiPin(props.user.id, input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      const label =
        data.pin.pinnedModelId || data.pin.pinnedProviderId ? "AI pin updated" : "AI pin cleared";
      toast(label, { icon: <ServerCog size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const pin = pinQuery.data?.pin;
  const models = pin?.availableModels ?? [];
  const providers = pin?.availableProviders ?? [];
  // Encode the current pin into the single <select> value: `provider:<id>`, `model:<id>`, or "".
  const value = pin?.pinnedProviderId
    ? `provider:${pin.pinnedProviderId}`
    : pin?.pinnedModelId
      ? `model:${pin.pinnedModelId}`
      : "";
  const busy = pinQuery.isLoading || mutation.isPending;
  const disabled = busy || (models.length === 0 && providers.length === 0);
  const effective = pin?.effectiveChatModel
    ? `${pin.effectiveChatModel.displayName} (${pin.effectiveChatReason})`
    : "No active model";

  const onChange = (raw: string) => {
    if (raw.startsWith("provider:")) {
      mutation.mutate({ providerId: raw.slice("provider:".length) });
    } else if (raw.startsWith("model:")) {
      mutation.mutate({ modelId: raw.slice("model:".length) });
    } else {
      // Clear both pins — send an empty request; the backend treats absent ids as "clear".
      mutation.mutate({});
    }
  };

  return (
    <div className="ppl__ai">
      <Row
        name="AI pin"
        desc={
          models.length || providers.length
            ? `Effective chat model: ${effective}. A provider pin locks all of this user's AI to that provider; a model pin forces the exact model.`
            : "No active providers or models available to pin for this user."
        }
        control={
          <Select
            aria-label={`AI pin for ${props.user.name || props.user.email}`}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
          >
            <option value="">No pin (follow instance routing)</option>
            {providers.length ? (
              <optgroup label="Pin a provider (locks all AI to it)">
                {providers.map((provider) => (
                  <option key={provider.id} value={`provider:${provider.id}`}>
                    {provider.displayName}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {models.length ? (
              <optgroup label="Pin a specific model">
                {models.map((model) => (
                  <option key={model.id} value={`model:${model.id}`}>
                    {model.displayName}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        }
      />
    </div>
  );
}

function PendingRow(props: {
  readonly user: UserDto;
  readonly onApprove: () => void;
  readonly onDecline: () => void;
}) {
  return (
    <div className="pend">
      <div className="pend__main">
        <div className="pend__name">{props.user.name || "Unnamed"}</div>
        <div className="pend__sub">
          <span className="em">{props.user.email}</span>
        </div>
      </div>
      <div className="pend__actions">
        <Button size="sm" onClick={props.onApprove}>
          Approve
        </Button>
        <Button variant="quiet" size="sm" onClick={props.onDecline}>
          Decline
        </Button>
      </div>
    </div>
  );
}

interface ActionVars {
  readonly fn: (id: string) => Promise<unknown>;
  readonly id: string;
  readonly message: string | ((data: unknown) => string);
  readonly tone?: "ready" | "drift";
  readonly refetchUsers?: boolean;
}

export function PeoplePane({ me }: PaneProps) {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const regQuery = useQuery({
    queryKey: queryKeys.settings.registrationSettings,
    queryFn: getRegistrationSettings,
    retry: false
  });
  const putMutation = useMutation({
    mutationFn: (next: RegistrationSettingsDto) => putRegistrationSettings(next),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.settings.registrationSettings, data),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const usersQuery = useQuery({
    queryKey: queryKeys.settings.adminUsers,
    queryFn: listAdminUsers,
    retry: false
  });
  const actionMutation = useMutation({
    mutationFn: (vars: ActionVars) => vars.fn(vars.id),
    onSuccess: (data, vars) => {
      if (vars.refetchUsers ?? true) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.adminUsers });
      }
      toast(typeof vars.message === "function" ? vars.message(data) : vars.message, {
        tone: vars.tone
      });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const onAction = (action: AdminUserAction, user: UserDto) => {
    const name = user.name || user.email;
    if (action === "admin") {
      actionMutation.mutate({
        fn: user.isInstanceAdmin ? demoteUser : promoteUser,
        id: user.id,
        message: user.isInstanceAdmin ? `${name} is no longer an admin` : `${name} is now an admin`
      });
    } else if (action === "reactivate") {
      actionMutation.mutate({ fn: reactivateUser, id: user.id, message: `Reactivated ${name}` });
    } else if (action === "deactivate") {
      confirm({
        title: `Deactivate ${name}?`,
        description:
          "They keep their history but are signed out everywhere and lose access until reactivated.",
        confirmLabel: "Deactivate",
        danger: true,
        onConfirm: () =>
          actionMutation.mutate({
            fn: deactivateUser,
            id: user.id,
            message: `${name} deactivated`,
            tone: "drift"
          })
      });
    } else if (action === "revokeSessions") {
      confirm({
        title: `Sign out ${name} everywhere?`,
        description:
          "This ends their active sessions without changing their role, status, or history.",
        confirmLabel: "Sign out everywhere",
        danger: true,
        onConfirm: () =>
          actionMutation.mutate({
            fn: revokeAdminUserSessions,
            id: user.id,
            message: (data) => {
              const count = (data as { count: number }).count;
              return `${name} signed out everywhere (${count} session${count === 1 ? "" : "s"} revoked)`;
            },
            tone: "drift",
            refetchUsers: false
          })
      });
    } else {
      confirm({
        title: `Remove ${name}?`,
        description:
          "This permanently removes their account and access from this instance. It can't be undone.",
        confirmLabel: "Remove",
        danger: true,
        onConfirm: () =>
          actionMutation.mutate({
            fn: deleteAdminUser,
            id: user.id,
            message: `${name} removed from the instance`,
            tone: "drift"
          })
      });
    }
  };

  const users = usersQuery.data?.users ?? [];
  const pending = users.filter((user) => user.status === "pending");
  const members = users.filter((user) => user.status !== "pending");
  const policy = createAdminUserPolicyContext(members);
  const reg = regQuery.data;

  return (
    <>
      <PaneHead
        title="People & access"
        desc="Everyone with access to this instance — their role, their status, and what they can reach."
      />
      <Group title="Registration">
        <Row
          name="Allow new registrations"
          desc="Let people create accounts on this instance."
          control={
            <Switch
              ariaLabel="Allow new registrations"
              checked={reg?.registrationEnabled ?? false}
              onChange={(value) =>
                reg && putMutation.mutate({ ...reg, registrationEnabled: value })
              }
            />
          }
        />
        <Row
          name="Require approval"
          desc="New sign-ups wait in a queue until an admin lets them in."
          control={
            <Switch
              ariaLabel="Require approval"
              checked={reg?.requiresApproval ?? true}
              onChange={(value) => reg && putMutation.mutate({ ...reg, requiresApproval: value })}
            />
          }
        />
      </Group>
      {pending.length ? (
        <Group title="Pending approval" desc="New sign-ups waiting for you to let them in.">
          {pending.map((user) => (
            <PendingRow
              key={user.id}
              user={user}
              onApprove={() =>
                actionMutation.mutate({
                  fn: approveUser,
                  id: user.id,
                  message: `Approved ${user.name || user.email}`
                })
              }
              onDecline={() =>
                actionMutation.mutate({
                  fn: rejectUser,
                  id: user.id,
                  message: `Declined ${user.name || user.email}`,
                  tone: "drift"
                })
              }
            />
          ))}
        </Group>
      ) : null}
      <Group title="Members" desc="New people create an account, then wait for approval here.">
        <div className="ppl">
          {members.length ? (
            members.map((user) => (
              <PersonRow
                key={user.id}
                user={user}
                isCurrent={user.id === me.user.id}
                actions={adminUserActions(user, me.user, policy)}
                onAction={onAction}
              />
            ))
          ) : (
            <Row name={usersQuery.isLoading ? "Loading people…" : "No members"} />
          )}
        </div>
      </Group>
      <Note icon={<KeyRound size={13} />}>
        Deactivating someone keeps their history but ends all their sessions immediately.
      </Note>
    </>
  );
}

/* ----------------------------------------------------------- Instance modules */

// #996/#860: a module downloaded via the registry (Task 12/13) is BOTH a registry row
// (installed-enabled/installed-disabled) AND a discovered external module (#917's
// scan of the modules dir) — before this, it rendered in BOTH the "External modules"
// group AND the "Available modules" registry list. Filter the external group down to
// modules the registry index doesn't know about (declared-not-present / truly
// local-only modules never published to the registry).
/* Audit & operations now lives in ./settings-audit-pane (AuditPane) — it gained
   filters, category tags and CSV export against the AdminAuditEventDto shape. */

/* ---------------------------------------------------------- Connector oversight */

export function OversightPane() {
  const accountsQuery = useQuery({
    queryKey: queryKeys.settings.adminConnectorAccounts,
    queryFn: listAdminConnectorAccounts,
    retry: false
  });
  const accounts = accountsQuery.data?.accounts ?? [];
  return (
    <>
      <PaneHead
        title="Connector oversight"
        desc="Connection health across the instance, safe metadata only. No private synced data, no secrets."
      />
      <Group title="Connectors">
        <div className="cono">
          {accounts.length ? (
            accounts.map((account) => {
              // Health now derives from durable sync outcome, not just `status`. Revoked wins;
              // a partial run shows "Partial"; a failed run or an error status needs attention;
              // otherwise healthy. The bounded error label shows only for partial/failed.
              const health = getConnectorAccountHealth(account);
              const lastFinished = account.lastSyncFinishedAt
                ? formatTimestamp(account.lastSyncFinishedAt, account.lastSyncFinishedAt)
                : null;
              const errorLabel =
                (account.lastSyncStatus === "partial" || account.lastSyncStatus === "failed") &&
                account.lastSyncError
                  ? account.lastSyncError
                  : null;
              return (
                <div className="cono__row" key={account.id}>
                  <div className="cono__name">
                    <Indicator status={health.indicator} /> {account.providerDisplayName}
                  </div>
                  <div className="cono__meta">
                    {account.providerType}
                    {lastFinished ? ` · Fallback cache updated ${lastFinished}` : ""}
                    {errorLabel ? ` · ${errorLabel}` : ""}
                  </div>
                  <div className="cono__err">
                    <Badge tone={health.badgeTone} dot={health.badgeTone !== "amber"}>
                      {health.label}
                    </Badge>
                  </div>
                </div>
              );
            })
          ) : (
            <Row
              name={accountsQuery.isLoading ? "Loading connectors…" : "No connectors"}
              desc="Connection health appears here once accounts are connected."
            />
          )}
        </div>
      </Group>
    </>
  );
}

/* --------------------------------------------------------- Advanced host setup */

export function HostPane() {
  const { toast } = useFeedback();
  const queryClient = useQueryClient();
  const [ranDiagnostics, setRanDiagnostics] = useState(false);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const muxQuery = useQuery({
    queryKey: queryKeys.settings.chatMultiplexer,
    queryFn: getChatMultiplexerSettings,
    retry: false
  });
  const diagQuery = useQuery({
    queryKey: queryKeys.settings.hostDiagnostics,
    queryFn: getHostDiagnostics,
    enabled: ranDiagnostics,
    retry: false
  });
  const muxMutation = useMutation({
    mutationFn: (choice: ChatMultiplexerChoice) => setChatMultiplexerSettings(choice),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.settings.chatMultiplexer, data),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const installMutation = useMutation({
    mutationFn: () => installHerdr(),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.chatMultiplexer });
      // #1088 F3: the route resolves 200 even when the install itself failed or timed
      // out (state is installed|failed|timeout — see host-install-routes.ts), so
      // onSuccess firing here is NOT proof the install worked. Surface the real
      // outcome instead of silently going quiet on a failed/timed-out install.
      const outcome = describeHerdrInstallOutcome(data);
      toast(outcome.message, { tone: outcome.tone });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  // #1748 admin "Restart app". Two-click confirm rather than a dialog: this drops every
  // open session including the one pressing it, so it needs a deliberate second action,
  // and the codebase has no shared confirm dialog to reach for.
  const restartQuery = useQuery({
    queryKey: queryKeys.settings.hostRestart,
    queryFn: getHostRestartStatus,
    retry: false
  });
  const restartMutation = useMutation({
    mutationFn: () => requestHostRestart(),
    onSuccess: (data) => {
      setConfirmingRestart(false);
      if (data.accepted) {
        // The server is about to go away, so this toast is the last thing this page
        // renders from a live connection. Say what happens next, not "success".
        toast("Restarting — this page will reconnect in about 20 seconds.", { tone: "ready" });
        return;
      }
      toast("Nothing is set up on the host to perform the restart, so nothing happened.", {
        tone: "drift"
      });
      void restartQuery.refetch();
    },
    onError: (error) => {
      setConfirmingRestart(false);
      toast(readError(error), { tone: "drift" });
    }
  });

  const runDiagnostics = () => {
    setRanDiagnostics(true);
    void diagQuery.refetch();
  };

  const mux = muxQuery.data;
  const diag = diagQuery.data;
  const herdrAvailable = mux?.available.herdr === true;
  const herdrDesc = herdrAvailable
    ? "Herdr is usable on this host."
    : "Herdr is not usable on this host.";

  function attachHintNote() {
    if (!mux) return null;
    if (mux.envOverride !== null) {
      return (
        <Note icon={<Terminal size={13} aria-hidden="true" />}>
          The <code>JARVIS_MULTIPLEXER</code> environment variable pins this host to{" "}
          <strong>{mux.envOverride}</strong>, overriding the setting above. From your deployment
          directory, use{" "}
          {mux.envOverride === "herdr" ? (
            <>
              <code>{"herdr pane list"}</code> and <code>{"herdr pane attach <pane-id>"}</code>
            </>
          ) : (
            <>
              <code>{"docker compose exec jarv1s tmux ls"}</code> and{" "}
              <code>{"docker compose exec jarv1s tmux attach -t jarv1s-live-<thread>"}</code>
            </>
          )}
          .
        </Note>
      );
    }
    // Primary note reflects what's actually active. "herdr installed but broken" is NOT
    // mutually exclusive with an active mux, so it's appended separately below — otherwise a
    // working tmux host with a half-installed herdr would hide the tmux attach command the
    // operator actually needs.
    const primaryNote =
      mux.active === "herdr" ? (
        <Note icon={<Terminal size={13} aria-hidden="true" />}>
          Prefer the terminal? Chat sessions run in Herdr on this host. List panes with{" "}
          <code>{"herdr pane list"}</code>, attach with <code>{"herdr pane attach <pane-id>"}</code>
          , or read output non-interactively with <code>{"herdr pane read <pane-id>"}</code>.
        </Note>
      ) : mux.active === "tmux" ? (
        <Note icon={<Terminal size={13} aria-hidden="true" />}>
          Prefer the terminal? Chat sessions run in tmux inside the container. From your deployment
          directory, list them with <code>{"docker compose exec jarv1s tmux ls"}</code>, then attach
          with <code>{"docker compose exec jarv1s tmux attach -t jarv1s-live-<thread>"}</code>.
        </Note>
      ) : (
        // active === null: nothing is usable. Don't hand out tmux commands that would fail.
        <Note icon={<Terminal size={13} aria-hidden="true" />}>
          No chat multiplexer is usable on this host yet. Install or configure tmux or Herdr, then
          refresh this page.
        </Note>
      );

    const herdrBrokenNote =
      mux.herdrInstalled && !mux.available.herdr && mux.active !== "herdr" ? (
        <Note icon={<Terminal size={13} aria-hidden="true" />}>
          Herdr is installed but has no root pane available, so it isn&apos;t usable yet. Set{" "}
          <code>JARVIS_HERDR_ROOT_PANE</code> (or run the API inside a Herdr pane so{" "}
          <code>HERDR_PANE_ID</code> is set), then restart.
        </Note>
      ) : null;

    return (
      <>
        {primaryNote}
        {herdrBrokenNote}
      </>
    );
  }

  function installHerdrRow() {
    if (!mux || mux.herdrInstalled) return null;
    return (
      <Row
        name="Herdr"
        desc="Not installed on this host."
        control={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => installMutation.mutate()}
            disabled={installMutation.isPending}
          >
            {installMutation.isPending ? "Installing…" : "Install Herdr"}
          </Button>
        }
      />
    );
  }

  return (
    <>
      <PaneHead
        title="Advanced host setup"
        desc="Low-level operational controls. Some changes here take effect only after a server restart."
      />
      <Group title="Runtime">
        <Row
          name="Session multiplexer"
          desc="The backend that hosts your chat sessions."
          control={
            <Segmented<ChatMultiplexerChoice>
              value={mux?.multiplexer ?? "auto"}
              options={[
                { value: "auto", label: "Auto" },
                { value: "tmux", label: "tmux" },
                { value: "herdr", label: "herdr" }
              ]}
              ariaLabel="Session multiplexer"
              onChange={(value) => muxMutation.mutate(value)}
            />
          }
        />
        <Row
          name="tmux available"
          desc="Whether tmux is usable on this host."
          control={
            <Badge tone={mux?.available.tmux ? "forest" : "neutral"} dot={mux?.available.tmux}>
              {mux?.available.tmux ? "Yes" : "No"}
            </Badge>
          }
        />
        <Row
          name="herdr available"
          desc={herdrDesc}
          control={
            <Badge tone={herdrAvailable ? "forest" : "neutral"} dot={herdrAvailable}>
              {herdrAvailable ? "Yes" : "No"}
            </Badge>
          }
        />
        {attachHintNote()}
        {installHerdrRow()}
      </Group>
      <Group
        title="Restart"
        desc="Restarts the app so it picks up new settings or modules. Takes about 20 seconds. Your data is not touched."
      >
        {restartQuery.data?.hostWatcherInstalled === false ? (
          <Row
            name="Restart app"
            desc="Not available: the host has no restart helper installed. Run infra/host/install-restart-unit.sh on the server once to enable this."
            control={
              <Button variant="secondary" size="sm" disabled>
                Restart app
              </Button>
            }
          />
        ) : (
          <Row
            name="Restart app"
            desc={
              confirmingRestart
                ? "This signs everyone out for about 20 seconds, including you."
                : "Ends every open session, then brings the app straight back."
            }
            control={
              <Button
                variant={confirmingRestart ? "primary" : "secondary"}
                size="sm"
                onClick={() =>
                  confirmingRestart ? restartMutation.mutate() : setConfirmingRestart(true)
                }
                disabled={restartMutation.isPending || restartQuery.isLoading}
              >
                {restartMutation.isPending
                  ? "Restarting…"
                  : confirmingRestart
                    ? "Confirm restart"
                    : "Restart app"}
              </Button>
            }
          />
        )}
      </Group>
      <Group
        title="Check system health"
        desc="A safe, read-only health check of this host. No secrets, env values, or paths."
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={runDiagnostics}
            disabled={diagQuery.isFetching}
            icon={<Stethoscope size={15} />}
          >
            {diagQuery.isFetching ? "Checking…" : "Check system health"}
          </Button>
        }
      >
        {!ranDiagnostics ? (
          <Row name="Not run yet" desc="Check system health to check this host." />
        ) : diagQuery.isError ? (
          <Row name="Couldn't check system health" desc={readError(diagQuery.error)} />
        ) : !diag ? (
          <Row name="Checking system health…" />
        ) : (
          <>
            <Row
              name="Status"
              control={
                <Badge tone={healthSummary(diag.checks).tone}>
                  {healthSummary(diag.checks).label}
                </Badge>
              }
            />
            {orderChecksBySeverity(diag.checks).map((check) => (
              <Row
                key={check.id}
                name={check.label}
                desc={check.detail}
                control={
                  <Badge tone={diagnosticTone(check.status)} dot={check.status === "pass"}>
                    {diagnosticLabel(check.status)}
                  </Badge>
                }
              />
            ))}
            <details className="set-technical-details">
              <summary>Technical details</summary>
              <Row name="Uptime" control={formatUptime(diag.uptimeSeconds)} />
              <Row name="Environment" control={diag.environment} />
              <Row
                name="Version"
                control={
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {diag.version ?? "—"}
                    {diag.latestAvailableVersion &&
                      compareMossVersions(diag.latestAvailableVersion, diag.version ?? "") > 0 && (
                        <Badge tone="forest">
                          Update Available ({diag.latestAvailableVersion})
                        </Badge>
                      )}
                  </div>
                }
              />
              {diag.releaseNotes ? (
                <Row
                  name="Release notes"
                  desc={
                    <div className="set-release-notes">
                      <MarkdownMessage text={diag.releaseNotes} />
                    </div>
                  }
                />
              ) : null}
              <Row name="Commit" control={diag.commit ?? "—"} />
              <Row name="Bind address" control={`${diag.host}:${diag.port}`} />
              <Row name="Log level" control={<Badge tone="neutral">{diag.logLevel}</Badge>} />
            </details>
          </>
        )}
      </Group>
    </>
  );
}
