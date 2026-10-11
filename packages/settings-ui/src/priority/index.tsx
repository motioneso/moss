/** Priority settings: one local draft, saved through the existing priority DTO. */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { PriorityModelPreferenceV1, PriorityAnchor, PrioritySource } from "@moss/priority";
import { Button, IconButton } from "@moss/ui";
import { Badge, Field, Group, Note, PaneHead, Row, Select, Switch } from "../index.js";

const VISIBLE_SOURCES = ["tasks", "calendar", "email", "notes"] as const;
const VALID_WEIGHTS = [-2, -1, 0, 1, 2] as const;
const WEIGHT_LABELS = ["Much lower", "Lower", "Neutral", "Higher", "Much higher"] as const;

export function priorityWeightLabel(weight: PriorityAnchor["weight"]): string {
  return WEIGHT_LABELS[weight + 2] ?? "Neutral";
}

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sameDraft(a: PriorityModelPreferenceV1, b: PriorityModelPreferenceV1): boolean {
  const normalize = (model: PriorityModelPreferenceV1) => ({ ...model, updatedAt: "" });
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

export function priorityDraftValidation(model: PriorityModelPreferenceV1): string | null {
  return model.anchors.some((anchor) => !anchor.label.trim())
    ? "Give each priority a label before saving."
    : null;
}

export function prioritySourceIncluded(
  model: PriorityModelPreferenceV1,
  source: PrioritySource
): boolean {
  return !model.mutedSources.includes(source);
}

interface PrioritySettingsProps {
  readonly onError?: (message: string) => void;
  readonly onSuccess?: () => void;
}

export function PrioritySettings({ onError, onSuccess }: PrioritySettingsProps) {
  const queryClient = useQueryClient();
  const fieldId = useId();
  const {
    data: model,
    isLoading,
    isError,
    refetch
  } = useQuery<PriorityModelPreferenceV1>({
    queryKey: ["priority-model"],
    queryFn: async () => {
      const res = await fetch("/api/me/priority-model");
      if (!res.ok) throw new Error("Failed to fetch priority model");
      return res.json();
    }
  });
  const [draft, setDraft] = useState<PriorityModelPreferenceV1 | null>(model ?? null);
  const [saved, setSaved] = useState<PriorityModelPreferenceV1 | null>(model ?? null);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    if (model && !saved) {
      setDraft(model);
      setSaved(model);
    }
  }, [model, saved]);

  const mutation = useMutation({
    mutationFn: async (updated: PriorityModelPreferenceV1) => {
      const res = await fetch("/api/me/priority-model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save priority model");
      }
      return res.json() as Promise<PriorityModelPreferenceV1>;
    },
    onSuccess: (result) => {
      setDraft(result);
      setSaved(result);
      setValidation(null);
      queryClient.invalidateQueries({ queryKey: ["priority-model"] });
      onSuccess?.();
    },
    onError: (err) => onError?.(err instanceof Error ? err.message : "Unknown error")
  });

  if (isLoading) {
    return (
      <>
        <PaneHead title="Priorities" desc="Teach your assistant what deserves attention first." />
        <Group title="Priority model">
          <div role="status">
            <Row name="Loading priority settings" desc="Fetching your current priority model." />
          </div>
        </Group>
      </>
    );
  }
  if (!draft || !saved) {
    return (
      <>
        <PaneHead title="Priorities" desc="Teach your assistant what deserves attention first." />
        <Group title="Priority model">
          <div role="status">
            <Row
              name="Unavailable"
              desc="Failed to load priority settings."
              control={
                <Button variant="quiet" size="sm" onClick={() => void refetch()}>
                  Try again
                </Button>
              }
            />
          </div>
        </Group>
      </>
    );
  }

  const updateDraft = (updates: Partial<PriorityModelPreferenceV1>) =>
    setDraft((current) => (current ? { ...current, ...updates } : current));
  const updateAnchor = (index: number, updates: Partial<PriorityAnchor>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            anchors: current.anchors.map((anchor, i) =>
              i === index ? { ...anchor, ...updates } : anchor
            )
          }
        : current
    );
  const addAnchor = () =>
    setDraft((current) =>
      current
        ? {
            ...current,
            anchors: [
              ...current.anchors,
              {
                id: crypto.randomUUID(),
                kind: "project",
                label: "",
                aliases: [],
                weight: 1,
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }
            ]
          }
        : current
    );
  const save = () => {
    const error = priorityDraftValidation(draft);
    if (error) {
      setValidation(error);
      return;
    }
    mutation.mutate({ ...draft, updatedAt: new Date().toISOString() });
  };
  const dirty = !sameDraft(draft, saved);

  return (
    <>
      <PaneHead
        title="Priorities"
        desc="Tell your assistant what matters right now so it can rank work and signals usefully."
      />
      {isError ? (
        <div className="set2-read-state" role="status">
          <span>Could not refresh priority settings. Your current draft is still shown.</span>
          <Button variant="quiet" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      <Group
        title="Priority mode"
        desc="Choose the general way your assistant weighs deadlines and energy."
      >
        <Field label="Mode" controlId={`${fieldId}-mode`}>
          <Select
            id={`${fieldId}-mode`}
            value={draft.mode}
            aria-label="Priority mode"
            disabled={mutation.isPending}
            onChange={(event) =>
              updateDraft({ mode: event.currentTarget.value as PriorityModelPreferenceV1["mode"] })
            }
          >
            <option value="balanced">Balanced</option>
            <option value="deadline_first">Deadline first</option>
            <option value="energy_protective">Energy protective</option>
          </Select>
        </Field>
      </Group>
      <Group
        title="What matters right now"
        desc="Priorities your assistant should consistently move up or down."
        action={
          <Button
            type="button"
            onClick={addAnchor}
            variant="secondary"
            size="sm"
            disabled={mutation.isPending}
          >
            <Plus size={16} aria-hidden="true" /> Add priority
          </Button>
        }
      >
        {draft.anchors.length === 0 ? (
          <Row name="No priorities" desc="Add one when something deserves a standing bias." />
        ) : (
          draft.anchors.map((anchor, index) => (
            <div key={anchor.id} className="set-row">
              <div className="set-row__main">
                <div className="set-row__name">
                  {anchor.label || "Untitled priority"}{" "}
                  <Badge tone={anchor.enabled ? "pine" : "steel"}>
                    {anchor.enabled ? "Included" : "Muted"}
                  </Badge>
                </div>
                <div className="set-row__desc">
                  Set the importance your assistant should give this priority.
                </div>
                <div className="fld">
                  <div className="fld__row">
                    <Switch
                      ariaLabel={`Enable ${anchor.label || "priority"}`}
                      checked={anchor.enabled}
                      disabled={mutation.isPending}
                      onChange={(enabled) => updateAnchor(index, { enabled })}
                    />
                    <Select
                      value={anchor.weight}
                      aria-label="Importance"
                      disabled={mutation.isPending}
                      onChange={(event) =>
                        updateAnchor(index, {
                          weight: Number(event.currentTarget.value) as PriorityAnchor["weight"]
                        })
                      }
                    >
                      {VALID_WEIGHTS.map((weight) => (
                        <option key={weight} value={weight}>
                          {priorityWeightLabel(weight)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <Field label="What matters right now" controlId={`${fieldId}-${anchor.id}-label`}>
                  <input
                    id={`${fieldId}-${anchor.id}-label`}
                    autoFocus={anchor.label === ""}
                    className="jds-input"
                    type="text"
                    placeholder="e.g. Finish the launch plan"
                    value={anchor.label}
                    disabled={mutation.isPending}
                    onChange={(event) => updateAnchor(index, { label: event.currentTarget.value })}
                    maxLength={120}
                  />
                </Field>
                <Field label="Also match" controlId={`${fieldId}-${anchor.id}-aliases`}>
                  <input
                    className="jds-input"
                    type="text"
                    id={`${fieldId}-${anchor.id}-aliases`}
                    placeholder="Comma-separated aliases"
                    value={anchor.aliases.join(", ")}
                    disabled={mutation.isPending}
                    onChange={(event) =>
                      updateAnchor(index, {
                        aliases: event.currentTarget.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                </Field>
              </div>
              <div className="set-row__control">
                <IconButton
                  type="button"
                  onClick={() =>
                    setDraft((current) =>
                      current
                        ? { ...current, anchors: current.anchors.filter((_, i) => i !== index) }
                        : current
                    )
                  }
                  size="sm"
                  aria-label="Remove priority"
                  disabled={mutation.isPending}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </IconButton>
              </div>
            </div>
          ))
        )}
      </Group>
      <Group
        title="Sources your assistant may prioritize"
        desc="These choices affect ranking only; they do not change source access or data visibility."
      >
        {VISIBLE_SOURCES.map((source) => (
          <Row
            key={source}
            name={titleCase(source)}
            desc={
              prioritySourceIncluded(draft, source)
                ? "Included in priority ranking."
                : "Excluded from priority ranking."
            }
            control={
              <Switch
                ariaLabel={`Include ${source} in priority ranking`}
                checked={prioritySourceIncluded(draft, source)}
                disabled={mutation.isPending}
                onChange={(included) =>
                  updateDraft({
                    mutedSources: included
                      ? draft.mutedSources.filter((item) => item !== source)
                      : [...draft.mutedSources, source]
                  })
                }
              />
            }
          />
        ))}
      </Group>
      {validation ? (
        <div role="alert">
          <Note>{validation}</Note>
        </div>
      ) : null}
      {mutation.isPending ? (
        <div role="status">
          <Note>Saving priority settings...</Note>
        </div>
      ) : null}
      {mutation.error ? (
        <div role="alert">
          <Note>{mutation.error.message}</Note>
        </div>
      ) : null}
      {dirty ? (
        <div className="psona-save__acts">
          <Button type="button" size="sm" onClick={save} disabled={mutation.isPending}>
            Save priorities
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            onClick={() => {
              setDraft(saved);
              setValidation(null);
            }}
            disabled={mutation.isPending}
          >
            Discard
          </Button>
        </div>
      ) : null}
    </>
  );
}
