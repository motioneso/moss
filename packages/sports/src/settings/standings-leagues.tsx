import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { Note, Select } from "@moss/settings-ui";
import type { CompetitionRef } from "@moss/shared";
import { Button } from "@moss/module-web-sdk";
import { ChevronDown, ChevronRight } from "lucide-react";

import { sportsQueryKeys } from "../web/query-keys.js";
import {
  getSportsStandingsPreferences,
  updateSportsStandingsPreferences
} from "../web/sports-client.js";

export function StandingsLeaguesSection(props: {
  readonly competitions: readonly CompetitionRef[];
}) {
  const queryClient = useQueryClient();
  // Collapsed by default (Ben 2026-09-03): this is a rarely-touched preference, so it sits at the
  // bottom of the pane behind a header row and only opens on request.
  const [open, setOpen] = useState(false);
  const [availableHighlights, setAvailableHighlights] = useState<readonly string[]>([]);
  const [selectedHighlights, setSelectedHighlights] = useState<readonly string[]>([]);
  const preferencesQuery = useQuery({
    queryKey: sportsQueryKeys.standingsPreferences,
    queryFn: getSportsStandingsPreferences
  });
  const mutation = useMutation({
    mutationFn: (selectedCompetitionKeys: readonly string[]) =>
      updateSportsStandingsPreferences({ selectedCompetitionKeys }),
    onSuccess: (response) => {
      queryClient.setQueryData(sportsQueryKeys.standingsPreferences, response);
      setAvailableHighlights([]);
      setSelectedHighlights([]);
    }
  });
  const saved = preferencesQuery.data?.selectedCompetitionKeys;
  const selected = new Set(
    saved === null || saved === undefined
      ? props.competitions.map((competition) => competition.competitionKey)
      : saved
  );
  const availableCompetitions = props.competitions.filter(
    (competition) => !selected.has(competition.competitionKey)
  );
  const selectedCompetitions = props.competitions.filter((competition) =>
    selected.has(competition.competitionKey)
  );
  const readHighlights = (event: ChangeEvent<HTMLSelectElement>) =>
    Array.from(event.currentTarget.selectedOptions, (option) => option.value);
  const save = (next: ReadonlySet<string>) => {
    mutation.mutate(
      props.competitions
        .map((competition) => competition.competitionKey)
        .filter((key) => next.has(key))
    );
  };
  const add = () => save(new Set([...selected, ...availableHighlights]));
  const remove = () => {
    const next = new Set(selected);
    for (const competitionKey of selectedHighlights) next.delete(competitionKey);
    save(next);
  };
  const disabled = preferencesQuery.isPending || mutation.isPending;

  return (
    <section className="sp-standings-settings" aria-labelledby="sp-standings-settings-title">
      <div className="sp-standings-settings__head">
        <h2 className="jds-section-title" id="sp-standings-settings-title">
          <button
            type="button"
            className="sp-standings-settings__toggle"
            aria-expanded={open}
            aria-controls="sp-standings-settings-panel"
            onClick={() => setOpen((cur) => !cur)}
          >
            {open ? (
              <ChevronDown size={16} aria-hidden="true" />
            ) : (
              <ChevronRight size={16} aria-hidden="true" />
            )}
            <span>Standings leagues</span>
            <span className="jds-badge jds-badge--steel">
              {selectedCompetitions.length} of {props.competitions.length}
            </span>
          </button>
        </h2>
        <p className="jds-section-sub">
          Choose the leagues available in the Sports standings picker.
        </p>
        {!open && selectedCompetitions.length > 0 ? (
          <p className="sp-standings-settings__preview" aria-hidden="true">
            {selectedCompetitions.slice(0, 6).map((competition) => (
              <span className="jds-badge" key={competition.competitionKey}>
                {competition.label}
              </span>
            ))}
            {selectedCompetitions.length > 6 ? (
              <span className="jds-hint">+{selectedCompetitions.length - 6} more</span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div id="sp-standings-settings-panel" className="sp-standings-settings__panel" hidden={!open}>
        {preferencesQuery.isError ? (
          <Note>Could not load standings leagues. Try again.</Note>
        ) : null}
        {mutation.isError ? (
          <p role="alert">
            Could not save standings leagues. Your last saved selection is unchanged.
          </p>
        ) : null}
        <div
          className="sp-standings-transfer jds-card jds-card--sunken jds-card--pad-lg"
          role="group"
          aria-labelledby="sp-standings-settings-title"
          aria-disabled={disabled}
          aria-busy={mutation.isPending}
        >
          <div className="sp-standings-transfer__column">
            <label className="jds-label" htmlFor="sp-standings-available">
              Available leagues
            </label>
            <Select
              id="sp-standings-available"
              aria-label="Available leagues"
              aria-describedby="sp-standings-available-count"
              multiple
              size={8}
              disabled={disabled}
              value={availableHighlights}
              onChange={(event) => setAvailableHighlights(readHighlights(event))}
            >
              <CompetitionOptions
                competitions={availableCompetitions}
                emptyLabel="All leagues selected"
              />
            </Select>
            <span className="jds-hint" id="sp-standings-available-count">
              {availableCompetitions.length} available
            </span>
          </div>
          <div className="sp-standings-transfer__actions">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Add selected leagues"
              disabled={disabled || availableHighlights.length === 0}
              onClick={add}
            >
              Add →
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Remove selected leagues"
              disabled={disabled || selectedHighlights.length === 0}
              onClick={remove}
            >
              ← Remove
            </Button>
          </div>
          <div className="sp-standings-transfer__column">
            <label className="jds-label" htmlFor="sp-standings-selected">
              Selected leagues
            </label>
            <Select
              id="sp-standings-selected"
              aria-label="Selected leagues"
              aria-describedby="sp-standings-selected-count"
              multiple
              size={8}
              disabled={disabled}
              value={selectedHighlights}
              onChange={(event) => setSelectedHighlights(readHighlights(event))}
            >
              <CompetitionOptions
                competitions={selectedCompetitions}
                emptyLabel="No leagues selected"
              />
            </Select>
            <span className="jds-hint" id="sp-standings-selected-count">
              {selectedCompetitions.length} selected
            </span>
          </div>
          {mutation.isPending ? (
            <span className="jds-hint sp-standings-transfer__status" role="status">
              Saving league choices…
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CompetitionOptions(props: {
  readonly competitions: readonly CompetitionRef[];
  readonly emptyLabel: string;
}) {
  if (props.competitions.length === 0) return <option disabled>{props.emptyLabel}</option>;
  const groups = new Map<string, CompetitionRef[]>();
  for (const competition of props.competitions) {
    const label = competition.regionLabel
      ? `${competition.sportLabel} — ${competition.regionLabel}`
      : competition.sportLabel;
    const group = groups.get(label) ?? [];
    group.push(competition);
    groups.set(label, group);
  }
  return Array.from(groups, ([label, competitions]) => (
    <optgroup label={label} key={label}>
      {competitions.map((competition) => (
        <option value={competition.competitionKey} key={competition.competitionKey}>
          {competition.label}
        </option>
      ))}
    </optgroup>
  ));
}
