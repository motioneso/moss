import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QuietHoursSettingsDto } from "@moss/shared";
import { Button, Combobox, type ComboboxOption } from "@moss/ui";
import { MoonStar } from "lucide-react";
import { useMemo, useState } from "react";

import {
  getLocaleSettings,
  getQuietHoursSettings,
  putQuietHoursSettings,
  resolveQuietHoursConflict
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import {
  isStaleQuietHoursSave,
  quietHoursDraftDirty,
  quietHoursDraftProblem,
  quietHoursSavedLine,
  quietHoursSaveFailure,
  quietHoursSaveRequest
} from "./settings-quiet-hours-draft.js";
import {
  quietHoursChoiceFailure,
  quietHoursChoiceNote,
  quietHoursChoiceRequest,
  quietHoursChoices,
  quietHoursChosenLine,
  type QuietHoursChoice
} from "./settings-quiet-hours-conflict.js";
import { TIME_ZONE_OPTIONS } from "./settings-time-zones.js";
import { readError } from "./settings-types.js";
import { Badge, Field, Group, Note, Row, Switch } from "./settings-ui.js";

const DEFAULT_QUIET_HOURS: QuietHoursSettingsDto = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  timezone: null
};

// Combobox values are strings; this one stands for a schedule that follows the profile zone.
const PROFILE_ZONE = "";

// A draft keeps the version it was built from; a refetch mid-draft must not move it.
type Draft = { readonly value: QuietHoursSettingsDto; readonly version: string | null };

type Feedback =
  | { readonly kind: "saved" }
  | { readonly kind: "chosen"; readonly text: string }
  | { readonly kind: "problem"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "choiceFailed"; readonly text: string; readonly retry: QuietHoursChoice };

/**
 * The one quiet-hours editor. Edits stay in a local draft until Save; the saved line always names
 * the stored schedule, so an unsaved or failed edit never reads as the schedule in force. While
 * saved schedules differ, the form gives way to a choice between them.
 */
export function QuietHoursEditor() {
  const queryClient = useQueryClient();
  const quietHoursQuery = useQuery({
    queryKey: queryKeys.settings.quietHours,
    queryFn: getQuietHoursSettings,
    retry: false
  });
  const localeQuery = useQuery({
    queryKey: queryKeys.settings.locale,
    queryFn: getLocaleSettings,
    retry: false
  });
  const loaded = quietHoursQuery.data;
  const saved = loaded?.quietHours ?? DEFAULT_QUIET_HOURS;
  const profileTimeZone = localeQuery.data?.locale.timezone ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const editing = draft?.value ?? saved;
  const dirty = draft !== null && quietHoursDraftDirty(saved, draft.value);

  // A draft that matches the stored schedule is spent; the next edit builds on the latest version.
  const draftVersion = dirty ? draft.version : (loaded?.version ?? null);

  const save = useMutation({
    // An offline save fails at once and keeps the draft, rather than waiting paused as "Saving".
    networkMode: "always",
    mutationFn: (next: Draft) =>
      putQuietHoursSettings(quietHoursSaveRequest(next.value, { version: next.version })),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.quietHours, data);
      setDraft(null);
      setFeedback({ kind: "saved" });
    },
    onError: (error) => {
      // A stale save lost to a newer stored schedule, so the editor shows that one. Any other
      // failure keeps the draft for Try again; the stored schedule is unchanged either way.
      if (isStaleQuietHoursSave(error)) {
        setDraft(null);
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.quietHours });
        setFeedback({ kind: "problem", text: quietHoursSaveFailure(error) });
        return;
      }
      setFeedback({ kind: "failed", text: quietHoursSaveFailure(error) });
    }
  });

  const resolve = useMutation({
    networkMode: "always",
    mutationFn: (chosen: QuietHoursChoice) =>
      resolveQuietHoursConflict(quietHoursChoiceRequest(chosen, loaded?.version ?? null)),
    onSuccess: (data, chosen) => {
      queryClient.setQueryData(queryKeys.settings.quietHours, data);
      setDraft(null);
      setFeedback({ kind: "chosen", text: quietHoursChosenLine(chosen) });
    },
    onError: (error, chosen) => {
      // Both schedules stay in force either way. A lost race shows the latest schedules; any
      // other failure keeps the offer and retries the same choice.
      if (isStaleQuietHoursSave(error)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.quietHours });
        setFeedback({ kind: "problem", text: quietHoursChoiceFailure(error) });
        return;
      }
      setFeedback({ kind: "choiceFailed", text: quietHoursChoiceFailure(error), retry: chosen });
    }
  });

  const held = quietHoursQuery.isLoading || quietHoursQuery.isError || save.isPending;
  const edit = (patch: Partial<QuietHoursSettingsDto>) => {
    setDraft({
      value: { ...editing, ...patch },
      version: draftVersion
    });
    setFeedback(null);
  };
  const submit = () => {
    const problem = quietHoursDraftProblem(editing);
    if (problem) {
      setFeedback({ kind: "problem", text: problem });
      return;
    }
    save.mutate({ value: editing, version: draftVersion });
  };

  const zoneOptions = useMemo<readonly ComboboxOption[]>(() => {
    const profileOption: ComboboxOption = {
      value: PROFILE_ZONE,
      label: profileTimeZone ? `Profile time zone (${profileTimeZone})` : "Profile time zone",
      keywords: "profile default"
    };
    const savedZone = saved.timezone;
    const savedMissing =
      savedZone !== null && !TIME_ZONE_OPTIONS.some((option) => option.value === savedZone);
    return [
      profileOption,
      ...(savedMissing ? [{ value: savedZone, label: savedZone }] : []),
      ...TIME_ZONE_OPTIONS
    ];
  }, [profileTimeZone, saved.timezone]);

  const choices = loaded ? quietHoursChoices(loaded) : [];
  const unreadable = loaded?.authority.status === "malformed";

  return (
    <Group title="Quiet hours" action={dirty ? <Badge>Unsaved changes</Badge> : undefined}>
      {quietHoursQuery.isLoading ? <p role="status">Loading quiet hours…</p> : null}
      {quietHoursQuery.isError ? (
        <Note icon={<MoonStar size={13} aria-hidden="true" />}>
          {readError(quietHoursQuery.error)}{" "}
          <Button variant="link" size="sm" onClick={() => void quietHoursQuery.refetch()}>
            Try again
          </Button>
        </Note>
      ) : null}
      {unreadable ? (
        <Note icon={<MoonStar size={13} aria-hidden="true" />}>
          Part of your saved quiet hours could not be read. Notifications follow the schedule below.
        </Note>
      ) : null}
      {choices.length > 0 ? (
        <>
          <Note icon={<MoonStar size={13} aria-hidden="true" />}>
            {quietHoursChoiceNote(choices)}
          </Note>
          <div className="quiet-hours__actions">
            {choices.map((option) => (
              <Button
                key={option.choice}
                variant="secondary"
                size="sm"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(option)}
              >
                {option.label}
              </Button>
            ))}
            {feedback?.kind === "choiceFailed" ? (
              <Button
                variant="link"
                size="sm"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(feedback.retry)}
              >
                Try again
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <Row
            name="Enable quiet hours"
            desc={loaded ? quietHoursSavedLine(loaded, profileTimeZone) : undefined}
            control={
              <Switch
                ariaLabel="Enable quiet hours"
                checked={editing.enabled}
                disabled={held}
                onChange={(enabled) => edit({ enabled })}
              />
            }
          />
          <div className="quiet-hours__times">
            <Field label="From">
              <input
                className="jds-input"
                type="time"
                required
                value={editing.start}
                aria-label="Quiet hours from"
                disabled={held}
                onChange={(event) => edit({ start: event.currentTarget.value })}
              />
            </Field>
            <Field label="Until" className="fld--no-border">
              <input
                className="jds-input"
                type="time"
                required
                value={editing.end}
                aria-label="Quiet hours until"
                disabled={held}
                onChange={(event) => edit({ end: event.currentTarget.value })}
              />
            </Field>
          </div>
          <Field label="Time zone">
            <Combobox
              value={editing.timezone ?? PROFILE_ZONE}
              aria-label="Quiet hours time zone"
              options={zoneOptions}
              disabled={held}
              searchPlaceholder="Search time zones"
              emptyText="No time zone matches."
              onChange={(value) => edit({ timezone: value === PROFILE_ZONE ? null : value })}
            />
          </Field>
          <div className="quiet-hours__actions">
            <Button variant="secondary" size="sm" disabled={held || !dirty} onClick={submit}>
              {save.isPending ? "Saving…" : "Save quiet hours"}
            </Button>
            {feedback?.kind === "failed" ? (
              <Button variant="link" size="sm" disabled={save.isPending} onClick={submit}>
                Try again
              </Button>
            ) : null}
          </div>
        </>
      )}
      {feedback ? (
        <p role="status" className="quiet-hours__status">
          {feedback.kind === "saved" ? "Quiet hours saved." : feedback.text}
        </p>
      ) : null}
    </Group>
  );
}
