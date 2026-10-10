import { useQuery } from "@tanstack/react-query";
import { Download, Search, SearchX } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@moss/ui";
import { listAdminAuditEvents, listAdminUsers } from "../api/client";
import { queryKeys } from "../api/query-keys";
import {
  auditCategory,
  auditCsv,
  auditPhrase,
  auditWhen,
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditCsvRow
} from "./settings-audit";
import { useUserLocale } from "../locale/locale-format";
import { useFeedback } from "./settings-feedback";
import { Group, Note, PaneHead, Row, Select } from "./settings-ui";

type Timeframe = "all" | "1" | "7" | "30";

const SPAN_DAYS: Record<Exclude<Timeframe, "all">, number> = { "1": 1, "7": 7, "30": 30 };

export function AuditPane() {
  const { toast } = useFeedback();
  const locale = useUserLocale();
  const auditQuery = useQuery({
    queryKey: queryKeys.settings.adminAuditEvents,
    queryFn: listAdminAuditEvents,
    retry: false
  });
  const usersQuery = useQuery({
    queryKey: queryKeys.settings.adminUsers,
    queryFn: listAdminUsers,
    retry: false
  });

  const [cat, setCat] = useState<"all" | AuditCategory>("all");
  const [actor, setActor] = useState<string>("all");
  const [span, setSpan] = useState<Timeframe>("all");
  const [qry, setQry] = useState("");

  const events = auditQuery.data?.auditEvents ?? [];
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of usersQuery.data?.users ?? []) map.set(user.id, user.name || user.email);
    return map;
  }, [usersQuery.data]);
  const nameOf = (id: string | null): string => (id ? (nameById.get(id) ?? "System") : "System");

  const actors = useMemo(() => {
    const ids = new Map<string, string>();
    for (const event of events) {
      ids.set(event.actorUserId ?? "system", nameOf(event.actorUserId));
    }
    return [...ids.entries()].map(([id, name]) => ({ id, name }));
  }, [events, nameById]);

  const now = new Date(Date.parse(events[0]?.createdAt ?? "") || Date.now());
  const rows = useMemo(() => {
    const term = qry.trim().toLowerCase();
    return events.filter((event) => {
      if (cat !== "all" && auditCategory(event.action) !== cat) return false;
      if (actor !== "all" && (event.actorUserId ?? "system") !== actor) return false;
      if (span !== "all") {
        const age = (now.getTime() - new Date(event.createdAt).getTime()) / 86_400_000;
        if (age > SPAN_DAYS[span]) return false;
      }
      if (term) {
        const hay =
          `${nameOf(event.actorUserId)} ${auditPhrase(event, nameOf)} ${event.action}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [events, cat, actor, span, qry, nameById]);

  const exportCsv = () => {
    const csvRows: AuditCsvRow[] = rows.map((event) => ({
      timestamp: new Date(event.createdAt).toISOString(),
      actor: nameOf(event.actorUserId),
      category: auditCategory(event.action),
      action: event.action,
      target: event.targetId ? nameOf(event.targetId) : (event.targetType ?? "")
    }));
    const blob = new Blob([auditCsv(csvRows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "moss-audit-log.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${rows.length} events (CSV)`, { icon: <Download size={17} /> });
  };

  return (
    <>
      <PaneHead
        title="Audit & operations"
        desc="A record of what's changed, and the operational levers for this instance."
      />
      <Group
        title="Recent activity"
        action={
          <Button
            variant="quiet"
            size="sm"
            disabled={rows.length === 0}
            onClick={exportCsv}
            icon={<Download size={15} />}
          >
            Export log
          </Button>
        }
      >
        <div className="audfilter">
          <Select
            value={cat}
            onChange={(e) => setCat(e.target.value as "all" | AuditCategory)}
            aria-label="Filter by category"
          >
            <option value="all">All activity</option>
            {AUDIT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Select
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            aria-label="Filter by actor"
          >
            <option value="all">Anyone</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select
            value={span}
            onChange={(e) => setSpan(e.target.value as Timeframe)}
            aria-label="Filter by timeframe"
          >
            <option value="all">Any time</option>
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </Select>
          <div className="audfilter__search">
            <Search size={14} aria-hidden="true" />
            <input
              value={qry}
              onChange={(e) => setQry(e.target.value)}
              placeholder="Search activity…"
              spellCheck={false}
              aria-label="Search activity"
            />
          </div>
        </div>

        {auditQuery.isError ? (
          <div className="set2-read-state" role="status">
            <span>Could not load activity.</span>
            <Button variant="quiet" size="sm" onClick={() => void auditQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : null}
        {rows.length ? (
          <div className="aud">
            {rows.map((event) => (
              <div className="aud__row" key={event.id}>
                <div className="aud__when">{auditWhen(event.createdAt, now, locale)}</div>
                <div className="aud__what">
                  <b>{nameOf(event.actorUserId)}</b> {auditPhrase(event, nameOf)}
                </div>
                <div className="aud__cat">{auditCategory(event.action)}</div>
              </div>
            ))}
          </div>
        ) : !auditQuery.isError ? (
          <div className="aud__empty" role="status">
            <SearchX size={18} aria-hidden="true" />
            {auditQuery.isLoading
              ? "Loading activity…"
              : events.length
                ? "No activity matches these filters."
                : "Admin and system actions appear here once recorded."}
          </div>
        ) : null}
        {auditQuery.data ? (
          <div className="aud__count">
            {rows.length} of {events.length} events
          </div>
        ) : null}
      </Group>

      <Group title="Data & backups">
        <Row
          name="Export instance data"
          desc="A full export of all data held on this instance."
          comingIssue={1069}
        />
        <Row
          name="Backup & restore"
          desc="Scheduled backups and point-in-time restore."
          comingIssue={1070}
        />
      </Group>
      <Note>
        Category tags are derived from each action's namespace; export reflects the current filter.
      </Note>
    </>
  );
}
