import {
  Brain,
  CalendarDays,
  Download,
  FileArchive,
  FileText,
  Laptop,
  ListChecks,
  LoaderCircle,
  LogOut,
  MapPin,
  MessagesSquare,
  Monitor,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Tablet,
  UserRound,
  type LucideIcon
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  type LocaleSettingsDto,
  type ListMySessionsResponse,
  type MeSessionDeviceKind,
  type MeSessionDto
} from "@moss/shared";

import {
  ApiError,
  listMySessions,
  revokeMyOtherSessions,
  revokeMySession,
  startDataExport,
  getDataExportStatus,
  getDataExportDownloadUrl,
  type ExportJobStatus
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAssistantName } from "../api/use-assistant-name.js";
import { formatDate, useUserLocale } from "../locale/locale-format.js";
import { useFeedback } from "./settings-feedback.js";
import { Badge, Group, Row } from "./settings-ui.js";
import { Button, ButtonLink } from "@moss/ui";

/* ----------------------------------------------------------- Data export */

const INCLUDED: readonly { readonly icon: LucideIcon; readonly name: string }[] = [
  { icon: UserRound, name: "Profile & account" },
  { icon: Brain, name: "Memory — facts, patterns & corrections" },
  { icon: ListChecks, name: "Tasks & commitments" },
  { icon: CalendarDays, name: "Calendar cache" },
  { icon: FileText, name: "Notes & vault index" },
  { icon: MessagesSquare, name: "Conversations" },
  { icon: SlidersHorizontal, name: "Settings & persona" }
];

const EXPORT_JOB_STORAGE_KEY = "moss.settings.export-job-id";

function readStoredExportJobId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(EXPORT_JOB_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredExportJobId(jobId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(EXPORT_JOB_STORAGE_KEY, jobId);
  } catch {
    // Storage may be disabled or unavailable; export state remains usable in-memory only.
  }
}

function clearStoredExportJobId(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(EXPORT_JOB_STORAGE_KEY);
  } catch {
    // Storage may be disabled or unavailable; export state remains usable in-memory only.
  }
}

export function DataExport() {
  const { toast } = useFeedback();
  const assistantName = useAssistantName();
  const [jobId, setJobId] = useState<string | null>(() => readStoredExportJobId());

  const statusQuery = useQuery<ExportJobStatus>({
    queryKey: ["data-export", "status", jobId],
    queryFn: () => getDataExportStatus(jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "building" ? 3000 : false;
    }
  });

  const startMutation = useMutation<ExportJobStatus>({
    mutationFn: startDataExport,
    onSuccess: (data) => {
      writeStoredExportJobId(data.jobId);
      setJobId(data.jobId);
    },
    onError: () => {
      toast("Couldn't start export", { icon: <Download size={17} /> });
    }
  });

  const status = statusQuery.data?.status;
  const isInProgress = status === "pending" || status === "building";
  const isReady = status === "ready";
  const isFailed = status === "failed";

  const reset = () => {
    clearStoredExportJobId();
    setJobId(null);
  };

  useEffect(() => {
    if (status === "expired") {
      reset();
      return;
    }
    const error = statusQuery.error;
    if (error instanceof ApiError && error.status === 404) {
      reset();
    }
  }, [status, statusQuery.error]);

  return (
    <Group
      title="Your data"
      desc={`Everything ${assistantName} holds about you, packaged as a portable archive you can keep or take elsewhere.`}
    >
      {!jobId || isFailed ? (
        <>
          <div className="dexp__inc">
            {INCLUDED.map((i) => {
              const Icon = i.icon;
              return (
                <div className="dexp__chip" key={i.name}>
                  <Icon size={14} aria-hidden="true" />
                  {i.name}
                </div>
              );
            })}
          </div>
          {isFailed ? (
            <div className="dexp__bar">
              <div className="dexp__note">Export failed. Please try again.</div>
              <Button
                size="sm"
                onClick={() => {
                  reset();
                  startMutation.mutate(undefined);
                }}
                disabled={startMutation.isPending}
                icon={<Download size={15} />}
              >
                Try again
              </Button>
            </div>
          ) : (
            <div className="dexp__bar">
              <div className="dexp__note">
                <FileArchive size={13} aria-hidden="true" />A single archive — structured JSON plus
                your original note files. Yours, in an open format.
              </div>
              <Button
                size="sm"
                onClick={() => startMutation.mutate(undefined)}
                disabled={startMutation.isPending}
                icon={<Download size={15} />}
              >
                Prepare export
              </Button>
            </div>
          )}
        </>
      ) : null}

      {isInProgress ? (
        <div className="dexp__job">
          <div className="dexp__jobhd">
            <span className="dexp__spin">
              <LoaderCircle size={16} aria-hidden="true" />
            </span>
            <div className="dexp__jobmain">
              <div className="dexp__jobt">
                {status === "pending" ? "Queued…" : "Building your archive…"}
              </div>
              <div className="dexp__jobd">
                Gathering your data into a portable archive — you can leave this page.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {isReady ? (
        <div className="dexp__bar">
          <div className="dexp__note">
            <ShieldCheck size={13} aria-hidden="true" />
            Your archive is ready. It was built on this server and never left it until you download
            it.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <ButtonLink
              href={getDataExportDownloadUrl(jobId!)}
              variant="primary"
              size="sm"
              icon={<Download size={15} />}
              download
            >
              Download
            </ButtonLink>
            <Button variant="quiet" size="sm" onClick={reset}>
              Prepare a new export
            </Button>
          </div>
        </div>
      ) : null}
    </Group>
  );
}

/* ----------------------------------------------------------- Active sessions */

const KIND_ICON: Record<MeSessionDeviceKind, LucideIcon> = {
  laptop: Laptop,
  phone: Smartphone,
  tablet: Tablet,
  desktop: Monitor
};

function metaLine(s: MeSessionDto): string {
  return [s.browser, s.os].filter(Boolean).join(" · ") || "Unknown browser";
}

function formatLastSeen(iso: string, locale: LocaleSettingsDto): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Unknown";
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Active now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso, locale);
}

/**
 * A group of sessions that look identical in the UI (same device label, browser, OS,
 * and IP). There is no stable device id in `better_auth_sessions`, so grouping is a
 * frontend-only display concern — every id in `ids` is still a real, individually
 * revocable session (#handoff 2026-07-04).
 */
export interface SessionGroup {
  readonly key: string;
  readonly ids: readonly string[];
  readonly display: MeSessionDto;
  readonly isCurrent: boolean;
  readonly lastSeenAt: string;
  readonly count: number;
}

export function groupSessions(sessions: readonly MeSessionDto[]): SessionGroup[] {
  const order: string[] = [];
  const groups = new Map<string, MeSessionDto[]>();
  for (const s of sessions) {
    const key = `${s.deviceLabel}|${s.browser ?? ""}|${s.os ?? ""}|${s.ipAddress ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(s);
    } else {
      groups.set(key, [s]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const members = groups.get(key)!;
    const current = members.find((s) => s.isCurrent);
    const mostRecent = members.reduce((a, b) =>
      new Date(b.lastSeenAt).getTime() > new Date(a.lastSeenAt).getTime() ? b : a
    );
    const display = current ?? mostRecent;
    return {
      key,
      ids: members.map((s) => s.id),
      display,
      isCurrent: current !== undefined,
      lastSeenAt: display.lastSeenAt,
      count: members.length
    };
  });
}

export function Sessions() {
  const { toast, confirm } = useFeedback();
  const locale = useUserLocale();
  const queryClient = useQueryClient();
  const assistantName = useAssistantName();
  const sessionsQuery = useQuery<ListMySessionsResponse>({
    queryKey: queryKeys.settings.sessions,
    queryFn: listMySessions
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const others = sessions.filter((s) => !s.isCurrent);
  const groups = groupSessions(sessions);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.sessions });

  const revokeOne = useMutation({
    mutationFn: (ids: readonly string[]) => Promise.all(ids.map((id) => revokeMySession(id))),
    onSuccess: (_data, ids) => {
      void refresh();
      toast(ids.length > 1 ? "Signed out devices" : "Signed out device", {
        tone: "drift",
        icon: <LogOut size={17} />
      });
    },
    onError: () => toast("Couldn't sign out that device", { icon: <LogOut size={17} /> })
  });
  const revokeAllOthers = useMutation({
    mutationFn: () => revokeMyOtherSessions(),
    onSuccess: (data) => {
      void refresh();
      toast(`Signed out ${data.count} device${data.count === 1 ? "" : "s"}`, {
        tone: "drift",
        icon: <LogOut size={17} />
      });
    },
    onError: () => toast("Couldn't sign out other devices", { icon: <LogOut size={17} /> })
  });

  // Confirm callbacks call mutate() directly — never inside a setState updater, which would
  // double-fire the destructive action under StrictMode.
  const revoke = (group: SessionGroup) =>
    confirm({
      title: `Sign out ${group.display.deviceLabel}?`,
      description:
        group.count > 1
          ? `Those devices will need to sign in again to reach ${assistantName}. Anyone using them right now is signed out immediately.`
          : `That device will need to sign in again to reach ${assistantName}. Anyone using it right now is signed out immediately.`,
      confirmLabel: group.count > 1 ? `Sign out ${group.count} sessions` : "Sign out device",
      danger: true,
      onConfirm: () => revokeOne.mutate(group.ids)
    });
  const revokeAll = () =>
    confirm({
      title: "Sign out all other devices?",
      description:
        "Every device except this one is signed out immediately. You stay signed in here.",
      confirmLabel: `Sign out ${others.length} device${others.length === 1 ? "" : "s"}`,
      danger: true,
      onConfirm: () => revokeAllOthers.mutate()
    });

  const busy = revokeOne.isPending || revokeAllOthers.isPending;

  return (
    <Group
      title="Active sessions"
      desc="Devices signed in to your account. Sign out any you don't recognise."
      action={
        others.length ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={revokeAll}
            disabled={busy}
            icon={<LogOut size={15} />}
          >
            Sign out all others
          </Button>
        ) : undefined
      }
    >
      <div className="sess">
        {sessionsQuery.isLoading ? (
          <Row name="Loading sessions…" desc="Fetching the devices signed in to your account." />
        ) : null}
        {sessionsQuery.isError ? (
          <Row
            name="Couldn't load sessions"
            desc="Something went wrong fetching your active sessions. Try again shortly."
          />
        ) : null}
        {!sessionsQuery.isLoading && !sessionsQuery.isError && sessions.length === 0 ? (
          <Row name="No active sessions" desc="There are no signed-in devices to show." />
        ) : null}
        {groups.map((group) => {
          const s = group.display;
          const Icon = KIND_ICON[s.deviceKind];
          return (
            <div className="sess__row" key={group.key}>
              <div className="sess__ic">
                <Icon size={19} aria-hidden="true" />
              </div>
              <div className="sess__main">
                <div className="sess__dev">
                  {s.deviceLabel}
                  {group.isCurrent ? (
                    <Badge tone="forest" dot>
                      This device
                    </Badge>
                  ) : null}
                  {group.count > 1 ? <Badge tone="neutral">{group.count} sessions</Badge> : null}
                </div>
                <div className="sess__meta">{metaLine(s)}</div>
                {s.ipAddress ? (
                  <div className="sess__where">
                    <MapPin size={12} aria-hidden="true" />
                    {s.ipAddress}
                  </div>
                ) : null}
              </div>
              <div className="sess__act">
                <div className={`sess__last${group.isCurrent ? " sess__last--now" : ""}`}>
                  {formatLastSeen(group.lastSeenAt, locale)}
                </div>
                {group.isCurrent ? (
                  <span className="sess__you">Current session</span>
                ) : (
                  <button
                    type="button"
                    className="sess__revoke"
                    onClick={() => revoke(group)}
                    disabled={busy}
                  >
                    <LogOut size={14} aria-hidden="true" />
                    Sign out
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Group>
  );
}
