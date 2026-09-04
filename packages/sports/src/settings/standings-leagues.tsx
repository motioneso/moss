import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Note } from "@moss/settings-ui";
import type { CompetitionRef } from "@moss/shared";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

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
  const [expandedRegions, setExpandedRegions] = useState<ReadonlySet<string>>(new Set());
  const preferencesQuery = useQuery({
    queryKey: sportsQueryKeys.standingsPreferences,
    queryFn: getSportsStandingsPreferences
  });
  const mutation = useMutation({
    mutationFn: (selectedCompetitionKeys: readonly string[]) =>
      updateSportsStandingsPreferences({ selectedCompetitionKeys }),
    onSuccess: (response) => {
      queryClient.setQueryData(sportsQueryKeys.standingsPreferences, response);
    }
  });
  const saved = preferencesQuery.data?.selectedCompetitionKeys;
  const selected = new Set(
    saved === null || saved === undefined
      ? props.competitions.map((competition) => competition.competitionKey)
      : saved
  );
  const selectedCompetitions = props.competitions.filter((competition) =>
    selected.has(competition.competitionKey)
  );
  const save = (next: ReadonlySet<string>) => {
    mutation.mutate(
      props.competitions
        .map((competition) => competition.competitionKey)
        .filter((key) => next.has(key))
    );
  };
  const toggleLeague = (competitionKey: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(competitionKey);
    else next.delete(competitionKey);
    save(next);
  };
  const toggleRegion = (competitions: readonly CompetitionRef[], allChosen: boolean) => {
    const next = new Set(selected);
    for (const competition of competitions) {
      if (allChosen) next.delete(competition.competitionKey);
      else next.add(competition.competitionKey);
    }
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
            <span>Configure standings</span>
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
              <span
                className="jds-badge jds-badge--neutral jds-badge--pill"
                key={competition.competitionKey}
              >
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
          className="sp-standings-tree jds-card jds-card--sunken jds-card--pad-lg"
          role="group"
          aria-labelledby="sp-standings-settings-title"
          aria-disabled={disabled}
          aria-busy={mutation.isPending}
        >
          <div className="sp-standings-tree__toolbar">
            <button
              type="button"
              className="jds-btn jds-btn--secondary jds-btn--sm"
              disabled={disabled || selected.size === props.competitions.length}
              onClick={() =>
                save(new Set(props.competitions.map((competition) => competition.competitionKey)))
              }
            >
              Select all
            </button>
            <button
              type="button"
              className="jds-btn jds-btn--secondary jds-btn--sm"
              disabled={disabled || selected.size === 0}
              onClick={() => save(new Set())}
            >
              Clear all
            </button>
          </div>
          {groupCompetitions(props.competitions).map((sport) => {
            const sportCompetitions = [
              ...sport.leagues,
              ...sport.regions.flatMap((region) => region.competitions)
            ];
            const sportChosen = sportCompetitions.filter((competition) =>
              selected.has(competition.competitionKey)
            );
            const sportAll = sportChosen.length === sportCompetitions.length;
            return (
              <div className="sp-standings-tree__sport" key={sport.label}>
                <div className="sp-standings-tree__row">
                  <label className="jds-check sp-standings-tree__check">
                    <input
                      type="checkbox"
                      aria-label={`All ${sport.label} leagues`}
                      checked={sportAll}
                      disabled={disabled}
                      ref={(input) => {
                        if (input) input.indeterminate = sportChosen.length > 0 && !sportAll;
                      }}
                      onChange={() => toggleRegion(sportCompetitions, sportAll)}
                    />
                    <span className="jds-check__box">
                      <Check size={13} aria-hidden="true" />
                    </span>
                    <span className="sp-standings-tree__sport-label">{sport.label}</span>
                  </label>
                  <span className="jds-badge jds-badge--steel">
                    {sportChosen.length} of {sportCompetitions.length}
                  </span>
                </div>
                {sport.leagues.map((competition) => (
                  <LeagueCheck
                    competition={competition}
                    checked={selected.has(competition.competitionKey)}
                    disabled={disabled}
                    onToggle={toggleLeague}
                    key={competition.competitionKey}
                  />
                ))}
                {sport.regions.map((region) => {
                  const regionId = `sp-standings-region-${slug(sport.label)}-${slug(region.label)}`;
                  const chosen = region.competitions.filter((competition) =>
                    selected.has(competition.competitionKey)
                  );
                  const all = chosen.length === region.competitions.length;
                  const expanded = expandedRegions.has(regionId);
                  return (
                    <div className="sp-standings-tree__region" key={region.label}>
                      <div className="sp-standings-tree__row">
                        <label className="jds-check sp-standings-tree__check">
                          <input
                            type="checkbox"
                            aria-label={`All ${region.label} leagues`}
                            checked={all}
                            disabled={disabled}
                            ref={(input) => {
                              if (input) input.indeterminate = chosen.length > 0 && !all;
                            }}
                            onChange={() => toggleRegion(region.competitions, all)}
                          />
                          <span className="jds-check__box">
                            <Check size={13} aria-hidden="true" />
                          </span>
                        </label>
                        <button
                          type="button"
                          className="sp-standings-tree__toggle"
                          aria-expanded={expanded}
                          aria-controls={regionId}
                          onClick={() =>
                            setExpandedRegions((cur) => {
                              const next = new Set(cur);
                              if (next.has(regionId)) next.delete(regionId);
                              else next.add(regionId);
                              return next;
                            })
                          }
                        >
                          {expanded ? (
                            <ChevronDown size={16} aria-hidden="true" />
                          ) : (
                            <ChevronRight size={16} aria-hidden="true" />
                          )}
                          <span>{region.label}</span>
                          <span className="jds-badge jds-badge--steel">
                            {chosen.length} of {region.competitions.length}
                          </span>
                        </button>
                      </div>
                      <div id={regionId} className="sp-standings-tree__leagues" hidden={!expanded}>
                        {region.competitions.map((competition) => (
                          <LeagueCheck
                            competition={competition}
                            checked={selected.has(competition.competitionKey)}
                            disabled={disabled}
                            onToggle={toggleLeague}
                            key={competition.competitionKey}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {mutation.isPending ? (
            <span className="jds-hint" role="status">
              Saving league choices…
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function LeagueCheck(props: {
  readonly competition: CompetitionRef;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: (competitionKey: string, checked: boolean) => void;
}) {
  return (
    <label className="jds-check sp-standings-tree__check sp-standings-tree__league">
      <input
        type="checkbox"
        value={props.competition.competitionKey}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) =>
          props.onToggle(props.competition.competitionKey, event.currentTarget.checked)
        }
      />
      <span className="jds-check__box">
        <Check size={13} aria-hidden="true" />
      </span>
      <span>{props.competition.label}</span>
    </label>
  );
}

interface SportGroup {
  readonly label: string;
  // Leagues with no region (NFL, NBA, ...) list directly under the sport.
  readonly leagues: CompetitionRef[];
  // Soccer leagues sit under their country, collapsed until opened (Ben, 2026-09-03).
  readonly regions: { readonly label: string; readonly competitions: CompetitionRef[] }[];
}

function groupCompetitions(competitions: readonly CompetitionRef[]): SportGroup[] {
  const sports = new Map<string, SportGroup>();
  for (const competition of competitions) {
    const sport = sports.get(competition.sportLabel) ?? {
      label: competition.sportLabel,
      leagues: [],
      regions: []
    };
    if (competition.regionLabel === null) {
      sport.leagues.push(competition);
    } else {
      const region = sport.regions.find((entry) => entry.label === competition.regionLabel);
      if (region) region.competitions.push(competition);
      else sport.regions.push({ label: competition.regionLabel, competitions: [competition] });
    }
    sports.set(competition.sportLabel, sport);
  }
  return Array.from(sports.values());
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
