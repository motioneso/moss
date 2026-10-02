import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type ReactNode } from "react";

import {
  INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE,
  type IntegrationClassifierArgument,
  type IntegrationClassifierDraftFailure,
  type IntegrationClassifierRisk,
  type IntegrationClassifierToolDraft,
  type IntegrationClassifierToolPreparation,
  type IntegrationDetail,
  type IntegrationToolDescriptor,
  type PrepareIntegrationClassifierResponse,
  type SaveIntegrationClassifierToolRequest
} from "@moss/shared";
import { Button, Select } from "@moss/ui";

import {
  ApiError,
  prepareIntegrationClassifierTools,
  removeIntegrationClassifierTool,
  saveIntegrationClassifierTool,
  updateIntegration
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Badge, Field, Group, Note, Row, Switch } from "./settings-ui";

/**
 * Classifier gate 2b.4 (#2899): the connection-detail classifier section.
 *
 * This screen is consent. The per-connection switch only marks the connection eligible; it never
 * makes a model call, never approves a draft and never opts a tool in. The owner presses Prepare,
 * reads the disclosure, reviews each draft (description, reply, risk) and switches on only the tools
 * they want. Every label, badge and count renders from the detail record or the prepare response;
 * never from model prose.
 */

export type ClassifierSectionState =
  | "disconnected"
  | "no-tools"
  | "not-prepared"
  | "preparing"
  | "failed"
  | "review"
  | "stale"
  | "off"
  | "risk-needed"
  | "approved";

export const CLASSIFIER_RISK_OPTIONS: readonly {
  readonly value: IntegrationClassifierRisk;
  readonly label: string;
}[] = [
  { value: "read", label: "Only reads" },
  { value: "write", label: "Changes a device" },
  { value: "outbound", label: "Sends data out" },
  { value: "destructive", label: "Sensitive or destructive" }
];

const RISK_LABEL: Readonly<Record<IntegrationClassifierRisk, string>> = {
  read: "Only reads",
  write: "Changes a device",
  outbound: "Sends data out",
  destructive: "Sensitive or destructive"
};

/** The derived-other bucket name; see curation.ts. A service's own "Other" group is ordinary. */
const OTHER_GROUP = "Other";

export interface ClassifierStateInput {
  readonly enabled: boolean;
  readonly classifierEnabled: boolean;
  readonly toolCount: number;
  readonly preparing: boolean;
  readonly prepareStatus: PrepareIntegrationClassifierResponse["status"] | null;
  readonly prepareFailed: boolean;
  readonly draftCount: number;
  readonly saved: readonly IntegrationClassifierToolPreparation[];
}

/**
 * Pick the section body in a fixed priority so a stale review can never be offered for approval, a
 * failed prepare is never hidden behind an old approved state, and a saved tool that cannot be used
 * is never labelled "Approved / Current".
 */
export function classifierSectionState(input: ClassifierStateInput): ClassifierSectionState {
  if (!input.enabled) return "disconnected";
  if (input.toolCount === 0) return "no-tools";
  if (input.preparing) return "preparing";
  if (input.prepareStatus === "unavailable" || input.prepareStatus === "unsupported_model") {
    return "failed";
  }
  if (input.prepareFailed) return "failed";
  if (input.draftCount > 0) return "review";
  if (input.saved.some((entry) => entry.state === "stale")) return "stale";
  if (!input.classifierEnabled && input.saved.length > 0) return "off";
  if (input.saved.some((entry) => entry.reviewedRisk === null)) return "risk-needed";
  if (input.saved.length > 0) return "approved";
  return "not-prepared";
}

/**
 * Names the owner left enabled for ordinary chat. Mirrors `effectiveEnabledTools` closely enough for
 * an explanatory reason: a muted tool is always out; the flat list enables everything not muted; the
 * grouped list enables muted-off tools that are explicitly named or sit in an enabled group. The
 * derived "Other" bucket (over-threshold, ungrouped) is not an opt-in unit, and its members are out
 * unless explicitly named.
 */
export function ordinaryEnabledToolNames(detail: IntegrationDetail): ReadonlySet<string> {
  const muted = new Set(detail.mutedTools);
  if (!detail.groupOptIn) {
    return new Set(detail.tools.filter((tool) => !muted.has(tool.name)).map((tool) => tool.name));
  }
  const groups = new Set(detail.enabledGroups);
  const explicit = new Set(detail.enabledTools);
  return new Set(
    detail.tools
      .filter(
        (tool) =>
          !muted.has(tool.name) &&
          (explicit.has(tool.name) || (tool.group !== OTHER_GROUP && groups.has(tool.group)))
      )
      .map((tool) => tool.name)
  );
}

export interface ClassifierEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

/** A tool whose schema cannot be expressed as a bounded menu is ineligible (mirrors 2b.3). */
export function hasRootCombinator(schema: Record<string, unknown> | null): boolean {
  return schema !== null && ROOT_COMBINATORS.some((key) => key in schema);
}

export function classifierEligibility(
  tool: IntegrationToolDescriptor,
  entry: IntegrationClassifierToolPreparation | undefined,
  ordinaryEnabled: ReadonlySet<string>,
  classifierEnabled: boolean
): ClassifierEligibility {
  const reasons: string[] = [];
  if (!classifierEnabled) reasons.push("The connection switch is off.");
  if (!ordinaryEnabled.has(tool.name)) {
    reasons.push("Off for ordinary chat, so the classifier cannot use it.");
  }
  const tooComplex = hasRootCombinator(tool.inputSchema);
  if (!entry) {
    reasons.push(
      tooComplex ? "This tool's schema is too complex to prepare." : "Not reviewed yet."
    );
    return { eligible: false, reasons };
  }
  if (entry.state === "stale")
    reasons.push("The connection changed this tool since it was reviewed.");
  if (tooComplex) reasons.push("This tool's schema is too complex to prepare.");
  if (entry.reviewedRisk === null) reasons.push("Risk not chosen.");
  if (!entry.optIn) reasons.push("Not allowed for the classifier yet.");
  return { eligible: reasons.length === 0, reasons };
}

export function draftFailureReason(reason: IntegrationClassifierDraftFailure): string {
  switch (reason) {
    case "provider_error":
      return "The model could not draft this tool.";
    case "invalid_draft":
      return "The draft was not usable.";
    case "definition_too_large":
      return "This tool's definition is too large to prepare.";
    case "aborted":
      return "Preparation was cancelled.";
  }
}

function riskLabel(risk: IntegrationClassifierRisk | null): string {
  return risk === null ? "Unknown" : RISK_LABEL[risk];
}

interface ToolHint {
  readonly text: string;
  readonly conflict: boolean;
}

/** Server hints are a suggestion only; a conflict is named and never resolved for the owner. */
function toolHint(tool: IntegrationToolDescriptor): ToolHint {
  const parts: string[] = [];
  if (tool.readOnly === true) parts.push("only reads");
  if (tool.destructive === true) parts.push("is sensitive or destructive");
  if (tool.idempotent === true) parts.push("can be repeated");
  return {
    text: parts.length > 0 ? `The connection says this ${parts.join(", ")}.` : "",
    conflict: tool.readOnly === true && tool.destructive === true
  };
}

/** One editable review row, from a transient draft or a saved entry opened for editing. */
interface DraftRow {
  readonly toolName: string;
  readonly definitionFingerprint: string;
  readonly description: string;
  readonly replyTemplate: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly reviewedRisk: IntegrationClassifierRisk | null;
  readonly optIn: boolean;
  /** Only a saved entry carries a candidate source today; 2b.5 adds it to drafts. */
  readonly candidateSource?: string;
}

function draftToRow(draft: IntegrationClassifierToolDraft): DraftRow {
  return {
    toolName: draft.toolName,
    definitionFingerprint: draft.definitionFingerprint,
    description: draft.description,
    replyTemplate: draft.replyTemplate,
    arguments: draft.arguments,
    reviewedRisk: null,
    optIn: false
  };
}

function entryToRow(entry: IntegrationClassifierToolPreparation): DraftRow {
  return {
    toolName: entry.toolName,
    definitionFingerprint: entry.definitionFingerprint,
    description: entry.description,
    replyTemplate: entry.replyTemplate,
    arguments: entry.arguments,
    reviewedRisk: entry.reviewedRisk,
    optIn: entry.optIn,
    ...(entry.candidateSource !== undefined ? { candidateSource: entry.candidateSource } : {})
  };
}

function rowBody(row: DraftRow): SaveIntegrationClassifierToolRequest {
  return {
    optIn: row.optIn,
    reviewedRisk: row.reviewedRisk,
    description: row.description,
    arguments: row.arguments,
    replyTemplate: row.replyTemplate,
    ...(row.candidateSource !== undefined ? { candidateSource: row.candidateSource } : {}),
    reviewedFingerprint: row.definitionFingerprint
  };
}

export function IntegrationClassifierSection(props: {
  readonly detail: IntegrationDetail;
  readonly onChanged: () => void;
}) {
  const { detail, onChanged } = props;
  const { toast, confirm } = useFeedback();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Readonly<Record<string, DraftRow>>>({});
  const [edits, setEdits] = useState<Readonly<Record<string, DraftRow>>>({});
  const [prepareStatus, setPrepareStatus] = useState<
    PrepareIntegrationClassifierResponse["status"] | null
  >(null);
  const [prepareFailed, setPrepareFailed] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [failedDrafts, setFailedDrafts] = useState<
    Readonly<Record<string, IntegrationClassifierDraftFailure>>
  >({});
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.integrations.detail(detail.id) });
    onChanged();
  };

  const saved = detail.classifierPreparation;
  const ordinaryEnabled = ordinaryEnabledToolNames(detail);
  const discoveredNames = new Set(detail.tools.map((tool) => tool.name));
  const orphanSaved = saved.filter((entry) => !discoveredNames.has(entry.toolName));
  const reviewedCount = Object.values(drafts).filter((row) => row.reviewedRisk !== null).length;
  const draftCount = Object.keys(drafts).length;

  const state = classifierSectionState({
    enabled: detail.enabled,
    classifierEnabled: detail.classifierEnabled,
    toolCount: detail.tools.length,
    preparing,
    prepareStatus,
    prepareFailed,
    draftCount,
    saved
  });

  const reportError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) {
      toast("That tool changed since you opened it. Reload and review it again.", {
        tone: "drift"
      });
      void invalidate();
      return;
    }
    toast(readError(error), { tone: "drift" });
  };

  const setClassifierEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (!enabled) {
        abortController?.abort();
        setAbortController(null);
        setPreparing(false);
      }
      await updateIntegration(detail.id, { classifierEnabled: enabled });
      if (!enabled) {
        setDrafts({});
        setPrepareStatus(null);
        setPrepareFailed(false);
        setPrepareError(null);
        setFailedDrafts({});
      }
      await invalidate();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const runPrepare = async (force: boolean) => {
    abortController?.abort();
    const controller = new AbortController();
    setAbortController(controller);
    setBusy(true);
    setPreparing(true);
    setPrepareFailed(false);
    setPrepareError(null);
    try {
      if (!detail.classifierEnabled) {
        await updateIntegration(detail.id, { classifierEnabled: true });
      }
      const result = await prepareIntegrationClassifierTools(
        detail.id,
        { force },
        controller.signal
      );
      setPrepareStatus(result.status);
      if (result.status !== "ok") {
        setPrepareFailed(true);
        setDrafts({});
        return;
      }
      const next: Record<string, DraftRow> = {};
      for (const draft of result.drafts) next[draft.toolName] = draftToRow(draft);
      setDrafts(next);
      if (force) setEdits({});
      setFailedDrafts(
        Object.fromEntries(result.failed.map((failure) => [failure.toolName, failure.reason]))
      );
      setRemaining(result.remaining);
      await invalidate();
    } catch (error) {
      if (controller.signal.aborted) return;
      setPrepareFailed(true);
      setPrepareStatus(null);
      setPrepareError(readError(error));
    } finally {
      setPreparing(false);
      setBusy(false);
    }
  };

  const saveRows = async (rows: readonly DraftRow[]) => {
    for (const row of rows) {
      await saveIntegrationClassifierTool(detail.id, row.toolName, rowBody(row));
    }
  };

  const approveReviewed = async () => {
    const reviewed = Object.values(drafts).filter((row) => row.reviewedRisk !== null);
    if (reviewed.length === 0) return;
    setBusy(true);
    try {
      await saveRows(reviewed);
      const approvedNames = new Set(reviewed.map((row) => row.toolName));
      setDrafts((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([name]) => !approvedNames.has(name)))
      );
      setRemaining((current) => Math.max(0, current));
      toast(`${reviewed.length} ${reviewed.length === 1 ? "tool" : "tools"} approved.`);
      await invalidate();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const discardDraft = () => {
    setDrafts({});
    setPrepareStatus(null);
    setPrepareFailed(false);
    setPrepareError(null);
    setFailedDrafts({});
  };

  const saveEdit = async (row: DraftRow) => {
    setBusy(true);
    try {
      await saveIntegrationClassifierTool(detail.id, row.toolName, rowBody(row));
      setEdits((prev) => {
        const next = { ...prev };
        delete next[row.toolName];
        return next;
      });
      toast("Saved.");
      await invalidate();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const setOptIn = async (entry: IntegrationClassifierToolPreparation, optIn: boolean) => {
    setBusy(true);
    try {
      await saveIntegrationClassifierTool(detail.id, entry.toolName, {
        optIn,
        reviewedRisk: entry.reviewedRisk,
        description: entry.description,
        arguments: entry.arguments,
        replyTemplate: entry.replyTemplate,
        ...(entry.candidateSource !== undefined ? { candidateSource: entry.candidateSource } : {}),
        reviewedFingerprint: entry.definitionFingerprint
      });
      await invalidate();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const removeReview = (entry: IntegrationClassifierToolPreparation) => {
    confirm({
      title: `Remove ${entry.toolName} from the classifier?`,
      description: "The tool stays out until you review it again.",
      confirmLabel: "Remove",
      onConfirm: () => {
        void (async () => {
          try {
            await removeIntegrationClassifierTool(detail.id, entry.toolName);
            await invalidate();
          } catch (error) {
            reportError(error);
          }
        })();
      }
    });
  };

  const updateDraft = (toolName: string, patch: Partial<DraftRow>) => {
    setDrafts((prev) => ({ ...prev, [toolName]: { ...prev[toolName]!, ...patch } }));
  };

  // `base` seeds the row the first time it is edited. A Risk needed row is shown without an entry
  // in `edits`, so without this fallback the first change would spread `undefined` and wipe the
  // saved tool name, description, reply and fingerprint.
  const updateEdit = (toolName: string, base: DraftRow, patch: Partial<DraftRow>) => {
    setEdits((prev) => ({ ...prev, [toolName]: { ...(prev[toolName] ?? base), ...patch } }));
  };

  const headTitle =
    state === "disconnected"
      ? "Disconnected"
      : state === "no-tools"
        ? "No tools found"
        : state === "preparing"
          ? "Preparing..."
          : state === "failed"
            ? "Preparing failed"
            : state === "review"
              ? "Review required"
              : state === "stale"
                ? "Needs review"
                : state === "off"
                  ? "Off"
                  : state === "risk-needed"
                    ? "Risk needed"
                    : state === "approved"
                      ? "Approved"
                      : "Not prepared";

  const headBadge =
    state === "approved" ? (
      <Badge tone="forest">Current</Badge>
    ) : state === "stale" ? (
      <Badge tone="amber">Changed</Badge>
    ) : state === "failed" ? (
      <Badge tone="red">Failed</Badge>
    ) : state === "review" ? (
      <Badge tone="amber">{`${reviewedCount} of ${draftCount} reviewed`}</Badge>
    ) : state === "disconnected" ? (
      <Badge tone="neutral">Disconnected</Badge>
    ) : state === "off" ? (
      <Badge tone="neutral">Off</Badge>
    ) : null;

  // Tools a prepare request would actually draft: ordinary-chat available and expressible as a
  // bounded menu. Schema-combinator tools are skipped by 2b.3, so they must not inflate the count.
  const prepareCount = detail.tools.filter(
    (tool) => ordinaryEnabled.has(tool.name) && !hasRootCombinator(tool.inputSchema)
  ).length;

  const renderEditor = (
    row: DraftRow,
    tool: IntegrationToolDescriptor | undefined,
    onChange: (patch: Partial<DraftRow>) => void,
    actions: ReactNode,
    isDraft: boolean
  ) => {
    const hint = tool ? toolHint(tool) : { text: "", conflict: false };
    return (
      <div className="clsf__tool" key={row.toolName}>
        <div className="clsf__toolhead">
          <strong>{row.toolName}</strong>
          {isDraft ? <Badge tone="amber">Draft</Badge> : null}
        </div>
        <Field label="Description the classifier sees">
          <input
            className="jds-input"
            aria-label={`Description the classifier sees for ${row.toolName}`}
            value={row.description}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </Field>
        <Field label="Reply" hint="May use {status}, {action} or {summary}.">
          <input
            className="jds-input"
            aria-label={`Reply for ${row.toolName}`}
            value={row.replyTemplate}
            onChange={(event) => onChange({ replyTemplate: event.target.value })}
          />
        </Field>
        <Field
          label="Risk"
          hint={hint.conflict ? "The connection's hints disagree. You decide." : hint.text}
        >
          <Select
            aria-label={`Risk for ${row.toolName}`}
            value={row.reviewedRisk ?? ""}
            onChange={(event) =>
              onChange({
                reviewedRisk:
                  event.target.value === ""
                    ? null
                    : (event.target.value as IntegrationClassifierRisk)
              })
            }
          >
            <option value="">Choose a risk...</option>
            {CLASSIFIER_RISK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Note>{describeArguments(row.arguments)}</Note>
        <div className="clsf__actions">
          <Switch
            ariaLabel={`Classifier may use ${row.toolName}`}
            checked={row.optIn}
            onChange={(checked) => onChange({ optIn: checked })}
          />
          {actions}
        </div>
      </div>
    );
  };

  const renderSavedRow = (entry: IntegrationClassifierToolPreparation) => {
    if (entry.state === "stale") {
      return (
        <div className="clsf__tool" key={entry.toolName}>
          <div className="clsf__toolhead">
            <strong>{entry.toolName}</strong>
            <Badge tone="amber">Changed</Badge>
          </div>
          <Row name="Before" desc={entry.description} />
          <Row
            name="After"
            desc={detail.tools.find((tool) => tool.name === entry.toolName)?.description ?? ""}
          />
          <div className="clsf__actions">
            <Button size="sm" disabled={busy} onClick={() => void runPrepare(true)}>
              Review changes
            </Button>
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              onClick={() => void setOptIn(entry, false)}
            >
              Keep it off
            </Button>
          </div>
        </div>
      );
    }
    const tool = detail.tools.find((candidate) => candidate.name === entry.toolName);
    const editRow = edits[entry.toolName];
    const eligibility = tool
      ? classifierEligibility(tool, entry, ordinaryEnabled, detail.classifierEnabled)
      : { eligible: false, reasons: ["No longer available on the connection."] };
    // A saved review with no risk is the mockup's "Risk needed" state: show the editor so the owner
    // can pick a risk and save, never an "Approved / Current" row.
    const pendingRisk = entry.reviewedRisk === null;
    if (editRow || pendingRisk) {
      const row = editRow ?? entryToRow(entry);
      return (
        <Fragment key={entry.toolName}>
          {eligibility.reasons.length > 0 ? <Note>{eligibility.reasons.join(" ")}</Note> : null}
          {renderEditor(
            row,
            tool,
            (patch) => updateEdit(entry.toolName, entryToRow(entry), patch),
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void saveEdit(row)}
              >
                Save
              </Button>
              {editRow ? (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    setEdits((prev) => {
                      const next = { ...prev };
                      delete next[entry.toolName];
                      return next;
                    })
                  }
                >
                  Cancel
                </Button>
              ) : null}
            </>,
            false
          )}
        </Fragment>
      );
    }
    return (
      <div className="clsf__tool" key={entry.toolName}>
        <Row
          name={entry.toolName}
          desc={`Risk: ${riskLabel(entry.reviewedRisk)}`}
          control={
            <span className="intg__controls">
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Edit ${entry.toolName} review`}
                onClick={() =>
                  setEdits((prev) => ({ ...prev, [entry.toolName]: entryToRow(entry) }))
                }
              >
                Edit
              </Button>
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Remove ${entry.toolName} review`}
                onClick={() => removeReview(entry)}
              >
                Remove
              </Button>
              <Switch
                ariaLabel={`Classifier may use ${entry.toolName}`}
                checked={entry.optIn}
                disabled={busy || entry.reviewedRisk === null}
                onChange={(checked) => void setOptIn(entry, checked)}
              />
            </span>
          }
        />
        {eligibility.reasons.length > 0 ? <Note>{eligibility.reasons.join(" ")}</Note> : null}
      </div>
    );
  };

  const renderTool = (tool: IntegrationToolDescriptor) => {
    const draft = drafts[tool.name];
    if (draft) {
      return renderEditor(draft, tool, (patch) => updateDraft(tool.name, patch), null, true);
    }
    const entry = saved.find((savedEntry) => savedEntry.toolName === tool.name);
    if (entry) return renderSavedRow(entry);
    const failure = failedDrafts[tool.name];
    const reasons = failure
      ? [draftFailureReason(failure)]
      : classifierEligibility(tool, undefined, ordinaryEnabled, detail.classifierEnabled).reasons;
    return (
      <div className="clsf__ineligible" key={tool.name}>
        <strong>{tool.name}</strong>
        <Note>{reasons.join(" ")}</Note>
      </div>
    );
  };

  const body = (() => {
    if (state === "disconnected") {
      return <Note>Reconnect to change these settings.</Note>;
    }
    if (state === "no-tools") {
      return <Note>Nothing to prepare yet.</Note>;
    }
    if (state === "preparing") {
      return (
        <>
          <Note>Usually under a minute.</Note>
          <div className="clsf__actions">
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                abortController?.abort();
                setAbortController(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      );
    }
    if (state === "failed") {
      const message =
        prepareStatus === "unavailable"
          ? "No default chat model is set."
          : prepareStatus === "unsupported_model"
            ? "Your default chat model cannot draft setup notes."
            : (prepareError ?? "Preparing failed.");
      return (
        <>
          <Note>{message}</Note>
          {prepareStatus === "unavailable" || prepareStatus === "unsupported_model" ? (
            <Note>
              <a href="/settings?section=assistant">
                Choose a chat model that supports structured output
              </a>
            </Note>
          ) : null}
          <Note>Nothing changed.</Note>
          <div className="clsf__actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void runPrepare(false)}
            >
              Try again
            </Button>
          </div>
        </>
      );
    }
    if (state === "review") {
      return (
        <>
          <Note>
            A draft is only a suggestion. Review each tool, choose its risk and switch on only the
            ones the classifier may use. Tools without a chosen risk stay out and are not saved.
          </Note>
          {detail.tools.map(renderTool)}
          {orphanSaved.map((entry) => (
            <div className="clsf__ineligible" key={entry.toolName}>
              <strong>{entry.toolName}</strong>
              <Note>No longer available on the connection.</Note>
            </div>
          ))}
          <div className="clsf__actions">
            <Button
              size="sm"
              disabled={busy || reviewedCount === 0}
              onClick={() => void approveReviewed()}
            >
              Approve reviewed tools
            </Button>
            <Button variant="quiet" size="sm" disabled={busy} onClick={discardDraft}>
              Discard draft
            </Button>
          </div>
        </>
      );
    }
    // stale, off, risk-needed and approved show the saved rows; per-row controls differ.
    return (
      <>
        {state === "stale" ? (
          <>
            <Note>The connection changed its tools. The classifier is paused here.</Note>
            <Note>Preparing again costs one more default model request.</Note>
          </>
        ) : null}
        {state === "off" ? (
          <Note>
            The classifier is off for this connection. These saved tools stay out until you turn it
            on.
          </Note>
        ) : null}
        {state === "risk-needed" ? <Note>Pick a risk for each tool.</Note> : null}
        {detail.tools.map(renderTool)}
        {orphanSaved.map((entry) => renderSavedRow(entry))}
        {remaining > 0 && state === "approved" ? (
          <div className="clsf__actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void runPrepare(false)}
            >
              {`Prepare ${remaining} more`}
            </Button>
          </div>
        ) : null}
      </>
    );
  })();

  return (
    <Group
      title={<span className="intg__name">Let the classifier use this connection</span>}
      desc="Quick requests can skip your default model. You review each tool first."
      action={
        <Switch
          ariaLabel="Let the classifier use this connection"
          checked={detail.classifierEnabled}
          disabled={!detail.enabled || busy}
          onChange={(checked) => void setClassifierEnabled(checked)}
        />
      }
    >
      <div className="clsf__head">
        <strong>{headTitle}</strong>
        {headBadge}
      </div>
      <Note>Messages and device names go to the classifier provider.</Note>
      {state === "disconnected" || state === "no-tools" ? null : (
        <div className="clsf__disclosure">
          <strong>What is sent, and what it costs</strong>
          <Note>{INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE.sent}</Note>
          <Note>{INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE.provider}</Note>
          <Note>{INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE.cost}</Note>
          <Note>{INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE.excluded}</Note>
        </div>
      )}
      {body}
      {state === "not-prepared" && prepareCount > 0 ? (
        <>
          <div className="clsf__actions">
            <Button size="sm" disabled={busy} onClick={() => void runPrepare(false)}>
              {`Prepare ${prepareCount} ${prepareCount === 1 ? "tool" : "tools"}`}
            </Button>
          </div>
          <Note>Your default model reads the tool list once.</Note>
        </>
      ) : null}
    </Group>
  );
}

function describeArguments(args: Readonly<Record<string, IntegrationClassifierArgument>>): string {
  const names = Object.keys(args);
  if (names.length === 0) return "No values are needed.";
  return names
    .map((name) => {
      const argument = args[name]!;
      if (argument.kind === "enum") {
        return `${name}: one of ${(argument.values ?? []).join(", ")}`;
      }
      if (argument.kind === "candidates") {
        return `${name}: picked from a list`;
      }
      return `${name}: needs a typed value`;
    })
    .join("; ");
}
