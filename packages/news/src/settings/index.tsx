import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Newspaper, Plus } from "lucide-react";
import { Badge, formatTimestamp, Note, PaneHead } from "@moss/settings-ui";
import { Button } from "@moss/module-web-sdk";
import type {
  NewsCatalogSource,
  NewsSourceCredentialStatusDto,
  NewsPersonalizationAvailabilityDto,
  NewsPrefDto,
  NewsPrefKind,
  NewsTopicKey,
  NewsTopicOption
} from "@moss/shared";

import {
  normalizePublisherDomain,
  publisherDomainMatches,
  type PublisherDomainRejection
} from "../personalization-domain.js";
import {
  createNewsPref,
  createNewsSourceExclusion,
  deleteNewsCustomSource,
  deleteNewsPref,
  deleteNewsSourceExclusion,
  getNewsCatalog,
  getNewsPersonalization,
  listNewsPrefs,
  listNewsSourceCredentials,
  revokeNewsSourceCredential,
  triggerNewsRevalidation
} from "../web/news-client.js";
import { newsQueryKeys } from "../web/query-keys.js";
import { AddSourceFlow } from "./add-source.js";
import { ConnectPublisherForm, credentialStatusBadge } from "./connect-publisher.js";
import { DescribeTopics, PrereqGate } from "./describe-topics.js";
import { StoryFeedbackSettings } from "./story-feedback.js";
import "./news-settings.css";

/* #2008: how long a "key saved" or "access revoked" confirmation stays on screen before it
   clears itself. Long enough to read twice, short enough that it cannot be mistaken for the
   result of something done much later. */
const KEY_NOTICE_VISIBLE_MS = 8000;

/* ----- Pure toggle planners (unit-tested). These must mirror the server's
   resolveEffectivePrefs semantics exactly: base = explicit `source` includes when any exist,
   otherwise the catalog defaults; `source_exclude` always subtracts from the base. ----- */

export type PrefOp =
  | { readonly op: "create"; readonly kind: NewsPrefKind; readonly key: string }
  | { readonly op: "delete"; readonly id: string };

/**
 * The planners only read identity + default membership, so they take a structural pick rather
 * than the full API DTO — lets unit tests feed the server-side catalog entries directly (#897).
 */
export type PlannerSource = Pick<NewsCatalogSource, "sourceKey" | "defaultEnabled">;

/** Is this source effective under the current pref rows? (client mirror of the server rule) */
export function sourceEnabled(source: PlannerSource, prefs: readonly NewsPrefDto[]): boolean {
  const includes = prefs.filter((pref) => pref.kind === "source");
  const excluded = prefs.some(
    (pref) => pref.kind === "source_exclude" && pref.key === source.sourceKey
  );
  const inBase =
    includes.length > 0
      ? includes.some((pref) => pref.key === source.sourceKey)
      : source.defaultEnabled;
  return inBase && !excluded;
}

/**
 * Ordered pref mutations that flip one source on/off without disturbing the rest of the
 * user's effective set. The traps this encodes:
 *
 * - Turning ON a non-default source while the user has NO explicit includes: creating that
 *   first `source` row silently flips the base from "catalog defaults" to "includes only",
 *   which would drop every default source. So we FIRST pin the current effective set as
 *   explicit includes, THEN add the toggled source.
 * - Turning OFF the user's only include: deleting that row would flip the base back to
 *   catalog defaults, re-enabling sources the user never asked for. So we exclude instead
 *   of deleting (exclude always wins), leaving the pinned base intact.
 */
export function planSourceToggle(
  sourceKey: string,
  sources: readonly PlannerSource[],
  prefs: readonly NewsPrefDto[]
): readonly PrefOp[] {
  const source = sources.find((entry) => entry.sourceKey === sourceKey);
  if (!source) return [];
  const includes = prefs.filter((pref) => pref.kind === "source");
  const includeRow = includes.find((pref) => pref.key === sourceKey);
  const excludeRow = prefs.find((pref) => pref.kind === "source_exclude" && pref.key === sourceKey);
  const excludedKeys = new Set(
    prefs.filter((pref) => pref.kind === "source_exclude").map((pref) => pref.key)
  );

  if (sourceEnabled(source, prefs)) {
    // OFF. Deleting the include is the tidy path, but only when other includes keep the
    // base pinned; otherwise exclude (see doc comment above).
    if (includeRow && includes.length > 1) return [{ op: "delete", id: includeRow.id }];
    return [{ op: "create", kind: "source_exclude", key: sourceKey }];
  }

  // ON: lift any exclusion, then make sure the base actually contains the source.
  const ops: PrefOp[] = [];
  if (excludeRow) ops.push({ op: "delete", id: excludeRow.id });
  const inBase = includes.length > 0 ? includeRow !== undefined : source.defaultEnabled;
  if (!inBase) {
    if (includes.length === 0) {
      // Pin today's effective defaults before the first include flips base semantics.
      for (const other of sources) {
        if (other.sourceKey === sourceKey) continue;
        if (other.defaultEnabled && !excludedKeys.has(other.sourceKey)) {
          ops.push({ op: "create", kind: "source", key: other.sourceKey });
        }
      }
    }
    ops.push({ op: "create", kind: "source", key: sourceKey });
  }
  return ops;
}

/**
 * #953 Task 5: domain exclusions override the curated On/Off vocabulary. A curated tile whose
 * publisher homepage falls under an excluded domain renders "excluded" (not contributing)
 * regardless of the V1 pref rows — the server suppresses that source before fetch (two-layer
 * filtering in NewsService), so showing "On" would be a lie.
 */
export type CuratedTileState = "on" | "off" | "excluded";

export function curatedTileState(
  source: Pick<NewsCatalogSource, "sourceKey" | "defaultEnabled" | "homepageUrl">,
  prefs: readonly NewsPrefDto[],
  excludedDomains: readonly string[]
): CuratedTileState {
  const normalized = normalizePublisherDomain(source.homepageUrl);
  if (
    normalized.ok &&
    excludedDomains.some((domain) => publisherDomainMatches(domain, normalized.domain))
  ) {
    return "excluded";
  }
  return sourceEnabled(source, prefs) ? "on" : "off";
}

/**
 * UI copy per rejection key from `normalizePublisherDomain`. The Record is exhaustive by
 * type — adding a rejection key without copy is a compile error. Keys are stable machine
 * identifiers (the POST route 400s carry the same keys, never the raw input), so this map is
 * the single place raw reasons become human sentences.
 */
const EXCLUSION_REJECTION_COPY: Record<PublisherDomainRejection, string> = {
  empty: "Enter a publisher domain or HTTPS link.",
  input_too_long: "That input is too long to be a web address.",
  unparseable: "That doesn't look like a web address.",
  non_https_scheme: "Only HTTPS links or bare domains are accepted.",
  credentials: "Web addresses with embedded credentials aren't accepted.",
  explicit_port: "Web addresses with an explicit port aren't accepted.",
  ip_literal: "IP addresses aren't accepted — use the publisher's domain name.",
  single_label: "Enter a full domain, like example.com.",
  hostname_too_long: "That domain name is too long.",
  invalid_label: "That domain name contains characters that aren't allowed."
};

export function exclusionRejectionMessage(reason: PublisherDomainRejection): string {
  return EXCLUSION_REJECTION_COPY[reason];
}

/** Topic chips are simple membership rows: one `topic` pref per followed topic. */
export function planTopicToggle(
  topicKey: NewsTopicKey,
  prefs: readonly NewsPrefDto[]
): readonly PrefOp[] {
  const row = prefs.find((pref) => pref.kind === "topic" && pref.key === topicKey);
  if (row) return [{ op: "delete", id: row.id }];
  return [{ op: "create", kind: "topic", key: topicKey }];
}

async function runOps(ops: readonly PrefOp[]): Promise<void> {
  // Sequential on purpose: the planner's op order is load-bearing (pin includes before
  // adding the first one), and the server's create is idempotent so retries are safe.
  for (const op of ops) {
    if (op.op === "create") await createNewsPref({ kind: op.kind, key: op.key });
    else await deleteNewsPref(op.id);
  }
}

/**
 * #2008: "last checked" for a connected publisher, using the settings-wide timestamp helper.
 * A missing or unreadable timestamp shows nothing rather than "Invalid Date" next to a key.
 */
export function lastCheckedLabel(isoTimestamp: string | null): string | null {
  if (!isoTimestamp) return null;
  const formatted = formatTimestamp(isoTimestamp, "");
  return formatted ? `Last checked ${formatted}` : null;
}

function SourceIcon() {
  return (
    <span className="nw-set__item-icon" aria-hidden="true">
      <Newspaper size={16} />
    </span>
  );
}

function sourceHealthBadge(source: {
  readonly validationStatus: "approved" | "needs_revalidation" | "rejected";
  readonly healthStatus:
    | "healthy"
    | "authentication_failed"
    | "temporarily_unavailable"
    | "disabled"
    | "unsupported";
}) {
  if (source.validationStatus !== "approved") {
    return <Badge tone="amber">Needs revalidation</Badge>;
  }
  switch (source.healthStatus) {
    case "healthy":
      return <Badge tone="pine">Healthy</Badge>;
    case "authentication_failed":
      return <Badge tone="red">Key rejected</Badge>;
    case "temporarily_unavailable":
      return <Badge tone="amber">Temporarily unavailable</Badge>;
    case "disabled":
      return <Badge tone="neutral">Disabled</Badge>;
    case "unsupported":
      return <Badge tone="amber">Unsupported</Badge>;
    default:
      return null;
  }
}

export default function NewsSettings() {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({ queryKey: newsQueryKeys.catalog, queryFn: getNewsCatalog });
  const prefsQuery = useQuery({ queryKey: newsQueryKeys.prefs, queryFn: listNewsPrefs });
  const personalizationQuery = useQuery({
    queryKey: newsQueryKeys.personalization,
    queryFn: getNewsPersonalization
  });

  const [addingSource, setAddingSource] = useState(false);
  const [exclusionInput, setExclusionInput] = useState("");
  const [exclusionValidation, setExclusionValidation] = useState<string | null>(null);

  const opsMutation = useMutation({
    mutationFn: runOps,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.prefs });
      // The front page recomposes from prefs server-side, so its cache is stale too.
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.overview });
    }
  });

  // Personalization writes (exclusions, custom sources/topics) reshape both the pane AND the
  // composed front page (server drops/adds publishers pre-fetch), so both caches must refetch.
  const invalidateAfterPersonalizationChange = () => {
    void queryClient.invalidateQueries({ queryKey: newsQueryKeys.personalization });
    void queryClient.invalidateQueries({ queryKey: newsQueryKeys.overview });
  };
  const addExclusionMutation = useMutation({
    mutationFn: createNewsSourceExclusion,
    onSuccess: () => {
      setExclusionInput("");
      invalidateAfterPersonalizationChange();
    }
  });
  const removeExclusionMutation = useMutation({
    mutationFn: deleteNewsSourceExclusion,
    onSuccess: invalidateAfterPersonalizationChange
  });

  // --- #975 Task 9: custom source removal and revalidation retry ---
  const removeSourceMutation = useMutation({
    mutationFn: deleteNewsCustomSource,
    onSuccess: invalidateAfterPersonalizationChange
  });
  // Owner-wide re-check; no cache invalidation on success — the job runs async and statuses
  // only change after the worker finishes, so an immediate refetch would show nothing new.
  const revalidateMutation = useMutation({ mutationFn: triggerNewsRevalidation });

  // --- #2008: publisher keys. Status only; this route never returns key material. ---
  const credentialsQuery = useQuery({
    queryKey: newsQueryKeys.credentials,
    queryFn: listNewsSourceCredentials
  });
  // Which source is mid-flow. Only one at a time, so a key typed for one publisher can never
  // be left sitting in a form that is now pointing at a different one.
  const [replacingSourceId, setReplacingSourceId] = useState<string | null>(null);
  const [revokingSourceId, setRevokingSourceId] = useState<string | null>(null);
  // What the route said after a key was saved or revoked. Shown here rather than inside the
  // key form, which closes the moment the request succeeds.
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  // The confirmation clears itself after a few seconds. Nothing else on this pane retires it -
  // it used to sit there until somebody happened to open a key form again, so a "Connected"
  // sentence from ten minutes ago read as if it had just happened.
  useEffect(() => {
    if (!keyNotice) return;
    const timer = setTimeout(() => setKeyNotice(null), KEY_NOTICE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [keyNotice]);
  const revokeCredentialMutation = useMutation({
    mutationFn: revokeNewsSourceCredential,
    onSuccess: (result) => {
      setRevokingSourceId(null);
      setKeyNotice(result.message);
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.credentials });
      invalidateAfterPersonalizationChange();
    }
  });

  const sources = catalogQuery.data?.sources ?? [];
  const topics = catalogQuery.data?.topics ?? [];
  const prefs = prefsQuery.data?.prefs ?? [];
  const personalization = personalizationQuery.data ?? null;
  const availability: NewsPersonalizationAvailabilityDto | null =
    personalization?.availability ?? null;
  const customSources = personalization?.customSources ?? [];
  // A source with no row here is an ordinary public publication and shows no key controls.
  const credentialBySourceId = new Map<string, NewsSourceCredentialStatusDto>(
    (credentialsQuery.data?.credentials ?? []).map((entry) => [entry.sourceId, entry])
  );

  const customTopics = personalization?.customTopics ?? [];
  const exclusions = personalization?.sourceExclusions ?? [];
  const personalizationReady = personalizationQuery.isSuccess;
  const personalizationStatus = personalizationQuery.isPending
    ? "Loading personalized news settings…"
    : personalizationQuery.isError
      ? "Could not load personalized news settings. Try again."
      : null;
  const excludedDomains = exclusions.map((exclusion) => exclusion.canonicalDomain);
  const followedTopics = new Set(
    prefs.filter((pref) => pref.kind === "topic").map((pref) => pref.key)
  );
  const pending = catalogQuery.isLoading || prefsQuery.isLoading || opsMutation.isPending;
  const error = catalogQuery.isError || prefsQuery.isError || opsMutation.isError;

  const tileStates = new Map(
    sources.map((source) => [source.sourceKey, curatedTileState(source, prefs, excludedDomains)])
  );
  const enabledCount = sources.filter((source) => tileStates.get(source.sourceKey) === "on").length;
  const anyTileExcluded = sources.some((source) => tileStates.get(source.sourceKey) === "excluded");

  function submitExclusion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Client-side pre-validation for instant feedback only — the route re-normalizes and is
    // the actual gate (its 400s carry reason keys, never the raw input).
    const normalized = normalizePublisherDomain(exclusionInput);
    if (!normalized.ok) {
      setExclusionValidation(exclusionRejectionMessage(normalized.reason));
      return;
    }
    setExclusionValidation(null);
    addExclusionMutation.mutate({ source: exclusionInput.trim() });
  }

  const exclusionError =
    exclusionValidation ??
    (addExclusionMutation.isError
      ? (addExclusionMutation.error?.message ?? "Could not exclude that publisher.")
      : null);

  const topicsNeedAttention = customTopics.some((topic) => topic.validationStatus !== "approved");
  const sourcesNeedAttention = customSources.some(
    (source) => source.validationStatus !== "approved" || source.healthStatus !== "healthy"
  );

  // One owner-wide revalidation job covers sources AND topics, but the button renders inside
  // whichever section is actually showing amber/red badges so the action sits next to the
  // problem it fixes. Both sections may show it; either click queues the same job.
  const retryRow = () => (
    <div className="nw-set__addrow">
      <Button
        variant="secondary"
        size="sm"
        disabled={revalidateMutation.isPending}
        onClick={() => revalidateMutation.mutate()}
      >
        {revalidateMutation.isPending ? "Queuing…" : "Retry validation"}
      </Button>
      {revalidateMutation.isSuccess ? (
        <span className="nw-set__gate" role="status">
          Revalidation queued — statuses update after the next check.
        </span>
      ) : null}
      {revalidateMutation.isError ? (
        <span className="nw-set__exerr" role="alert">
          Could not queue revalidation. Try again.
        </span>
      ) : null}
    </div>
  );

  const renderCustomSourceRow = (source: (typeof customSources)[number]) => {
    const removing = removeSourceMutation.isPending && removeSourceMutation.variables === source.id;
    // #2008: present only for a source that was connected with a key.
    const credential = credentialBySourceId.get(source.id);
    const badge = credential ? credentialStatusBadge(credential.status) : null;
    const checked = credential ? lastCheckedLabel(credential.lastValidatedAt) : null;
    const isUnhealthy = source.validationStatus !== "approved" || source.healthStatus !== "healthy";

    return (
      <li key={source.id} className="nw-set__item">
        <div className="nw-set__item-row">
          <div className="nw-set__identity">
            <SourceIcon />
            <span className="nw-set__item-label">{source.label}</span>
            <span className="nw-set__item-meta">{source.canonicalDomain}</span>
            {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
            {checked ? <span className="nw-set__item-meta">{checked}</span> : null}
            {sourceHealthBadge(source)}
          </div>
          <div className="nw-set__actions">
            {isUnhealthy ? (
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Retry ${source.label}`}
                disabled={revalidateMutation.isPending}
                onClick={() => revalidateMutation.mutate()}
              >
                {revalidateMutation.isPending ? "Queuing…" : "Retry"}
              </Button>
            ) : null}
            {credential ? (
              <>
                {/* Offered only when News still knows where this publisher's key is
                    sent. Without that, the form could not honestly say where a new key
                    would go, and the route would refuse it anyway. */}
                {credential.requestHost ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Replace key for ${source.label}`}
                    disabled={replacingSourceId === source.id}
                    onClick={() => {
                      setRevokingSourceId(null);
                      setKeyNotice(null);
                      setReplacingSourceId(source.id);
                    }}
                  >
                    Replace key
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Revoke access for ${source.label}`}
                  disabled={revokeCredentialMutation.isPending}
                  onClick={() => {
                    setReplacingSourceId(null);
                    setKeyNotice(null);
                    setRevokingSourceId(source.id);
                  }}
                >
                  Revoke access
                </Button>
              </>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Remove ${source.label}`}
              disabled={removing}
              onClick={() => removeSourceMutation.mutate(source.id)}
            >
              Remove
            </Button>
          </div>
        </div>
        {credential && revokingSourceId === source.id ? (
          // Revoking silently stops this source delivering, so it is confirmed once
          // rather than done on a single click.
          <span className="nw-set__addrow" role="group">
            <span className="nw-set__hint">
              Revoke access for {source.label}? News will stop using this key.
            </span>
            <Button
              size="sm"
              disabled={revokeCredentialMutation.isPending}
              onClick={() => revokeCredentialMutation.mutate(source.id)}
            >
              {revokeCredentialMutation.isPending ? "Revoking…" : "Yes, revoke"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setRevokingSourceId(null)}>
              Keep it
            </Button>
          </span>
        ) : null}
        {credential && credential.requestHost && replacingSourceId === source.id ? (
          <ConnectPublisherForm
            offer={{
              connectionId: credential.connectionId,
              publisherName: credential.publisherName,
              // The reviewed connection's own request host, reported by the route.
              // Never the stored publication domain: the sentence above the box is a
              // promise about where a secret goes, so it is built from the request.
              requestHost: credential.requestHost,
              accessSummary:
                "Replacing the key keeps this source in your feed. The old key stops working.",
              termsUrl: null
            }}
            mode={{ kind: "replace", sourceId: source.id }}
            onDone={(message) => {
              setReplacingSourceId(null);
              setKeyNotice(message);
            }}
            onCancel={() => setReplacingSourceId(null)}
          />
        ) : null}
      </li>
    );
  };

  return (
    <>
      <PaneHead
        title="News"
        desc="Pick the publications your front page draws from, and optionally narrow it to the topics you follow. These choices also shape news in briefings."
      />

      <section className="nw-set" aria-label="Topics">
        <div className="nw-set__head">
          <h2 className="jds-section-title">Topics</h2>
          <p className="jds-section-sub">
            Follow desks from your publications or describe interests and exclusions across the web.
          </p>
        </div>

        <div className="nw-set__group">
          <div className="nw-set__group-head">
            <h3 className="nw-set__subheading">
              <span>Topics from your publications</span>
              {topics.length > 0 ? <Badge tone="neutral">{topics.length}</Badge> : null}
            </h3>
          </div>
          <p className="nw-set__hint">
            Narrow your enabled publications to these desks. With none followed you get each
            publication&rsquo;s general front page.
          </p>
          <div className="nw-set__chips">
            {topics.map((topic: NewsTopicOption) => {
              const active = followedTopics.has(topic.topicKey);
              return (
                <button
                  key={topic.topicKey}
                  type="button"
                  className={`nw-settopic${active ? " is-active" : ""}`}
                  disabled={pending}
                  aria-pressed={active}
                  onClick={() => opsMutation.mutate(planTopicToggle(topic.topicKey, prefs))}
                >
                  {topic.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="nw-set__group">
          <div className="nw-set__group-head">
            <h3 className="nw-set__subheading">
              <span>Topics across the web</span>
              {customTopics.length > 0 ? <Badge tone="neutral">{customTopics.length}</Badge> : null}
            </h3>
          </div>
          <p className="nw-set__hint">
            Freeform topics in your own words, including guidance on what to include or leave out.
          </p>
          {availability ? (
            <p className="nw-set__prereq">
              <Badge tone={availability.aiConfigured ? "pine" : "amber"} dot>
                AI model {availability.aiConfigured ? "ready" : "needed"}
              </Badge>
              <Badge tone={availability.webSearchConfigured ? "pine" : "amber"} dot>
                Web search {availability.webSearchConfigured ? "ready" : "needed"}
              </Badge>
            </p>
          ) : null}
          {personalizationReady ? (
            <DescribeTopics
              customTopics={customTopics}
              availability={availability}
              needsAttention={topicsNeedAttention}
              retryRow={retryRow}
            />
          ) : null}
        </div>
      </section>

      <section className="nw-set" aria-label="Publishers">
        <div className="nw-set__head">
          <h2 className="jds-section-title">Publishers</h2>
          <p className="jds-section-sub">
            Choose built-in publications, connect accounts, add your own, or exclude domains.
          </p>
        </div>

        {personalizationStatus ? <Note>{personalizationStatus}</Note> : null}

        <div className="nw-set__group">
          <div className="nw-set__group-head">
            <h3 className="nw-set__subheading">
              <span>Built-in publications</span>
              <Badge tone="neutral">{sources.length}</Badge>
            </h3>
          </div>
          <div className="nw-set__grid">
            {sources.map((source) => {
              const state = tileStates.get(source.sourceKey) ?? "off";
              // An excluded tile is inert: its V1 toggle would silently do nothing (the server
              // suppresses the domain pre-fetch), so it renders disabled + "Excluded" instead
              // of a fake On/Off.
              const excluded = state === "excluded";
              const active = state === "on";
              return (
                <button
                  key={source.sourceKey}
                  type="button"
                  className={`nw-setsrc${active ? " is-active" : ""}${excluded ? " is-excluded" : ""}`}
                  disabled={pending || excluded}
                  aria-pressed={active}
                  onClick={() =>
                    opsMutation.mutate(planSourceToggle(source.sourceKey, sources, prefs))
                  }
                >
                  <span className="nw-setsrc__name">{source.label}</span>
                  <span className="nw-setsrc__state">
                    {excluded ? "Excluded" : active ? "On" : "Off"}
                  </span>
                </button>
              );
            })}
          </div>
          {anyTileExcluded ? (
            <Note>
              Excluded publishers override these toggles — manage them under Excluded publishers
              below.
            </Note>
          ) : null}
          {!pending && enabledCount === 0 ? (
            <Note>No sources enabled — your News page will be empty until you turn one on.</Note>
          ) : null}
        </div>

        {personalizationReady && customSources.length > 0 ? (
          <div className="nw-set__group">
            <div className="nw-set__group-head">
              <h3 className="nw-set__subheading">
                <span>Publications you add</span>
                <Badge tone="neutral">{customSources.length}</Badge>
              </h3>
            </div>
            <p className="nw-set__hint">
              Publications you add yourself, verified before they join your feed.
            </p>
            {availability ? (
              <p className="nw-set__prereq">
                <Badge tone={availability.aiConfigured ? "pine" : "amber"} dot>
                  AI model {availability.aiConfigured ? "ready" : "needed"}
                </Badge>
              </p>
            ) : null}
            <ul className="nw-set__list">{customSources.map(renderCustomSourceRow)}</ul>
          </div>
        ) : null}

        {/* #2008: what happened to a publisher key. The key form closes as soon as the request
            succeeds, so this is the only place a "Connected" sentence can actually be read. */}
        {keyNotice ? <Note>{keyNotice}</Note> : null}
        {personalizationReady && removeSourceMutation.isError ? (
          <Note>Could not remove that source. Try again.</Note>
        ) : null}
        {sourcesNeedAttention && revalidateMutation.isSuccess ? (
          <span className="nw-set__gate" role="status">
            Revalidation queued — statuses update after the next check.
          </span>
        ) : null}
        {sourcesNeedAttention && revalidateMutation.isError ? (
          <span className="nw-set__exerr" role="alert">
            Could not queue revalidation. Try again.
          </span>
        ) : null}

        <div className="nw-set__add-section">
          {addingSource ? (
            <>
              <div className="nw-set__add-head">
                <h3 className="nw-set__subheading">Add a source</h3>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-expanded={true}
                  onClick={() => setAddingSource(false)}
                >
                  Close
                </Button>
              </div>
              {availability?.customSourceByUrlEnabled ? (
                <AddSourceFlow />
              ) : (
                <div className="nw-set__addrow">
                  <Button variant="secondary" size="sm" disabled>
                    Add source
                  </Button>
                  {availability ? (
                    <PrereqGate requirement="Adding sources needs an AI model with structured output." />
                  ) : null}
                </div>
              )}
            </>
          ) : availability?.customSourceByUrlEnabled ? (
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={false}
              onClick={() => setAddingSource(true)}
            >
              <Plus size={14} aria-hidden="true" />
              Add a source
            </Button>
          ) : (
            <div className="nw-set__addrow">
              <Button variant="secondary" size="sm" disabled>
                Add source
              </Button>
              {availability ? (
                <PrereqGate requirement="Adding sources needs an AI model with structured output." />
              ) : null}
            </div>
          )}
        </div>

        <div className="nw-set__group">
          <div className="nw-set__group-head">
            <h3 className="nw-set__subheading">
              <span>Excluded publishers</span>
              <Badge tone="neutral">{exclusions.length}</Badge>
            </h3>
          </div>
          <p className="nw-set__hint">
            Excluded publishers never appear anywhere in News, Today, or briefings. Removing one
            returns it to neutral.
          </p>
          {personalizationReady ? (
            <form className="nw-set__exform" onSubmit={submitExclusion}>
              <label className="nw-set__exlabel" htmlFor="nw-exclusion-input">
                Publisher domain or HTTPS link
              </label>
              <div className="nw-set__exrow">
                <input
                  id="nw-exclusion-input"
                  className="jds-input"
                  type="text"
                  value={exclusionInput}
                  placeholder="example.com"
                  disabled={addExclusionMutation.isPending}
                  aria-describedby={exclusionError ? "nw-exclusion-error" : undefined}
                  onChange={(event) => {
                    setExclusionInput(event.target.value);
                    // Stale validation copy beside fresh input reads as a new failure — clear it.
                    setExclusionValidation(null);
                  }}
                />
                <Button type="submit" size="sm" disabled={addExclusionMutation.isPending}>
                  Add
                </Button>
              </div>
            </form>
          ) : null}
          {personalizationReady && exclusionError ? (
            <p id="nw-exclusion-error" className="nw-set__exerr" role="alert">
              {exclusionError}
            </p>
          ) : null}
          {personalizationReady && exclusions.length > 0 ? (
            <ul className="nw-set__list">
              {exclusions.map((exclusion) => {
                const removing =
                  removeExclusionMutation.isPending &&
                  removeExclusionMutation.variables === exclusion.id;
                return (
                  <li key={exclusion.id} className="nw-set__item">
                    <div className="nw-set__item-row">
                      <span className="nw-set__item-label">{exclusion.canonicalDomain}</span>
                      <div className="nw-set__actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`Remove ${exclusion.canonicalDomain}`}
                          disabled={removing}
                          onClick={() => removeExclusionMutation.mutate(exclusion.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {personalizationReady && removeExclusionMutation.isError ? (
            <Note>Could not remove that exclusion. Try again.</Note>
          ) : null}
        </div>
      </section>

      <StoryFeedbackSettings />

      {error ? <Note>Could not load or save news preferences. Try again.</Note> : null}
    </>
  );
}
