import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, SectionHead } from "@moss/ui";
import {
  HEARTBEAT_SOURCES,
  type HeartbeatCadenceMinutes,
  type HeartbeatSettings,
  type HeartbeatSource
} from "@moss/shared";

import { ApiError } from "../api/client.js";
import { getHeartbeatSettings, putHeartbeatSettings } from "../api/client-heartbeat.js";
import { queryKeys } from "../api/query-keys.js";
import { Badge, Group, Note, Row, Segmented, Switch } from "./settings-ui.js";

const SOURCE_LABELS: Record<HeartbeatSource, { name: string; desc: string }> = {
  calendar: { name: "Calendar", desc: "Upcoming events and changes to them." },
  tasks: { name: "Tasks", desc: "Tasks that are due or overdue." },
  memory: { name: "Memory", desc: "Notes and facts Moss keeps about you." },
  sports: { name: "Sports", desc: "Games and results for teams you follow." },
  news: { name: "News", desc: "Stories you follow." }
};

interface Draft {
  readonly enabled: boolean;
  readonly cadenceMinutes: HeartbeatCadenceMinutes;
  readonly sources: Readonly<Record<HeartbeatSource, boolean>>;
}

function toDraft(settings: HeartbeatSettings): Draft {
  return {
    enabled: settings.enabled,
    cadenceMinutes: settings.cadenceMinutes,
    sources: settings.sources
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.enabled === b.enabled &&
    a.cadenceMinutes === b.cadenceMinutes &&
    HEARTBEAT_SOURCES.every((source) => a.sources[source] === b.sources[source])
  );
}

export function HeartbeatCard({ onOpenProfile }: { readonly onOpenProfile?: () => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.heartbeat.settings,
    queryFn: getHeartbeatSettings,
    retry: false
  });
  const saved = query.data?.settings;
  const readable = query.data?.readable ?? true;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState<{ readonly mine: Draft } | null>(null);

  useEffect(() => {
    if (saved && draft === null) setDraft(toDraft(saved));
  }, [saved, draft]);

  const save = useMutation({
    mutationFn: (input: { readonly draft: Draft; readonly revision: number }) =>
      putHeartbeatSettings({ ...input.draft, expectedRevision: input.revision }),
    onSuccess: (data) => {
      setConflict(null);
      setDraft(toDraft(data.settings));
      queryClient.setQueryData(queryKeys.heartbeat.settings, {
        settings: data.settings,
        readable: true
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.heartbeat.status });
    },
    onError: (error, input) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflict({ mine: input.draft });
        void query.refetch();
      }
    }
  });

  if (query.isPending) {
    return (
      <Group title="Moss check-ins" desc="Moss looks in on your day at regular intervals.">
        <p role="status">Loading check-in settings…</p>
      </Group>
    );
  }
  if (query.isError || !saved || !draft) {
    return (
      <Group title="Moss check-ins" desc="Moss looks in on your day at regular intervals.">
        <Note>
          Could not load check-in settings.{" "}
          <Button variant="link" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </Note>
      </Group>
    );
  }

  const dirty = !sameDraft(draft, toDraft(saved));
  const saving = save.isPending;
  const locked = !readable;
  const badge = locked ? (
    <Badge tone="amber">On hold</Badge>
  ) : saved.enabled ? (
    <Badge tone="forest" dot>
      On
    </Badge>
  ) : (
    <Badge tone="neutral">Off</Badge>
  );

  return (
    <Group
      title="Moss check-ins"
      desc="Moss looks in on your day at regular intervals and speaks up only when something matters."
      action={badge}
    >
      {locked ? (
        <Note>
          Your saved check-in settings could not be read, so check-ins are on hold. Saving new
          settings replaces them.
        </Note>
      ) : null}
      {saved.origin === "legacy_off" && !saved.enabled && !dirty ? (
        <Note>
          Check-ins started off because Proactive alerts were already off.{" "}
          <Button variant="link" size="sm" onClick={() => setDraft({ ...draft, enabled: true })}>
            Turn on
          </Button>
        </Note>
      ) : null}
      <Row
        name="Check in automatically"
        desc="Moss checks your sources on a schedule while this is on."
        control={
          <Switch
            ariaLabel="Check in automatically"
            checked={draft.enabled}
            disabled={saving}
            onChange={(next) => setDraft({ ...draft, enabled: next })}
          />
        }
      />
      <Row
        name="Frequency"
        desc="How often Moss checks."
        control={
          <Segmented<"30" | "60">
            ariaLabel="Frequency"
            value={String(draft.cadenceMinutes) as "30" | "60"}
            options={[
              { value: "30", label: "Every 30 minutes" },
              { value: "60", label: "Every hour" }
            ]}
            onChange={(next) => setDraft({ ...draft, cadenceMinutes: next === "30" ? 30 : 60 })}
          />
        }
      />
      <Row
        name="Time zone"
        desc="Check-ins follow your profile time zone."
        control={
          <Button variant="link" size="sm" onClick={onOpenProfile}>
            Change in Profile
          </Button>
        }
      />
      <SectionHead title="Sources" titleAs="h4" />
      {HEARTBEAT_SOURCES.map((source) => (
        <Row
          key={source}
          name={SOURCE_LABELS[source].name}
          desc={SOURCE_LABELS[source].desc}
          control={
            <Switch
              ariaLabel={SOURCE_LABELS[source].name}
              checked={draft.sources[source]}
              disabled={saving}
              onChange={(next) =>
                setDraft({ ...draft, sources: { ...draft.sources, [source]: next } })
              }
            />
          }
        />
      ))}
      {conflict ? (
        <Note>
          These settings changed in another tab or device, so nothing was saved.{" "}
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              setDraft(toDraft(saved));
              setConflict(null);
            }}
          >
            Use current settings
          </Button>{" "}
          <Button
            variant="link"
            size="sm"
            onClick={() => save.mutate({ draft: conflict.mine, revision: saved.revision })}
          >
            Save my edit
          </Button>
        </Note>
      ) : null}
      {save.isError && !conflict ? (
        <Note>
          Could not save check-in settings. Your draft is kept.{" "}
          <Button
            variant="link"
            size="sm"
            onClick={() => save.mutate({ draft, revision: saved.revision })}
          >
            Try again
          </Button>
        </Note>
      ) : null}
      {dirty ? (
        <div className="set-row__control">
          <Button
            disabled={saving}
            onClick={() => save.mutate({ draft, revision: saved.revision })}
          >
            Save
          </Button>
          <Button variant="quiet" disabled={saving} onClick={() => setDraft(toDraft(saved))}>
            Discard
          </Button>
        </div>
      ) : null}
    </Group>
  );
}
