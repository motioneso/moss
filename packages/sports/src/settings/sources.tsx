import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Note } from "@moss/settings-ui";
import { ApiError, Button } from "@moss/module-web-sdk";
import type { CompetitionRef, SportsCustomSourceDto, SportsFollowDto, TeamRef } from "@moss/shared";

import {
  confirmSportsSourceAssignments,
  confirmSportsSource,
  deleteSportsSource,
  listSportsSources,
  previewSportsSourceAssignments,
  previewSportsSource
} from "../web/sports-client.js";
import { sportsQueryKeys } from "../web/query-keys.js";

/* #1572: custom public news sources by team and league. Mirrors News' add-source flow
   (packages/news/src/settings/add-source.tsx), simplified for Sports' single-candidate,
   URL-only preview (no name/web-search ambiguity) and extended with a follow-assignment
   picker, since a sports source is scoped to specific followed teams/leagues rather than
   contributing to one shared front page. */

const PREVIEW_REJECTION_COPY: Record<string, string> = {
  policy: "That publication isn't allowed by the content policy.",
  invalid_input: "That doesn't look like a publication we can check — try a homepage link.",
  unreachable: "We couldn't reach that site. Check the address and try again.",
  not_https: "Only HTTPS links or bare domains are accepted."
};

const HEALTH_BADGE: Record<
  SportsCustomSourceDto["healthState"],
  { tone: "neutral" | "pine" | "amber" | "red" | "steel"; label: string } | null
> = {
  pending: { tone: "steel", label: "Checking…" },
  healthy: null,
  failing: { tone: "amber", label: "Having trouble" },
  unsupported: { tone: "red", label: "Unsupported" },
  auth_required: { tone: "red", label: "Needs login" },
  disabled: { tone: "neutral", label: "Disabled" }
};

function followDisplayLabel(
  follow: SportsFollowDto,
  competitionsByKey: Map<string, CompetitionRef>,
  teamsByCompetition: Map<string, readonly TeamRef[]>
): string {
  const competition = competitionsByKey.get(follow.competitionKey);
  if (follow.teamKey === null) {
    return competition
      ? `All ${competition.label}`
      : `Unrecognized league (${follow.competitionKey})`;
  }
  const team = teamsByCompetition
    .get(follow.competitionKey)
    ?.find((t) => t.teamKey === follow.teamKey);
  return team?.shortName || team?.name || follow.teamKey || follow.competitionKey;
}

function FollowAssignmentPicker(props: {
  follows: readonly SportsFollowDto[];
  competitionsByKey: Map<string, CompetitionRef>;
  teamsByCompetition: Map<string, readonly TeamRef[]>;
  selected: ReadonlySet<string>;
  onToggle: (followId: string) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  if (props.follows.length === 0) {
    return <Note>Follow a team or league first to assign sources to it.</Note>;
  }
  return (
    <ul className="sp-src__assign-list">
      {props.follows.map((follow) => {
        const inputId = `${props.idPrefix}-${follow.id}`;
        return (
          <li key={follow.id} className="sp-src__assign-item">
            <input
              type="checkbox"
              id={inputId}
              checked={props.selected.has(follow.id)}
              disabled={props.disabled}
              onChange={() => props.onToggle(follow.id)}
            />
            <label htmlFor={inputId}>
              {followDisplayLabel(follow, props.competitionsByKey, props.teamsByCompetition)}
            </label>
          </li>
        );
      })}
    </ul>
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
  const [selectedFollowIds, setSelectedFollowIds] = useState<Set<string>>(new Set());
  const [exactTargetUrls, setExactTargetUrls] = useState<Map<string, string>>(new Map());
  const [authorizationAccepted, setAuthorizationAccepted] = useState(false);
  const [added, setAdded] = useState(false);

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
      setSelectedFollowIds(new Set());
      setExactTargetUrls(new Map());
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
      assignments: [...selectedFollowIds].map((followId) => ({
        followId,
        ...(exactTargetUrls.get(followId)?.trim()
          ? { exactTargetUrl: exactTargetUrls.get(followId)!.trim() }
          : {})
      }))
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
        followId: target.followId,
        targetUrl: target.targetUrl
      }))
    });
  }

  function reset() {
    setPreview(null);
    setSelectedFollowIds(new Set());
    setExactTargetUrls(new Map());
    setAuthorizationAccepted(false);
    confirmMutation.reset();
  }

  function toggleFollow(followId: string) {
    setSelectedFollowIds((current) => {
      const next = new Set(current);
      if (next.has(followId)) next.delete(followId);
      else next.add(followId);
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
            placeholder="theathletic.com"
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

      <p className="sp-src__hint">Assign to (optional — leave blank to add unassigned):</p>
      <FollowAssignmentPicker
        follows={props.follows}
        competitionsByKey={props.competitionsByKey}
        teamsByCompetition={props.teamsByCompetition}
        selected={selectedFollowIds}
        onToggle={toggleFollow}
        disabled={busy}
        idPrefix="sp-addsource-assign"
      />
      {[...selectedFollowIds].map((followId) => {
        const follow = props.follows.find((candidate) => candidate.id === followId);
        if (!follow) return null;
        const id = `sp-target-${followId}`;
        return (
          <label key={followId} className="sp-src__label" htmlFor={id}>
            Exact target URL for{" "}
            {followDisplayLabel(follow, props.competitionsByKey, props.teamsByCompetition)}{" "}
            (optional)
            <input
              id={id}
              className="jds-input"
              type="url"
              placeholder="https://publisher.example/team-or-league-news"
              value={exactTargetUrls.get(followId) ?? ""}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                setExactTargetUrls((current) => new Map(current).set(followId, value));
                setPreview(null);
                setAuthorizationAccepted(false);
              }}
            />
          </label>
        );
      })}

      {errorMessage ? (
        <p className="sp-src__err" role="alert">
          {errorMessage}
        </p>
      ) : null}

      {preview?.status === "ok" && preview.candidate ? (
        <div className="sp-src__candidate">
          {preview.duplicateOfSourceId ? (
            <Note>That publication is already one of your custom sources.</Note>
          ) : null}
          <p className="sp-src__candidate-label">{preview.candidate.label}</p>
          <p className="sp-src__item-meta">{preview.candidate.canonicalDomain}</p>
          <p className="sp-src__hint">
            Fetch hosts: {preview.candidate.confirmedFetchHosts.join(", ")}
          </p>
          {preview.candidate.sampleHeadlines.map((headline) => (
            <p key={headline} className="sp-src__hint">
              {headline}
            </p>
          ))}
          {preview.candidate.targets.map((target) => (
            <div key={target.followId}>
              <p className="sp-src__hint">
                {target.teamLabel ?? target.competitionLabel}: {target.targetUrl}
              </p>
              {target.sampleHeadlines.map((headline) => (
                <p key={headline} className="sp-src__hint">
                  {headline}
                </p>
              ))}
            </div>
          ))}
          {preview.authorizationAcknowledgement ? (
            <label className="sp-src__label">
              <input
                type="checkbox"
                checked={authorizationAccepted}
                disabled={busy}
                onChange={(event) => setAuthorizationAccepted(event.target.checked)}
              />{" "}
              {preview.authorizationAcknowledgement}
            </label>
          ) : null}
          <div className="sp-src__addrow">
            <Button
              size="sm"
              disabled={busy || !authorizationAccepted || Boolean(preview.duplicateOfSourceId)}
              onClick={confirm}
            >
              {confirmMutation.isPending ? "Adding…" : "Add this source"}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={reset}>
              Cancel
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
  const sources = sourcesQuery.data?.sources ?? [];
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingSelection, setEditingSelection] = useState<Set<string>>(new Set());
  const [assignmentPreview, setAssignmentPreview] = useState<{
    sourceId: string;
    result: Awaited<ReturnType<typeof previewSportsSourceAssignments>>;
  } | null>(null);
  const [assignmentAuthorizationAccepted, setAssignmentAuthorizationAccepted] = useState(false);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: sportsQueryKeys.sources });
  const removeMutation = useMutation({ mutationFn: deleteSportsSource, onSuccess: invalidate });
  const assignmentPreviewMutation = useMutation({
    mutationFn: (input: { id: string; followIds: readonly string[] }) =>
      previewSportsSourceAssignments(input.id, {
        assignments: input.followIds.map((followId) => ({ followId }))
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
    setEditingSelection(new Set(source.assignedFollowIds));
    setAssignmentPreview(null);
    setAssignmentAuthorizationAccepted(false);
  }

  function toggleEditingFollow(followId: string) {
    setEditingSelection((current) => {
      const next = new Set(current);
      if (next.has(followId)) next.delete(followId);
      else next.add(followId);
      setAssignmentPreview(null);
      setAssignmentAuthorizationAccepted(false);
      return next;
    });
  }

  return (
    <section className="sp-src" aria-label="Custom sports news sources">
      <p className="sp-src__kicker">Custom sources</p>
      <p className="sp-src__hint">
        Add your own public news sources for sports, and assign them to specific teams or leagues
        you follow.
      </p>
      {sourcesQuery.isError ? <Note>Could not load your custom sources. Try again.</Note> : null}
      {sourcesQuery.isSuccess && sources.length > 0 ? (
        <ul className="sp-src__list">
          {sources.map((source) => {
            const badge = HEALTH_BADGE[source.healthState];
            const editing = editingSourceId === source.id;
            const removing = removeMutation.isPending && removeMutation.variables === source.id;
            return (
              <li key={source.id} className="sp-src__item">
                <div className="sp-src__item-row">
                  <span className="sp-src__item-label">{source.label}</span>
                  <span className="sp-src__item-meta">{source.canonicalDomain}</span>
                  {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Edit teams for ${source.label}`}
                    disabled={removing}
                    onClick={() => (editing ? setEditingSourceId(null) : startEditing(source))}
                  >
                    {editing ? "Close" : "Edit teams"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Remove ${source.label}`}
                    disabled={removing}
                    onClick={() => removeMutation.mutate(source.id)}
                  >
                    Remove
                  </Button>
                </div>
                {source.assignedFollowIds.length === 0 ? (
                  <p className="sp-src__hint sp-src__hint--tight">Unassigned — not used yet.</p>
                ) : null}
                {editing ? (
                  <div className="sp-src__assign">
                    <FollowAssignmentPicker
                      follows={props.follows}
                      competitionsByKey={props.competitionsByKey}
                      teamsByCompetition={props.teamsByCompetition}
                      selected={editingSelection}
                      onToggle={toggleEditingFollow}
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
                            followIds: [...editingSelection]
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
                        {assignmentPreview.result.candidate.targets.map((target) => (
                          <p key={target.followId} className="sp-src__hint">
                            {target.teamLabel ?? target.competitionLabel}: {target.targetUrl}
                          </p>
                        ))}
                        {assignmentPreview.result.candidate.targets.length === 0 ? (
                          <p className="sp-src__hint">This source will be left unassigned.</p>
                        ) : null}
                        <label className="sp-src__label">
                          <input
                            type="checkbox"
                            checked={assignmentAuthorizationAccepted}
                            disabled={assignmentConfirmMutation.isPending}
                            onChange={(event) =>
                              setAssignmentAuthorizationAccepted(event.target.checked)
                            }
                          />{" "}
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
                                  followId: target.followId,
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
                      <Note>Those assignments could not be verified.</Note>
                    ) : null}
                    {assignmentPreviewMutation.isError || assignmentConfirmMutation.isError ? (
                      <Note>Could not update assignments. Try again.</Note>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {sourcesQuery.isSuccess && sources.length === 0 ? <Note>No custom sources yet.</Note> : null}
      {removeMutation.isError ? <Note>Could not remove that source. Try again.</Note> : null}
      <AddSourceFlow
        follows={props.follows}
        competitionsByKey={props.competitionsByKey}
        teamsByCompetition={props.teamsByCompetition}
      />
    </section>
  );
}
