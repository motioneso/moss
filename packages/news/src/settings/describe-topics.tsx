import { useState, type FormEvent, type ReactElement } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Tag } from "lucide-react";
import { Badge } from "@moss/settings-ui";
import { ApiError, Button } from "@moss/module-web-sdk";
import { Card } from "@moss/ui";
import type { NewsCustomTopicDto, NewsPersonalizationAvailabilityDto } from "@moss/shared";

import { createNewsTopic, deleteNewsTopic, updateNewsTopic } from "../web/news-client.js";
import { newsQueryKeys } from "../web/query-keys.js";

/* #990: extracted from settings/index.tsx so the "Topics across the web" add/edit/remove flow
   — and the #981 safe-copy mapping it shares between create and edit — stays under the
   1000-line file-size gate. Mirrors add-source.tsx's standalone-component shape. */

/**
 * Human copy for a failed topic create OR edit. 422/503 are the route's deliberate
 * policy/availability signals (fixed copy, never model output); other ApiErrors carry
 * friendly server messages (limit/duplicate) that are safe to surface verbatim. Shared by both
 * mutations because PATCH re-runs the same policy/availability checks as POST.
 */
export function topicCreateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 422) return "That topic isn't allowed by the content policy.";
    if (error.status === 503) {
      return "Topic checking is unavailable right now — try again shortly.";
    }
    if (error.message) return error.message;
  }
  return "Could not add that topic. Try again.";
}

/**
 * #975 Task 9 flipped the writes live, so this gate now renders ONLY when a prerequisite is
 * missing, pointing at AI providers settings. Relocated from index.tsx (#990) — also used there
 * for the "Publications you add" section, so it must stay exported.
 */
export function PrereqGate(props: { readonly requirement: string }) {
  return (
    <span className="nw-set__gate">
      {props.requirement}{" "}
      <a className="nw-set__gatelink" href="/settings?section=aiproviders">
        Set it up in AI providers
      </a>
      .
    </span>
  );
}

/** Maps a stored topic (or null for add-mode) to the form's controlled field values. */
export function describedTopicFormValues(topic: NewsCustomTopicDto | null): {
  readonly label: string;
  readonly guidance: string;
} {
  if (!topic) return { label: "", guidance: "" };
  return { label: topic.label, guidance: topic.guidance ?? "" };
}

export type DescribedTopicOperation = "create" | "edit";

const PENDING_COPY: Record<DescribedTopicOperation, string> = {
  create: "Checking topic…",
  edit: "Saving changes…"
};

export function describedTopicPendingMessage(operation: DescribedTopicOperation): string {
  return PENDING_COPY[operation];
}

const SUCCESS_COPY: Record<DescribedTopicOperation, string> = {
  create: "Topic added",
  edit: "Changes saved"
};

export function describedTopicSuccessMessage(operation: DescribedTopicOperation): string {
  return SUCCESS_COPY[operation];
}

export function describedTopicUpdateInput(id: string, label: string, guidance: string) {
  return { id, label: label.trim(), guidance: guidance.trim() };
}

export function DescribeTopics(props: {
  readonly customTopics: readonly NewsCustomTopicDto[];
  readonly availability: NewsPersonalizationAvailabilityDto | null;
  readonly needsAttention: boolean;
  readonly retryRow: () => ReactElement;
}) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: newsQueryKeys.personalization });
    void queryClient.invalidateQueries({ queryKey: newsQueryKeys.overview });
  };

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [guidance, setGuidance] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  function resetForm() {
    setAdding(false);
    setEditingId(null);
    setLabel("");
    setGuidance("");
  }

  const createMutation = useMutation({
    mutationFn: createNewsTopic,
    onSuccess: async () => {
      await refresh();
      resetForm();
      setStatusMessage(describedTopicSuccessMessage("create"));
    }
  });
  const updateMutation = useMutation({
    mutationFn: (input: { id: string; label: string; guidance?: string }) =>
      updateNewsTopic(input.id, { label: input.label, guidance: input.guidance }),
    onSuccess: async () => {
      await refresh();
      resetForm();
      setStatusMessage(describedTopicSuccessMessage("edit"));
    }
  });
  const removeMutation = useMutation({
    mutationFn: deleteNewsTopic,
    onSuccess: async () => {
      await refresh();
      setStatusMessage("Topic removed");
    }
  });

  const pending = createMutation.isPending || updateMutation.isPending;

  function startEdit(topic: NewsCustomTopicDto) {
    createMutation.reset();
    updateMutation.reset();
    setAdding(false);
    setEditingId(topic.id);
    const values = describedTopicFormValues(topic);
    setLabel(values.label);
    setGuidance(values.guidance);
    setStatusMessage(null);
  }

  function cancelEdit() {
    createMutation.reset();
    updateMutation.reset();
    resetForm();
    setStatusMessage(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;
    setStatusMessage(null);
    if (editingId) {
      updateMutation.mutate(describedTopicUpdateInput(editingId, label, guidance));
    } else {
      const trimmedGuidance = guidance.trim();
      createMutation.mutate(
        trimmedGuidance
          ? { label: trimmedLabel, guidance: trimmedGuidance }
          : { label: trimmedLabel }
      );
    }
  }

  const errorMessage = createMutation.isError
    ? topicCreateErrorMessage(createMutation.error)
    : updateMutation.isError
      ? topicCreateErrorMessage(updateMutation.error)
      : null;

  const pendingMessage = createMutation.isPending
    ? describedTopicPendingMessage("create")
    : updateMutation.isPending
      ? describedTopicPendingMessage("edit")
      : null;

  return (
    <>
      {props.customTopics.length > 0 ? (
        <ul className="nw-set__list">
          {props.customTopics.map((topic) => {
            const removing = removeMutation.isPending && removeMutation.variables === topic.id;
            return (
              <li key={topic.id} className="nw-set__item">
                <div className="nw-set__item-row">
                  <div className="nw-set__identity">
                    <span className="nw-set__item-icon" aria-hidden="true">
                      <Tag size={16} />
                    </span>
                    <span className="nw-set__item-label">{topic.label}</span>
                    {topic.guidance ? (
                      <span className="nw-set__item-meta">{topic.guidance}</span>
                    ) : null}
                    {topic.validationStatus !== "approved" ? (
                      <Badge tone="amber">Needs revalidation</Badge>
                    ) : null}
                  </div>
                  <div className="nw-set__actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Edit ${topic.label}`}
                      disabled={pending || removing}
                      onClick={() => startEdit(topic)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Remove ${topic.label}`}
                      disabled={pending || removing}
                      onClick={() => removeMutation.mutate(topic.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="nw-set__hint">News still uses your selected publications.</p>
      )}
      {removeMutation.isError ? (
        <p className="nw-set__exerr" role="alert">
          Could not remove that topic. Try again.
        </p>
      ) : null}
      {props.needsAttention ? props.retryRow() : null}
      {adding || editingId ? (
        <div className="nw-set__candidate">
          <Card sunken padding="lg">
            <div className="nw-set__add-head">
              <h4 className="nw-set__eyebrow">{editingId ? "Edit topic" : "Add a topic"}</h4>
              <Button variant="secondary" size="sm" aria-expanded={true} onClick={cancelEdit}>
                Close
              </Button>
            </div>
            <form className="nw-set__exform" onSubmit={submit}>
              <label className="nw-set__exlabel" htmlFor="nw-addtopic-label">
                Topic in your own words
              </label>
              <div className="nw-set__exrow">
                <input
                  id="nw-addtopic-label"
                  className="jds-input"
                  type="text"
                  value={label}
                  placeholder="mechanical watches"
                  disabled={pending}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setStatusMessage(null);
                  }}
                />
              </div>
              <label className="nw-set__exlabel" htmlFor="nw-addtopic-guidance">
                Optional guidance — what to include or leave out
              </label>
              <div className="nw-set__exrow">
                <input
                  id="nw-addtopic-guidance"
                  className="jds-input"
                  type="text"
                  value={guidance}
                  placeholder="not smartwatches"
                  disabled={pending}
                  onChange={(event) => {
                    setGuidance(event.target.value);
                    setStatusMessage(null);
                  }}
                />
                <Button type="submit" size="sm" disabled={pending || !label.trim()}>
                  {createMutation.isPending
                    ? "Checking…"
                    : updateMutation.isPending
                      ? "Saving…"
                      : editingId
                        ? "Save changes"
                        : "Add topic"}
                </Button>
                <Button variant="secondary" size="sm" disabled={pending} onClick={cancelEdit}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : props.availability?.freeformTopicsEnabled ? (
        <div className="nw-set__add-section">
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={false}
            onClick={() => {
              resetForm();
              setAdding(true);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            Add a topic
          </Button>
        </div>
      ) : (
        <div className="nw-set__addrow">
          <Button variant="secondary" size="sm" disabled>
            Add topic
          </Button>
          {props.availability ? (
            <PrereqGate requirement="Described topics need an AI model and web search." />
          ) : null}
        </div>
      )}
      {pendingMessage ? (
        <p className="nw-set__exstatus" role="status">
          {pendingMessage}
        </p>
      ) : null}
      {statusMessage ? (
        <p className="nw-set__exstatus is-success" role="status">
          {statusMessage}
        </p>
      ) : null}
      {errorMessage ? (
        <p className="nw-set__exerr" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </>
  );
}
