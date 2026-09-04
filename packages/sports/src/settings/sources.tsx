import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Note } from "@moss/settings-ui";
import { ApiError, Button } from "@moss/module-web-sdk";
import type {
  CompetitionRef,
  PreviewSportsSourceAssignmentsResponse,
  SportsBuiltinSourceDto,
  SportsCustomSourceDto,
  SportsFollowDto,
  SportsSourceAssignmentTarget,
  TeamRef
} from "@moss/shared";
import { Check, CircleAlert, Newspaper, Plus } from "lucide-react";

import {
  confirmSportsSourceAssignments,
  confirmSportsSourceRecipe,
  confirmSportsSource,
  deleteSportsSource,
  listSportsSources,
  previewSportsSourceAssignments,
  previewSportsSource,
  previewSportsSourceRecipe,
  retrySportsSource,
  updateSportsEspnCoverage
} from "../web/sports-client.js";
import { sportsQueryKeys } from "../web/query-keys.js";
import { competitionLogoUrl } from "../source/catalog.js";
import { sportsSourceTargetKey, sportsSportOptions } from "../source/scope.js";
import { SourceAssignmentPicker, sourceTargetDisplayLabel } from "./source-assignment-picker.js";

/* #1572: custom public news sources by team and league. Mirrors News' add-source flow
   (packages/news/src/settings/add-source.tsx), simplified for Sports' single-candidate,
   URL-only preview (no name/web-search ambiguity) and extended with a follow-assignment
   picker, since a sports source is scoped to specific followed teams/leagues rather than
   contributing to one shared front page. */

const PREVIEW_REJECTION_COPY: Record<string, string> = {
  policy: "That publication isn't allowed by the content policy.",
  invalid_input: "That doesn't look like a publication we can check — try a homepage link.",
  unreachable: "We couldn't reach that site. Check the address and try again.",
  not_https: "Only HTTPS links or bare domains are accepted.",
  not_found: "That subreddit doesn't exist.",
  auth_required: "That subreddit is private or restricted, so Moss can't read it.",
  rate_limited: "Reddit is rate limiting Moss. Try again in a few minutes.",
  stale_source: "That publication has changed since it was added. Remove it and add it again."
};

/** The edit-coverage flow said "could not be verified" whatever the reason (Ben, 2026-09-04). */
function assignmentPreviewFailureCopy(result: PreviewSportsSourceAssignmentsResponse): string {
  if (result.status === "rejected") {
    return (
      (result.reason ? PREVIEW_REJECTION_COPY[result.reason] : undefined) ??
      "Those assignments could not be verified."
    );
  }
  if (result.status === "unavailable") {
    return "Updating coverage needs a configured JSON-capable AI model.";
  }
  return "Those assignments could not be verified.";
}

const HEALTH_BADGE: Record<
  SportsCustomSourceDto["healthState"],
  { tone: "neutral" | "pine" | "amber" | "red" | "steel"; label: string } | null
> = {
  pending: { tone: "steel", label: "Awaiting first check" },
  healthy: { tone: "pine", label: "Healthy" },
  failing: { tone: "amber", label: "Having trouble" },
  unsupported: { tone: "red", label: "Unsupported" },
  auth_required: { tone: "red", label: "Needs login" },
  disabled: { tone: "neutral", label: "Disabled" }
};

/* ESPN's own mark, served from a host the module already allows in the web CSP img-src.
   Custom sources get their publication favicon through the module's own icon route (#2211),
   which fetches server-side because arbitrary publisher hosts are blocked by the CSP. */
const ESPN_LOGO_URL = "https://a.espncdn.com/i/espn/espn_logos/espn_red.png";

export function sportsSourceIconUrl(sourceId: string): string {
  return `/api/sports/sources/${encodeURIComponent(sourceId)}/icon`;
}

function SourceIcon(props: { logoUrl?: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const logoUrl = props.logoUrl && props.logoUrl !== failedUrl ? props.logoUrl : null;
  return (
    <span className="sp-src__item-icon" aria-hidden="true">
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          aria-hidden="true"
          width={24}
          height={24}
          onError={() => setFailedUrl(logoUrl)}
        />
      ) : (
        <Newspaper size={16} />
      )}
    </span>
  );
}

function SourceError(props: { children: string }) {
  return (
    <p className="sp-src__err" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      <span>{props.children}</span>
    </p>
  );
}

function AssignmentIdentity(props: {
  target: SportsSourceAssignmentTarget;
  label: string;
  follows: readonly SportsFollowDto[];
  teamsByCompetition: Map<string, readonly TeamRef[]>;
}) {
  const target = props.target;
  const follow =
    target.kind === "follow" ? props.follows.find(({ id }) => id === target.followId) : undefined;
  const team = follow?.teamKey
    ? props.teamsByCompetition
        .get(follow.competitionKey)
        ?.find(({ teamKey }) => teamKey === follow.teamKey)
    : undefined;
  const logoUrl = team?.crestUrl ?? (follow ? competitionLogoUrl(follow.competitionKey) : null);
  return (
    <span className="sp-src__assignment-identity">
      {logoUrl ? (
        <img
          className="sp-src__assignment-logo"
          src={logoUrl}
          alt=""
          aria-hidden="true"
          width={24}
          height={24}
        />
      ) : null}
      <span>{props.label}</span>
    </span>
  );
}

export function AddSourceFlow(props: {
  follows: readonly SportsFollowDto[];
  competitionsByKey: Map<string, CompetitionRef>;
  teamsByCompetition: Map<string, readonly TeamRef[]>;
}) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewSportsSource>> | null>(
    null
  );
  const [selectedTargets, setSelectedTargets] = useState<Map<string, SportsSourceAssignmentTarget>>(
    new Map()
  );
  const [authorizationAccepted, setAuthorizationAccepted] = useState(false);
  const [added, setAdded] = useState(false);
  // The preview card lands below the fold once coverage is picked; bring it into view when it
  // appears (Ben, 2026-09-03).
  const candidateRef = useRef<HTMLDivElement | null>(null);
  const showCandidate = preview?.status === "ok" && Boolean(preview.candidate);
  useEffect(() => {
    if (showCandidate)
      candidateRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [showCandidate]);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: sportsQueryKeys.sources });

  const previewMutation = useMutation({
    mutationFn: previewSportsSource,
    onSuccess: (result) => {
      setPreview(result);
      setAuthorizationAccepted(false);
    }
  });

  const confirmMutation = useMutation({
    mutationFn: confirmSportsSource,
    onSuccess: () => {
      setInput("");
      setPreview(null);
      setSelectedTargets(new Map());
      setAuthorizationAccepted(false);
      setAdded(true);
      invalidate();
    }
  });

  function submitPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setAdded(false);
    setPreview(null);
    previewMutation.mutate({
      url: trimmed,
      // One text box only: coverage ticks decide the scope, none ticked means general (Ben, 2026-09-03).
      assignments: [...selectedTargets.values()].map((target) => ({ target }))
    });
  }

  function confirm() {
    if (
      !preview?.confirmationId ||
      !preview.candidate ||
      !preview.authorizationAcknowledgement ||
      !authorizationAccepted
    )
      return;
    confirmMutation.mutate({
      confirmationId: preview.confirmationId,
      authorizationAcknowledgement: preview.authorizationAcknowledgement,
      canonicalDomain: preview.candidate.canonicalDomain,
      confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
      targets: preview.candidate.targets.map((target) => ({
        target: target.target,
        targetUrl: target.targetUrl
      }))
    });
  }

  function reset() {
    setPreview(null);
    setSelectedTargets(new Map());
    setAuthorizationAccepted(false);
    confirmMutation.reset();
  }

  function toggleTarget(target: SportsSourceAssignmentTarget) {
    setSelectedTargets((current) => {
      const next = new Map(current);
      const key = sportsSourceTargetKey(target);
      if (next.has(key)) next.delete(key);
      else next.set(key, target);
      setPreview(null);
      setAuthorizationAccepted(false);
      return next;
    });
  }

  const busy = previewMutation.isPending || confirmMutation.isPending;
  const previewFailure =
    preview?.status === "rejected"
      ? ((preview.reason ? PREVIEW_REJECTION_COPY[preview.reason] : undefined) ??
        "That publication can't be added.")
      : preview?.status === "unavailable"
        ? "Adding sources needs a configured JSON-capable AI model."
        : null;
  const confirmFailure = confirmMutation.isError
    ? confirmMutation.error instanceof ApiError
      ? confirmMutation.error.message
      : "Could not add that source. Try again."
    : null;
  const errorMessage =
    previewFailure ??
    confirmFailure ??
    (previewMutation.isError ? "Could not check that publication. Try again." : null);

  return (
    <div className="sp-src__addflow">
      <form className="sp-src__form" onSubmit={submitPreview}>
        <label className="sp-src__label" htmlFor="sp-addsource-input">
          Publication homepage or domain
        </label>
        <div className="sp-src__row">
          <input
            id="sp-addsource-input"
            className="jds-input"
            type="text"
            value={input}
            placeholder="theathletic.com or r/nfl"
            disabled={busy}
            onChange={(event) => {
              setInput(event.target.value);
              setAdded(false);
            }}
          />
          <Button type="submit" size="sm" disabled={busy || !input.trim()}>
            {previewMutation.isPending ? "Checking…" : "Check"}
          </Button>
        </div>
      </form>

      {/* Coverage stays hidden until a publication is entered (Ben, 2026-09-03). */}
      {input.trim() ? (
        <>
          <p className="sp-src__hint">Coverage (optional. Leave blank to add unassigned):</p>
          <SourceAssignmentPicker
            follows={props.follows}
            competitionsByKey={props.competitionsByKey}
            teamsByCompetition={props.teamsByCompetition}
            selected={new Set(selectedTargets.keys())}
            onToggle={toggleTarget}
            disabled={busy}
            idPrefix="sp-addsource-assign"
          />
        </>
      ) : null}
      {errorMessage ? <SourceError>{errorMessage}</SourceError> : null}

      {preview?.status === "ok" && preview.candidate ? (
        <div
          ref={candidateRef}
          className="sp-src__candidate jds-card jds-card--sunken jds-card--pad-lg"
        >
          {preview.duplicateOfSourceId ? (
            <p className="sp-src__dupe" role="status">
              <CircleAlert size={16} aria-hidden="true" />
              <span>
                <b>Already added.</b> {preview.candidate.label} is one of your custom sources, so
                there is nothing to add. Edit its coverage in the list above instead.
              </span>
            </p>
          ) : null}
          <div className="sp-src__candidate-head">
            <SourceIcon
              logoUrl={
                preview.duplicateOfSourceId
                  ? sportsSourceIconUrl(preview.duplicateOfSourceId)
                  : null
              }
            />
            <p className="sp-src__candidate-label">{preview.candidate.label}</p>
            <span className="jds-badge jds-badge--neutral jds-badge--pill">Preview</span>
          </div>
          {preview.candidate.sampleHeadlines.length > 0 ? (
            <div className="sp-src__candidate-block">
              <p className="jds-eyebrow">Sample headlines</p>
              <ul className="sp-src__candidate-list">
                {preview.candidate.sampleHeadlines.map((headline) => (
                  <li key={headline}>{headline}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview.candidate.targets.length > 0 ? (
            <div className="sp-src__candidate-block">
              <p className="jds-eyebrow">Coverage</p>
              <ul className="sp-src__assignments" aria-label="Coverage">
                {preview.candidate.targets.map((target) => (
                  <li key={sportsSourceTargetKey(target.target)}>
                    <AssignmentIdentity
                      target={target.target}
                      label={target.label}
                      follows={props.follows}
                      teamsByCompetition={props.teamsByCompetition}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* Per-coverage sample headlines duplicated the block above; dropped (Ben, 2026-09-03). */}
          {preview.authorizationAcknowledgement && !preview.duplicateOfSourceId ? (
            <label className="jds-check sp-src__check">
              <input
                type="checkbox"
                checked={authorizationAccepted}
                disabled={busy}
                onChange={(event) => setAuthorizationAccepted(event.target.checked)}
              />
              <span className="jds-check__box">
                <Check size={13} aria-hidden="true" />
              </span>
              {preview.authorizationAcknowledgement}
            </label>
          ) : null}
          <div className="sp-src__addrow">
            {preview.duplicateOfSourceId ? null : (
              <Button size="sm" disabled={busy || !authorizationAccepted} onClick={confirm}>
                {confirmMutation.isPending ? "Adding…" : "Add this source"}
              </Button>
            )}
            <Button variant="secondary" size="sm" disabled={busy} onClick={reset}>
              {preview.duplicateOfSourceId ? "Close" : "Cancel"}
            </Button>
          </div>
        </div>
      ) : null}

      {added ? <Note>Source added.</Note> : null}
    </div>
  );
}

export function SportsSourcesSection(props: {
  follows: readonly SportsFollowDto[];
  competitionsByKey: Map<string, CompetitionRef>;
  teamsByCompetition: Map<string, readonly TeamRef[]>;
}) {
  const queryClient = useQueryClient();
  const sourcesQuery = useQuery({ queryKey: sportsQueryKeys.sources, queryFn: listSportsSources });
  const allSources = sourcesQuery.data?.sources ?? [];
  const espn = allSources.find(
    (source): source is SportsBuiltinSourceDto => source.kind === "builtin"
  );
  const sources = allSources.filter(
    (source): source is SportsCustomSourceDto & { readonly kind: "custom" } =>
      source.kind === "custom"
  );
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingSelection, setEditingSelection] = useState<
    Map<string, SportsSourceAssignmentTarget>
  >(new Map());
  const [assignmentPreview, setAssignmentPreview] = useState<{
    sourceId: string;
    result: Awaited<ReturnType<typeof previewSportsSourceAssignments>>;
  } | null>(null);
  const [assignmentAuthorizationAccepted, setAssignmentAuthorizationAccepted] = useState(false);
  const [recipePreview, setRecipePreview] = useState<{
    sourceId: string;
    result: Awaited<ReturnType<typeof previewSportsSourceRecipe>>;
  } | null>(null);
  const [recipeAuthorizationAccepted, setRecipeAuthorizationAccepted] = useState(false);
  // The add form stays out of the way until the user asks for it (Ben, 2026-09-03).
  const [addingSource, setAddingSource] = useState(false);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: sportsQueryKeys.sources });
  const espnMutation = useMutation({
    mutationFn: updateSportsEspnCoverage,
    onSuccess: () => {
      setEditingSourceId(null);
      invalidate();
    }
  });
  const removeMutation = useMutation({ mutationFn: deleteSportsSource, onSuccess: invalidate });
  const retryMutation = useMutation({ mutationFn: retrySportsSource, onSuccess: invalidate });
  const recipePreviewMutation = useMutation({
    mutationFn: previewSportsSourceRecipe,
    onSuccess: (result, sourceId) => {
      setRecipePreview({ sourceId, result });
      setRecipeAuthorizationAccepted(false);
    }
  });
  const recipeConfirmMutation = useMutation({
    mutationFn: (input: { id: string; request: Parameters<typeof confirmSportsSourceRecipe>[1] }) =>
      confirmSportsSourceRecipe(input.id, input.request),
    onSuccess: () => {
      setRecipePreview(null);
      setRecipeAuthorizationAccepted(false);
      invalidate();
    }
  });
  const assignmentPreviewMutation = useMutation({
    mutationFn: (input: { id: string; targets: readonly SportsSourceAssignmentTarget[] }) =>
      previewSportsSourceAssignments(input.id, {
        assignments: input.targets.map((target) => ({ target }))
      }),
    onSuccess: (result, input) => {
      setAssignmentPreview({ sourceId: input.id, result });
      setAssignmentAuthorizationAccepted(false);
    }
  });
  const assignmentConfirmMutation = useMutation({
    mutationFn: (input: {
      id: string;
      request: Parameters<typeof confirmSportsSourceAssignments>[1];
    }) => confirmSportsSourceAssignments(input.id, input.request),
    onSuccess: () => {
      setEditingSourceId(null);
      setAssignmentPreview(null);
      setAssignmentAuthorizationAccepted(false);
      invalidate();
    }
  });

  function startEditing(source: SportsCustomSourceDto) {
    setEditingSourceId(source.id);
    setEditingSelection(
      new Map(
        source.assignments.flatMap((assignment) => {
          const target: SportsSourceAssignmentTarget | null = assignment.sportKey
            ? { kind: "sport", sportKey: assignment.sportKey }
            : assignment.followId
              ? { kind: "follow", followId: assignment.followId }
              : null;
          return target ? [[sportsSourceTargetKey(target), target] as const] : [];
        })
      )
    );
    setAssignmentPreview(null);
    setAssignmentAuthorizationAccepted(false);
  }

  function startEditingEspn(source: SportsBuiltinSourceDto) {
    const targets = source.usesDefaultCoverage
      ? sportsSportOptions().map(({ key }) => ({ kind: "sport", sportKey: key }) as const)
      : source.assignments;
    setEditingSourceId(source.id);
    setEditingSelection(new Map(targets.map((target) => [sportsSourceTargetKey(target), target])));
    espnMutation.reset();
  }

  function toggleEditingTarget(target: SportsSourceAssignmentTarget) {
    setEditingSelection((current) => {
      const next = new Map(current);
      const key = sportsSourceTargetKey(target);
      if (next.has(key)) next.delete(key);
      else next.set(key, target);
      setAssignmentPreview(null);
      setAssignmentAuthorizationAccepted(false);
      return next;
    });
  }

  return (
    <section className="sp-src" aria-label="Sports news sources">
      <div className="sp-src__head">
        <h2 className="jds-section-title">News sources</h2>
        <p className="jds-section-sub">
          Choose which sports, leagues, and teams each source covers. Matching publishers are mixed
          together in Sports news.
        </p>
      </div>
      {sourcesQuery.isError ? (
        <SourceError>Could not load your sports news sources. Try again.</SourceError>
      ) : null}
      {sourcesQuery.isPending ? <Note>Loading sources…</Note> : null}
      {sourcesQuery.isSuccess && allSources.length > 0 ? (
        <ul className="sp-src__list">
          {espn ? (
            <li className="sp-src__item">
              <div className="sp-src__item-row">
                <div className="sp-src__identity">
                  <SourceIcon logoUrl={ESPN_LOGO_URL} />
                  <span className="sp-src__item-label">{espn.label}</span>
                  <Badge tone="steel">Built-in</Badge>
                </div>
                <div className="sp-src__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="Edit coverage for ESPN"
                    disabled={espnMutation.isPending}
                    onClick={() =>
                      editingSourceId === espn.id
                        ? setEditingSourceId(null)
                        : startEditingEspn(espn)
                    }
                  >
                    {editingSourceId === espn.id ? "Close" : "Edit coverage"}
                  </Button>
                </div>
              </div>
              <p className="sp-src__meta-line">
                {espn.usesDefaultCoverage
                  ? "Coverage: All sports"
                  : espn.enabled
                    ? `Coverage: ${espn.assignments
                        .map((target) =>
                          sourceTargetDisplayLabel(
                            target,
                            props.follows,
                            props.competitionsByKey,
                            props.teamsByCompetition
                          )
                        )
                        .join(", ")}`
                    : "Inactive for headlines."}
              </p>
              {editingSourceId === espn.id ? (
                <div className="sp-src__assign">
                  <SourceAssignmentPicker
                    follows={props.follows}
                    competitionsByKey={props.competitionsByKey}
                    teamsByCompetition={props.teamsByCompetition}
                    selected={new Set(editingSelection.keys())}
                    onToggle={toggleEditingTarget}
                    disabled={espnMutation.isPending}
                    idPrefix="sp-edit-espn"
                  />
                  <div className="sp-src__addrow">
                    <Button
                      size="sm"
                      disabled={espnMutation.isPending}
                      onClick={() =>
                        espnMutation.mutate({ assignments: [...editingSelection.values()] })
                      }
                    >
                      {espnMutation.isPending ? "Saving…" : "Save coverage"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={espnMutation.isPending}
                      onClick={() => setEditingSourceId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                  {espnMutation.isError ? (
                    <SourceError>Could not update ESPN coverage. Try again.</SourceError>
                  ) : null}
                </div>
              ) : null}
            </li>
          ) : null}
          {sources.map((source) => {
            const badge = HEALTH_BADGE[source.healthState];
            const editing = editingSourceId === source.id;
            const removing = removeMutation.isPending && removeMutation.variables === source.id;
            const retrying = retryMutation.isPending && retryMutation.variables === source.id;
            const rebuilding =
              recipePreviewMutation.isPending && recipePreviewMutation.variables === source.id;
            const recoveryBusy =
              removing || retrying || rebuilding || recipeConfirmMutation.isPending;
            const showRebuild =
              source.retrievalMethod === "scrape" &&
              (source.recipeStatus === "missing" ||
                source.recipeStatus === "drift" ||
                source.healthReasonCode === "recipe_drift");
            return (
              <li key={source.id} className="sp-src__item">
                <div className="sp-src__item-row">
                  <div className="sp-src__identity">
                    <SourceIcon logoUrl={sportsSourceIconUrl(source.id)} />
                    <span className="sp-src__item-label">{source.label}</span>
                    {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
                  </div>
                  <div className="sp-src__actions">
                    {source.healthState === "healthy" ? null : (
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Retry ${source.label}`}
                        disabled={recoveryBusy}
                        onClick={() => retryMutation.mutate(source.id)}
                      >
                        {retrying ? "Checking…" : "Retry"}
                      </Button>
                    )}
                    {showRebuild ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Rebuild ${source.label}`}
                        disabled={recoveryBusy}
                        onClick={() => recipePreviewMutation.mutate(source.id)}
                      >
                        {rebuilding ? "Checking…" : "Rebuild"}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Edit coverage for ${source.label}`}
                      disabled={recoveryBusy}
                      onClick={() => (editing ? setEditingSourceId(null) : startEditing(source))}
                    >
                      {editing ? "Close" : "Edit coverage"}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Remove ${source.label}`}
                      disabled={recoveryBusy}
                      onClick={() => removeMutation.mutate(source.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {source.healthMessage ? (
                  <p className="sp-src__health-message">{source.healthMessage}</p>
                ) : null}
                {source.healthState === "auth_required" ? (
                  <Note>
                    This publisher needs credentials. Authenticated sources are not supported yet.
                  </Note>
                ) : null}
                {source.assignments.length > 0 ? (
                  <ul className="sp-src__assignments" aria-label={`Coverage for ${source.label}`}>
                    {source.assignments.map((assignment) => {
                      const target: SportsSourceAssignmentTarget | null = assignment.sportKey
                        ? { kind: "sport", sportKey: assignment.sportKey }
                        : assignment.followId
                          ? { kind: "follow", followId: assignment.followId }
                          : null;
                      const targetLabel = target
                        ? sourceTargetDisplayLabel(
                            target,
                            props.follows,
                            props.competitionsByKey,
                            props.teamsByCompetition
                          )
                        : "Assigned team or league";
                      return (
                        <li key={assignment.id}>
                          {target ? (
                            <AssignmentIdentity
                              target={target}
                              label={targetLabel}
                              follows={props.follows}
                              teamsByCompetition={props.teamsByCompetition}
                            />
                          ) : (
                            <span className="sp-src__assignment-identity">{targetLabel}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {source.assignments.length === 0 ? (
                  <p className="sp-src__hint sp-src__hint--tight">Unassigned — not used yet.</p>
                ) : null}
                {recipePreview?.sourceId === source.id &&
                recipePreview.result.status === "ok" &&
                recipePreview.result.candidate &&
                recipePreview.result.confirmationId &&
                recipePreview.result.authorizationAcknowledgement ? (
                  <div className="sp-src__candidate">
                    <ul className="sp-src__assignments" aria-label="Rebuilt coverage">
                      {recipePreview.result.candidate.targets.map((target) => (
                        <li key={sportsSourceTargetKey(target.target)}>
                          <AssignmentIdentity
                            target={target.target}
                            label={target.label}
                            follows={props.follows}
                            teamsByCompetition={props.teamsByCompetition}
                          />
                        </li>
                      ))}
                    </ul>
                    <label className="jds-check sp-src__check">
                      <input
                        type="checkbox"
                        checked={recipeAuthorizationAccepted}
                        disabled={recipeConfirmMutation.isPending}
                        onChange={(event) => setRecipeAuthorizationAccepted(event.target.checked)}
                      />
                      <span className="jds-check__box">
                        <Check size={13} aria-hidden="true" />
                      </span>
                      {recipePreview.result.authorizationAcknowledgement}
                    </label>
                    <Button
                      size="sm"
                      disabled={!recipeAuthorizationAccepted || recipeConfirmMutation.isPending}
                      onClick={() => {
                        const result = recipePreview.result;
                        recipeConfirmMutation.mutate({
                          id: source.id,
                          request: {
                            confirmationId: result.confirmationId!,
                            authorizationAcknowledgement: result.authorizationAcknowledgement!,
                            canonicalDomain: result.candidate!.canonicalDomain,
                            confirmedFetchHosts: result.candidate!.confirmedFetchHosts,
                            targets: result.candidate!.targets.map((target) => ({
                              target: target.target,
                              targetUrl: target.targetUrl
                            }))
                          }
                        });
                      }}
                    >
                      {recipeConfirmMutation.isPending ? "Saving…" : "Confirm rebuild"}
                    </Button>
                  </div>
                ) : null}
                {recipePreview?.sourceId === source.id && recipePreview.result.status !== "ok" ? (
                  <SourceError>The source recipe could not be rebuilt.</SourceError>
                ) : null}
                {editing ? (
                  <div className="sp-src__assign">
                    <SourceAssignmentPicker
                      follows={props.follows}
                      competitionsByKey={props.competitionsByKey}
                      teamsByCompetition={props.teamsByCompetition}
                      selected={new Set(editingSelection.keys())}
                      onToggle={toggleEditingTarget}
                      disabled={
                        assignmentPreviewMutation.isPending || assignmentConfirmMutation.isPending
                      }
                      idPrefix={`sp-edit-${source.id}`}
                    />
                    <div className="sp-src__addrow">
                      <Button
                        size="sm"
                        disabled={
                          assignmentPreviewMutation.isPending || assignmentConfirmMutation.isPending
                        }
                        onClick={() =>
                          assignmentPreviewMutation.mutate({
                            id: source.id,
                            targets: [...editingSelection.values()]
                          })
                        }
                      >
                        {assignmentPreviewMutation.isPending ? "Checking…" : "Review changes"}
                      </Button>
                    </div>
                    {assignmentPreview?.sourceId === source.id &&
                    assignmentPreview.result.status === "ok" &&
                    assignmentPreview.result.candidate &&
                    assignmentPreview.result.confirmationId &&
                    assignmentPreview.result.authorizationAcknowledgement ? (
                      <div className="sp-src__candidate">
                        <ul className="sp-src__assignments" aria-label="Coverage after saving">
                          {assignmentPreview.result.candidate.targets.map((target) => (
                            <li key={sportsSourceTargetKey(target.target)}>
                              <AssignmentIdentity
                                target={target.target}
                                label={target.label}
                                follows={props.follows}
                                teamsByCompetition={props.teamsByCompetition}
                              />
                            </li>
                          ))}
                        </ul>
                        {assignmentPreview.result.candidate.targets.length === 0 ? (
                          <p className="sp-src__hint">This source will be left unassigned.</p>
                        ) : null}
                        <label className="jds-check sp-src__check">
                          <input
                            type="checkbox"
                            checked={assignmentAuthorizationAccepted}
                            disabled={assignmentConfirmMutation.isPending}
                            onChange={(event) =>
                              setAssignmentAuthorizationAccepted(event.target.checked)
                            }
                          />
                          <span className="jds-check__box">
                            <Check size={13} aria-hidden="true" />
                          </span>
                          {assignmentPreview.result.authorizationAcknowledgement}
                        </label>
                        <Button
                          size="sm"
                          disabled={
                            !assignmentAuthorizationAccepted || assignmentConfirmMutation.isPending
                          }
                          onClick={() => {
                            const result = assignmentPreview.result;
                            assignmentConfirmMutation.mutate({
                              id: source.id,
                              request: {
                                confirmationId: result.confirmationId!,
                                authorizationAcknowledgement: result.authorizationAcknowledgement!,
                                canonicalDomain: result.candidate!.canonicalDomain,
                                confirmedFetchHosts: result.candidate!.confirmedFetchHosts,
                                targets: result.candidate!.targets.map((target) => ({
                                  target: target.target,
                                  targetUrl: target.targetUrl
                                }))
                              }
                            });
                          }}
                        >
                          {assignmentConfirmMutation.isPending ? "Saving…" : "Save assignments"}
                        </Button>
                      </div>
                    ) : null}
                    {assignmentPreview?.sourceId === source.id &&
                    assignmentPreview.result.status !== "ok" ? (
                      <SourceError>
                        {assignmentPreviewFailureCopy(assignmentPreview.result)}
                      </SourceError>
                    ) : null}
                    {assignmentPreviewMutation.isError || assignmentConfirmMutation.isError ? (
                      <SourceError>Could not update assignments. Try again.</SourceError>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {sourcesQuery.isSuccess && sources.length === 0 ? <Note>No custom sources yet.</Note> : null}
      {removeMutation.isError ? (
        <SourceError>Could not remove that source. Try again.</SourceError>
      ) : null}
      {retryMutation.isError ? (
        <SourceError>Could not retry that source. Try again.</SourceError>
      ) : null}
      {recipePreviewMutation.isError || recipeConfirmMutation.isError ? (
        <SourceError>Could not rebuild that source. Try again.</SourceError>
      ) : null}
      <div className="sp-src__add-section">
        {addingSource ? (
          <>
            <div className="sp-src__add-head">
              <p className="sp-src__subheading">Add a source</p>
              <Button variant="secondary" size="sm" onClick={() => setAddingSource(false)}>
                Close
              </Button>
            </div>
            <AddSourceFlow
              follows={props.follows}
              competitionsByKey={props.competitionsByKey}
              teamsByCompetition={props.teamsByCompetition}
            />
          </>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAddingSource(true)}>
            <Plus size={14} aria-hidden="true" />
            Add a source
          </Button>
        )}
      </div>
    </section>
  );
}
