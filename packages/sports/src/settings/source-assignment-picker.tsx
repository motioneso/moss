import type {
  CompetitionRef,
  SportsFollowDto,
  SportsSourceAssignmentTarget,
  TeamRef
} from "@moss/shared";
import { Check } from "lucide-react";

import { SPORTS_SPORT_LABELS, sportsSourceTargetKey, sportsSportOptions } from "../source/scope.js";

export function followDisplayLabel(
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
    ?.find((candidate) => candidate.teamKey === follow.teamKey);
  return team?.shortName || team?.name || follow.teamKey || follow.competitionKey;
}

export function sourceTargetDisplayLabel(
  target: SportsSourceAssignmentTarget,
  follows: readonly SportsFollowDto[],
  competitionsByKey: Map<string, CompetitionRef>,
  teamsByCompetition: Map<string, readonly TeamRef[]>
): string {
  if (target.kind === "sport") return SPORTS_SPORT_LABELS[target.sportKey];
  const follow = follows.find((candidate) => candidate.id === target.followId);
  return follow
    ? followDisplayLabel(follow, competitionsByKey, teamsByCompetition)
    : "Unavailable team or league";
}

function AssignmentOption(props: {
  target: SportsSourceAssignmentTarget;
  label: string;
  selected: ReadonlySet<string>;
  onToggle: (target: SportsSourceAssignmentTarget) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const key = sportsSourceTargetKey(props.target);
  const inputId = `${props.idPrefix}-${key}`;
  return (
    <li className="sp-src__assign-item">
      <label className="jds-check sp-src__check" htmlFor={inputId}>
        <input
          type="checkbox"
          id={inputId}
          checked={props.selected.has(key)}
          disabled={props.disabled}
          onChange={() => props.onToggle(props.target)}
        />
        <span className="jds-check__box">
          <Check size={13} aria-hidden="true" />
        </span>
        {props.label}
      </label>
    </li>
  );
}

function AssignmentGroup(props: {
  label: string;
  emptyLabel?: string;
  options: readonly { target: SportsSourceAssignmentTarget; label: string }[];
  selected: ReadonlySet<string>;
  onToggle: (target: SportsSourceAssignmentTarget) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <fieldset className="sp-src__assign-group">
      <legend className="sp-src__assign-legend">{props.label}</legend>
      {props.options.length > 0 ? (
        <ul className="sp-src__assign-list">
          {props.options.map((option) => (
            <AssignmentOption
              key={sportsSourceTargetKey(option.target)}
              {...option}
              selected={props.selected}
              onToggle={props.onToggle}
              disabled={props.disabled}
              idPrefix={props.idPrefix}
            />
          ))}
        </ul>
      ) : (
        <p className="sp-src__hint sp-src__hint--tight">{props.emptyLabel}</p>
      )}
    </fieldset>
  );
}

export function SourceAssignmentPicker(props: {
  follows: readonly SportsFollowDto[];
  competitionsByKey: Map<string, CompetitionRef>;
  teamsByCompetition: Map<string, readonly TeamRef[]>;
  selected: ReadonlySet<string>;
  onToggle: (target: SportsSourceAssignmentTarget) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const leagues = props.follows.filter((follow) => follow.teamKey === null);
  const teams = props.follows.filter((follow) => follow.teamKey !== null);
  const followOptions = (follows: readonly SportsFollowDto[]) =>
    follows.map((follow) => ({
      target: { kind: "follow", followId: follow.id } as const,
      label: followDisplayLabel(follow, props.competitionsByKey, props.teamsByCompetition)
    }));

  return (
    <div className="sp-src__assign-groups">
      <AssignmentGroup
        label="Sports"
        options={sportsSportOptions().map(({ key, label }) => ({
          target: { kind: "sport", sportKey: key },
          label
        }))}
        selected={props.selected}
        onToggle={props.onToggle}
        disabled={props.disabled}
        idPrefix={`${props.idPrefix}-sport`}
      />
      <AssignmentGroup
        label="Leagues"
        emptyLabel="No followed leagues yet."
        options={followOptions(leagues)}
        selected={props.selected}
        onToggle={props.onToggle}
        disabled={props.disabled}
        idPrefix={`${props.idPrefix}-league`}
      />
      <AssignmentGroup
        label="Teams"
        emptyLabel="No followed teams yet."
        options={followOptions(teams)}
        selected={props.selected}
        onToggle={props.onToggle}
        disabled={props.disabled}
        idPrefix={`${props.idPrefix}-team`}
      />
    </div>
  );
}
