import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Plus, RefreshCw, Save, X } from "lucide-react";

import {
  acceptCandidate,
  archivePerson,
  createPerson,
  getPeopleNotesSettings,
  listMatchCandidates,
  listPeople,
  putPeopleNotesSettings,
  refreshPeopleNotes,
  rejectCandidate,
  updatePerson,
  type MatchCandidateDto,
  type PeopleNotesRefreshResponse
} from "../api/people-client";
import { listSourceBehaviors, putSourceBehavior } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import { useFeedback } from "./settings-feedback";
import {
  findSourceBehaviorEnabled,
  peopleNotesSourceBehaviors,
  writeSourceBehaviorCache
} from "./settings-source-behaviors";
import { readError } from "./settings-types";
import { Badge, Group, Note, Row, Switch } from "./settings-ui";
import { Button } from "@moss/ui";
import { VaultChooser } from "./settings-vault-chooser";

function candidateKindLabel(kind: MatchCandidateDto["candidateKind"]): string {
  switch (kind) {
    case "create_person":
      return "New person";
    case "link_identity":
      return "Link identity";
    case "merge_people":
      return "Merge people";
    case "split_identity":
      return "Split identity";
  }
}

const DESTRUCTIVE_KINDS: ReadonlySet<MatchCandidateDto["candidateKind"]> = new Set([
  "merge_people",
  "split_identity"
]);

export function getPeopleRefreshGuidance(result: PeopleNotesRefreshResponse): string[] {
  const guidance: string[] = [];
  if (result.discovered === 0) guidance.push("Choose another folder or add a person manually.");
  if (result.ignored > 0) guidance.push("Ignored files need valid People-note frontmatter.");
  return guidance;
}

export function SettingsPeoplePane() {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const assistantName = useAssistantName();
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [refreshResult, setRefreshResult] = useState<Awaited<
    ReturnType<typeof refreshPeopleNotes>
  > | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

  const candidatesQuery = useQuery({
    queryKey: queryKeys.people.matchCandidates,
    queryFn: listMatchCandidates,
    retry: false
  });

  const peopleQuery = useQuery({
    queryKey: queryKeys.people.list,
    queryFn: () => listPeople({ limit: 50 }),
    retry: false
  });

  const notesSettingsQuery = useQuery({
    queryKey: queryKeys.people.notesSettings,
    queryFn: getPeopleNotesSettings,
    retry: false
  });

  const sourceBehaviorsQuery = useQuery({
    queryKey: queryKeys.settings.sourceBehaviors,
    queryFn: listSourceBehaviors,
    retry: false
  });

  const sourceBehaviorMutation = useMutation({
    mutationFn: (input: { readonly id: string; readonly enabled: boolean }) =>
      putSourceBehavior(input.id, { enabled: input.enabled }),
    onSuccess: (data) => writeSourceBehaviorCache(queryClient, data),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const acceptMutation = useMutation({
    mutationFn: (id: string) => acceptCandidate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.people.matchCandidates }),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => rejectCandidate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.people.matchCandidates }),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const saveFolderMutation = useMutation({
    mutationFn: (folder: string | null) => putPeopleNotesSettings({ folder }),
    onMutate: () => setRefreshResult(null),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.people.notesSettings, data);
      toast(data.folder ? `People folder set to ${data.folder}.` : "People folder cleared.");
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshPeopleNotes(),
    onMutate: () => setRefreshResult(null),
    onSuccess: (data) => {
      setRefreshResult(data);
      queryClient.invalidateQueries({ queryKey: queryKeys.people.list });
      queryClient.invalidateQueries({ queryKey: queryKeys.people.matchCandidates });
      toast(`Projected ${data.projected}; ${data.candidates} review candidates.`);
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createPerson({
        displayName: createName.trim(),
        emails: createEmail.trim() ? [createEmail.trim()] : undefined
      }),
    onSuccess: () => {
      setCreateName("");
      setCreateEmail("");
      queryClient.invalidateQueries({ queryKey: queryKeys.people.list });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; displayName: string }) =>
      updatePerson(input.id, { displayName: input.displayName }),
    onSuccess: () => {
      setEditingId(null);
      setEditingName("");
      queryClient.invalidateQueries({ queryKey: queryKeys.people.list });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archivePerson(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.people.list }),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const candidates = candidatesQuery.data?.candidates ?? [];
  const pending = candidates.filter((c) => c.status === "pending");
  const people = peopleQuery.data?.people ?? [];
  const configuredFolder = notesSettingsQuery.data?.folder ?? null;
  const folderValue = configuredFolder ?? "";

  if (choosingFolder) {
    return (
      <VaultChooser
        title="Choose a People folder"
        backLabel="People"
        current={folderValue}
        onCancel={() => setChoosingFolder(false)}
        onChoose={(folder) => {
          refreshMutation.reset();
          setChoosingFolder(false);
          saveFolderMutation.mutate(folder);
        }}
      />
    );
  }

  return (
    <>
      <Group title="People notes">
        <Row
          name="Folder"
          desc={
            configuredFolder ? `Notes folder: ${configuredFolder}` : "No People folder configured."
          }
          control={
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>{folderValue || "No folder selected"}</span>
              <Button variant="quiet" size="sm" onClick={() => setChoosingFolder(true)}>
                Choose folder
              </Button>
              {configuredFolder ? (
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={saveFolderMutation.isPending}
                  onClick={() => {
                    refreshMutation.reset();
                    saveFolderMutation.mutate(null);
                  }}
                >
                  Clear folder
                </Button>
              ) : null}
            </span>
          }
        />
        {refreshResult ? (
          <div role="status">
            <Note>
              Discovered {refreshResult.discovered}; projected {refreshResult.projected}; ignored{" "}
              {refreshResult.ignored}; candidates {refreshResult.candidates}.{" "}
              {getPeopleRefreshGuidance(refreshResult).join(" ")}
              {refreshResult.candidates > 0 ? (
                <Button variant="quiet" size="sm" onClick={() => reviewRef.current?.focus()}>
                  Review matches
                </Button>
              ) : null}
            </Note>
          </div>
        ) : null}
        {refreshMutation.error ? (
          <Note>
            This People folder is unavailable. Choose another folder or clear it.{" "}
            <Button variant="quiet" size="sm" onClick={() => setChoosingFolder(true)}>
              Choose another folder
            </Button>
            <Button
              variant="quiet"
              size="sm"
              disabled={saveFolderMutation.isPending}
              onClick={() => {
                refreshMutation.reset();
                saveFolderMutation.mutate(null);
              }}
            >
              Clear folder
            </Button>
          </Note>
        ) : null}
        <Row
          name="Refresh from notes"
          desc="Scan the configured folder and update projected People records."
          control={
            <Button
              variant="quiet"
              size="sm"
              disabled={refreshMutation.isPending || !configuredFolder}
              onClick={() => refreshMutation.mutate()}
              title="Refresh"
              icon={<RefreshCw size={15} aria-hidden="true" />}
            />
          }
        />
        {peopleNotesSourceBehaviors(assistantName).map((behavior) => (
          <Row
            key={behavior.id}
            name={behavior.label}
            desc={behavior.description}
            control={
              <Switch
                ariaLabel={behavior.label}
                checked={findSourceBehaviorEnabled(
                  sourceBehaviorsQuery.data?.sources ?? [],
                  behavior.id
                )}
                disabled={sourceBehaviorMutation.isPending}
                onChange={(enabled) => sourceBehaviorMutation.mutate({ id: behavior.id, enabled })}
              />
            }
          />
        ))}
      </Group>

      <div ref={reviewRef} tabIndex={-1}>
        <Group title={`Review matches${pending.length > 0 ? ` (${pending.length})` : ""}`}>
          {pending.length === 0 ? (
            <Row name="Nothing to review" desc="All match candidates are up to date." />
          ) : (
            pending.map((candidate) => (
              <div key={candidate.id} style={{ borderBottom: "1px solid var(--border)" }}>
                {DESTRUCTIVE_KINDS.has(candidate.candidateKind) && (
                  <Note>This action is irreversible — confirm in chat before accepting.</Note>
                )}
                <Row
                  name={candidate.suggestedDisplayName ?? "Unnamed"}
                  desc={[candidateKindLabel(candidate.candidateKind), candidate.reasonSummary]
                    .filter(Boolean)
                    .join(" — ")}
                  control={
                    <span style={{ display: "flex", gap: 8 }}>
                      <Badge tone="neutral">{Math.round(candidate.confidence * 100)}%</Badge>
                      {!DESTRUCTIVE_KINDS.has(candidate.candidateKind) && (
                        <Button
                          variant="accentSoft"
                          size="sm"
                          disabled={acceptMutation.isPending}
                          onClick={() => acceptMutation.mutate(candidate.id)}
                        >
                          Accept
                        </Button>
                      )}
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={rejectMutation.isPending}
                        onClick={() => rejectMutation.mutate(candidate.id)}
                      >
                        Reject
                      </Button>
                    </span>
                  }
                />
              </div>
            ))
          )}
        </Group>
      </div>

      <Group title={`People${people.length > 0 ? ` (${people.length})` : ""}`}>
        {people.length === 0 ? (
          <Row
            name="No people yet"
            desc={`${assistantName} builds this list from your connected data sources.`}
          />
        ) : (
          people.map((person) => (
            <Row
              key={person.id}
              name={
                editingId === person.id ? (
                  <input
                    className="jds-input"
                    value={editingName}
                    aria-label="Display name"
                    onChange={(event) => setEditingName(event.target.value)}
                    style={{ width: 220 }}
                  />
                ) : (
                  person.displayName
                )
              }
              desc={person.relationshipSummary ?? person.contextSummary ?? undefined}
              control={
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Badge tone={person.status === "active" ? "forest" : "neutral"}>
                    {person.status}
                  </Badge>
                  {editingId === person.id ? (
                    <>
                      <Button
                        variant="accentSoft"
                        size="sm"
                        disabled={updateMutation.isPending || !editingName.trim()}
                        onClick={() =>
                          updateMutation.mutate({ id: person.id, displayName: editingName.trim() })
                        }
                        title="Save name"
                        icon={<Save size={15} aria-hidden="true" />}
                      />
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => setEditingId(null)}
                        title="Cancel"
                        icon={<X size={15} aria-hidden="true" />}
                      />
                    </>
                  ) : (
                    <>
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={!configuredFolder}
                        onClick={() => {
                          setEditingId(person.id);
                          setEditingName(person.displayName);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        disabled={archiveMutation.isPending || !configuredFolder}
                        onClick={() => archiveMutation.mutate(person.id)}
                        title="Archive"
                        icon={<Archive size={15} aria-hidden="true" />}
                      />
                    </>
                  )}
                </span>
              }
            />
          ))
        )}
      </Group>

      <Group title="Add a person manually">
        <Row
          name="Add a person manually"
          desc="Creates a canonical Markdown People note in the selected Moss folder."
          control={
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="jds-input"
                value={createName}
                placeholder="Name"
                aria-label="Person name"
                disabled={!configuredFolder}
                onChange={(event) => setCreateName(event.target.value)}
                style={{ width: 160 }}
              />
              <input
                className="jds-input"
                value={createEmail}
                placeholder="Email"
                aria-label="Person email"
                disabled={!configuredFolder}
                onChange={(event) => setCreateEmail(event.target.value)}
                style={{ width: 180 }}
              />
              <Button
                variant="accentSoft"
                size="sm"
                disabled={createMutation.isPending || !configuredFolder || !createName.trim()}
                onClick={() => createMutation.mutate()}
                title="Create person"
                icon={<Plus size={15} aria-hidden="true" />}
              />
            </span>
          }
        />
      </Group>
    </>
  );
}
