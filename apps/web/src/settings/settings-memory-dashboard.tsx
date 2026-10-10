import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, Pin, Trash2, X } from "lucide-react";

import {
  acceptMemoryCandidate,
  deleteMemoryEntity,
  deleteMemoryFact,
  getMemoryDashboard,
  patchMemoryEntity,
  patchMemoryFact,
  rejectMemoryCandidate,
  suppressMemoryCandidate,
  type AcceptMemoryCandidateBody,
  type MemoryDashboardItem,
  type MemoryDashboardStatusFilter,
  type PatchMemoryEntityBody,
  type PatchMemoryFactBody
} from "../api/memory-client";
import type { LocaleSettingsDto } from "@moss/shared";
import {
  formatDate as fmtDate,
  formatDateTime as fmtDateTime,
  useUserLocale
} from "../locale/locale-format";
import { Button } from "@moss/ui";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Badge, Group, Segmented, type BadgeTone } from "./settings-ui";

type DashboardTab = "pending" | "active" | "history";

const TAB_STATUS: Record<DashboardTab, MemoryDashboardStatusFilter> = {
  pending: "pending",
  active: "active",
  history: "history"
};

const TAB_LABELS: { readonly value: DashboardTab; readonly label: string }[] = [
  { value: "pending", label: "Review Queue" },
  { value: "active", label: "Memory Records" },
  { value: "history", label: "History" }
];

function itemKindTone(kind: string): BadgeTone {
  if (kind === "candidate") return "amber";
  if (kind === "entity") return "forest";
  return "neutral";
}

function confidenceTone(tier?: string): BadgeTone {
  if (tier === "confirmed") return "forest";
  if (tier === "high") return "steel";
  if (tier === "low") return "amber";
  return "neutral";
}

function formatDate(iso: string | null | undefined, locale: LocaleSettingsDto): string {
  if (!iso) return "—";
  return fmtDate(iso, locale);
}

function formatDateTime(iso: string | null | undefined, locale: LocaleSettingsDto): string {
  if (!iso) return "—";
  return fmtDateTime(iso, locale);
}

/* -------------------------------------------------------------------------- */

interface AcceptFormState {
  summary: string;
  pinned: boolean;
}

function useAcceptForm(
  item: MemoryDashboardItem
): [AcceptFormState, (s: Partial<AcceptFormState>) => void] {
  const [form, setForm] = useState<AcceptFormState>({
    summary: item.summary,
    pinned: item.pinned ?? false
  });
  return [form, (patch) => setForm((prev) => ({ ...prev, ...patch }))];
}

/* -------------------------------------------------------------------------- */

function CandidateActions(props: {
  readonly item: MemoryDashboardItem;
  readonly onDone: () => void;
}) {
  const { item, onDone } = props;
  const locale = useUserLocale();
  const { toast, confirm } = useFeedback();
  const queryClient = useQueryClient();
  const [form, setForm] = useAcceptForm(item);
  const [showAcceptForm, setShowAcceptForm] = useState(false);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["memory", "dashboard"] });
  }

  const acceptMutation = useMutation({
    mutationFn: (body: AcceptMemoryCandidateBody) => acceptMemoryCandidate(item.id, body),
    onSuccess: () => {
      invalidate();
      toast("Candidate accepted");
      onDone();
    },
    onError: (err) => toast(readError(err), { tone: "drift" })
  });

  const rejectMutation = useMutation({
    mutationFn: () => rejectMemoryCandidate(item.id, {}),
    onSuccess: () => {
      invalidate();
      toast("Candidate rejected");
      onDone();
    },
    onError: (err) => toast(readError(err), { tone: "drift" })
  });

  const suppressMutation = useMutation({
    mutationFn: () => suppressMemoryCandidate(item.id, { reason: "suppressed via dashboard" }),
    onSuccess: () => {
      invalidate();
      toast("Candidate suppressed");
      onDone();
    },
    onError: (err) => toast(readError(err), { tone: "drift" })
  });

  const busy = acceptMutation.isPending || rejectMutation.isPending || suppressMutation.isPending;

  function handleAccept() {
    const body: AcceptMemoryCandidateBody = {
      edited:
        form.summary !== item.summary || form.pinned !== (item.pinned ?? false)
          ? { summary: form.summary, pinned: form.pinned }
          : undefined
    };
    acceptMutation.mutate(body);
  }

  function handleReject() {
    confirm({
      title: "Reject this candidate?",
      description: item.title,
      confirmLabel: "Reject",
      danger: true,
      onConfirm: () => rejectMutation.mutate()
    });
  }

  function handleSuppress() {
    confirm({
      title: "Suppress this candidate?",
      description: "It won't appear in your review queue again.",
      confirmLabel: "Suppress",
      danger: true,
      onConfirm: () => suppressMutation.mutate()
    });
  }

  return (
    <div className="memdash-drawer">
      <div className="memdash-drawer__meta">
        <span>Source: {item.sourceSummary || item.sourceKind}</span>
        <span>Created: {formatDateTime(item.createdAt, locale)}</span>
        {item.confidence !== undefined ? (
          <span>Confidence: {Math.round(item.confidence * 100)}%</span>
        ) : null}
      </div>

      {showAcceptForm ? (
        <div className="memdash-drawer__form">
          <label className="memdash-form-label">
            Summary
            <textarea
              className="jds-textarea"
              value={form.summary}
              rows={3}
              onChange={(e) => setForm({ summary: e.target.value })}
            />
          </label>
          <label className="memdash-form-check">
            <input
              type="checkbox"
              checked={form.pinned}
              onChange={(e) => setForm({ pinned: e.target.checked })}
            />
            Pin this memory
          </label>
        </div>
      ) : null}

      <div className="memdash-drawer__actions">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (showAcceptForm) {
              handleAccept();
            } else {
              setShowAcceptForm(true);
            }
          }}
          icon={<Check size={13} aria-hidden="true" />}
        >
          {showAcceptForm ? "Confirm accept" : "Accept"}
        </Button>
        {showAcceptForm ? (
          <Button variant="quiet" size="sm" onClick={() => setShowAcceptForm(false)}>
            Cancel
          </Button>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          disabled={busy}
          onClick={handleReject}
          icon={<X size={13} aria-hidden="true" />}
        >
          Reject
        </Button>
        <Button variant="quiet" size="sm" disabled={busy} onClick={handleSuppress}>
          Suppress
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function FactActions(props: {
  readonly item: MemoryDashboardItem;
  readonly onDone: () => void;
}) {
  const { item, onDone } = props;
  const locale = useUserLocale();
  const { toast, confirm } = useFeedback();
  const queryClient = useQueryClient();
  const [pinned, setPinned] = useState(item.pinned ?? false);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["memory", "dashboard"] });
  }

  const patchMutation = useMutation({
    mutationFn: (body: PatchMemoryFactBody) => patchMemoryFact(item.id, body),
    onSuccess: () => {
      invalidate();
      toast("Fact updated");
      onDone();
    },
    onError: (err) => toast(readError(err), { tone: "drift" })
  });

  function handlePinToggle() {
    const next = !pinned;
    setPinned(next);
    patchMutation.mutate({ pinned: next });
  }

  function handleForget() {
    confirm({
      title: "Forget this memory?",
      description: item.title,
      confirmLabel: "Forget",
      danger: true,
      onConfirm: () => {
        deleteMemoryFact(item.id)
          .then(() => {
            invalidate();
            toast("Memory forgotten");
            onDone();
          })
          .catch((err: unknown) => toast(readError(err), { tone: "drift" }));
      }
    });
  }

  return (
    <div className="memdash-drawer">
      <div className="memdash-drawer__meta">
        <span>Source: {item.sourceSummary || item.sourceKind}</span>
        <span>Created: {formatDateTime(item.createdAt, locale)}</span>
        <span>Updated: {formatDateTime(item.updatedAt, locale)}</span>
        {item.staleAt ? <span>Stale at: {formatDate(item.staleAt, locale)}</span> : null}
        {item.validFrom ? <span>Valid from: {formatDate(item.validFrom, locale)}</span> : null}
        {item.validTo ? <span>Valid to: {formatDate(item.validTo, locale)}</span> : null}
        {item.conflictGroupId ? <span>In conflict group</span> : null}
        {item.supersededByFactId ? <span>Superseded</span> : null}
      </div>

      <div className="memdash-drawer__actions">
        {item.editableFields.includes("pinned") ? (
          <Button
            variant="quiet"
            size="sm"
            active={pinned}
            disabled={patchMutation.isPending}
            onClick={handlePinToggle}
            icon={<Pin size={13} aria-hidden="true" />}
          >
            {pinned ? "Unpin" : "Pin"}
          </Button>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          onClick={handleForget}
          icon={<Trash2 size={13} aria-hidden="true" />}
        >
          Forget
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function EntityActions(props: { readonly item: MemoryDashboardItem; readonly onDone: () => void }) {
  const { item, onDone } = props;
  const locale = useUserLocale();
  const { toast, confirm } = useFeedback();
  const queryClient = useQueryClient();
  const [name, setName] = useState(item.title);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["memory", "dashboard"] });
  }

  const patchMutation = useMutation({
    mutationFn: (body: PatchMemoryEntityBody) => patchMemoryEntity(item.id, body),
    onSuccess: () => {
      invalidate();
      toast("Entity updated");
      onDone();
    },
    onError: (err) => toast(readError(err), { tone: "drift" })
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMemoryEntity(item.id),
    onSuccess: () => {
      invalidate();
      toast("Entity deleted");
      onDone();
    },
    onError: (err) => toast(readError(err), { tone: "drift" })
  });

  function handleSave() {
    if (name.trim() && name !== item.title) {
      patchMutation.mutate({ name: name.trim() });
    }
  }

  function handleDelete() {
    confirm({
      title: "Delete this entity?",
      description: item.title,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => deleteMutation.mutate()
    });
  }

  const busy = patchMutation.isPending || deleteMutation.isPending;

  return (
    <div className="memdash-drawer">
      <div className="memdash-drawer__meta">
        <span>Kind: {item.entityKind ?? "—"}</span>
        <span>Status: {item.status}</span>
        <span>Updated: {formatDateTime(item.updatedAt, locale)}</span>
      </div>

      {item.editableFields.includes("entityName") ? (
        <div className="memdash-drawer__form">
          <label className="memdash-form-label">
            Name
            <input
              type="text"
              className="jds-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
      ) : null}

      <div className="memdash-drawer__actions">
        {item.editableFields.includes("entityName") && name !== item.title ? (
          <Button size="sm" disabled={busy} onClick={handleSave}>
            Save
          </Button>
        ) : null}
        <Button
          variant="quiet"
          size="sm"
          disabled={busy}
          onClick={handleDelete}
          icon={<Trash2 size={13} aria-hidden="true" />}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function DashboardItemRow(props: { readonly item: MemoryDashboardItem }) {
  const { item } = props;
  const locale = useUserLocale();
  const [open, setOpen] = useState(false);

  function renderActions() {
    if (!open) return null;
    if (item.itemKind === "candidate") {
      return <CandidateActions item={item} onDone={() => setOpen(false)} />;
    }
    if (item.itemKind === "entity") {
      return <EntityActions item={item} onDone={() => setOpen(false)} />;
    }
    return <FactActions item={item} onDone={() => setOpen(false)} />;
  }

  return (
    <div className="memdash-item">
      <button
        type="button"
        className="memdash-item__header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="memdash-item__title">{item.title}</span>
        <span className="memdash-item__badges">
          <Badge tone={itemKindTone(item.itemKind)}>{item.itemKind}</Badge>
          {item.recordKind ? <Badge tone="neutral">{item.recordKind}</Badge> : null}
          {item.confidenceTier ? (
            <Badge tone={confidenceTone(item.confidenceTier)}>{item.confidenceTier}</Badge>
          ) : null}
          <Badge tone="steel">{item.status}</Badge>
        </span>
        <span className="memdash-item__date">{formatDate(item.updatedAt, locale)}</span>
        {open ? (
          <ChevronUp size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )}
      </button>
      {item.summary && item.summary !== item.title ? (
        <p className="memdash-item__summary">{item.summary}</p>
      ) : null}
      {renderActions()}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function DashboardList(props: { readonly status: MemoryDashboardStatusFilter }) {
  const { status } = props;
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.memory.dashboard({ status }),
    queryFn: () => getMemoryDashboard({ status }),
    retry: false
  });

  if (isLoading) {
    return <p className="memdash-empty">Loading…</p>;
  }

  if (isError) {
    return <p className="memdash-empty memdash-empty--error">Failed to load. Try again.</p>;
  }

  const items = data?.items ?? [];

  if (items.length === 0) {
    return <p className="memdash-empty">Nothing here.</p>;
  }

  return (
    <div className="memdash-list">
      {items.map((item) => (
        <DashboardItemRow key={item.id} item={item} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function MemoryDashboardPane() {
  const [tab, setTab] = useState<DashboardTab>("pending");

  const counts = useQuery({
    queryKey: queryKeys.memory.dashboard({}),
    queryFn: () => getMemoryDashboard({}),
    retry: false,
    select: (d) => d.counts
  });

  const pendingCount = counts.data?.pending ?? 0;
  const reviewLabel = pendingCount > 0 ? `Review Queue (${pendingCount})` : "Review Queue";

  return (
    <Group
      title="Memory dashboard"
      desc="Review new candidates, inspect your memory graph, and manage records."
    >
      <div className="memdash">
        <Segmented
          value={tab}
          options={TAB_LABELS.map((t) =>
            t.value === "pending"
              ? { value: t.value as DashboardTab, label: reviewLabel }
              : (t as { value: DashboardTab; label: string })
          )}
          onChange={setTab}
          ariaLabel="Memory dashboard tabs"
        />
        <DashboardList status={TAB_STATUS[tab]} />
      </div>
    </Group>
  );
}
