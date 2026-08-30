import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import type { CompetitionRef, SportsFollowDto } from "@moss/shared";

export interface StandingsPickerRegion {
  readonly label: string | null;
  readonly competitions: readonly CompetitionRef[];
}

export interface StandingsPickerGroup {
  readonly label: string;
  readonly regions: readonly StandingsPickerRegion[];
}

export interface StandingsPickerProps {
  readonly catalog: readonly CompetitionRef[];
  readonly follows: readonly SportsFollowDto[];
  readonly selectedCompetitionKeys: readonly string[] | null;
  readonly value: string;
  readonly onChange: (competitionKey: string) => void;
}

export function buildStandingsPickerGroups(
  catalog: readonly CompetitionRef[],
  follows: readonly SportsFollowDto[],
  selectedCompetitionKeys: readonly string[] | null
): readonly StandingsPickerGroup[] {
  const byKey = new Map(catalog.map((competition) => [competition.competitionKey, competition]));
  const followedKeys = Array.from(new Set(follows.map((follow) => follow.competitionKey))).filter(
    (key) => byKey.has(key)
  );
  const followed = new Set(followedKeys);
  const selected =
    selectedCompetitionKeys === null
      ? new Set(catalog.map((competition) => competition.competitionKey))
      : new Set(selectedCompetitionKeys.filter((key) => byKey.has(key)));
  const groups: StandingsPickerGroup[] = [];
  if (followedKeys.length > 0) {
    groups.push({
      label: "Following",
      regions: [
        {
          label: null,
          competitions: followedKeys.flatMap((key) => {
            const competition = byKey.get(key);
            return competition ? [competition] : [];
          })
        }
      ]
    });
  }
  const sports = new Map<string, Map<string | null, CompetitionRef[]>>();
  for (const competition of catalog) {
    if (followed.has(competition.competitionKey) || !selected.has(competition.competitionKey)) {
      continue;
    }
    const regions = sports.get(competition.sportLabel) ?? new Map();
    const entries = regions.get(competition.regionLabel) ?? [];
    entries.push(competition);
    regions.set(competition.regionLabel, entries);
    sports.set(competition.sportLabel, regions);
  }
  for (const [label, regions] of sports) {
    groups.push({
      label,
      regions: Array.from(regions, ([regionLabel, competitions]) => ({
        label: regionLabel,
        competitions
      }))
    });
  }
  return groups;
}

export function StandingsPicker(props: StandingsPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<HTMLButtonElement[]>([]);
  const groups = useMemo(
    () => buildStandingsPickerGroups(props.catalog, props.follows, props.selectedCompetitionKeys),
    [props.catalog, props.follows, props.selectedCompetitionKeys]
  );
  const options = groups.flatMap((group) => group.regions.flatMap((region) => region.competitions));
  const optionIndex = new Map(
    options.map((competition, index) => [competition.competitionKey, index])
  );
  const current = props.catalog.find((competition) => competition.competitionKey === props.value);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };
  const focusAt = (index: number) => optionRefs.current[index]?.focus();
  const openPicker = (target: "current" | "first" | "last" = "current") => {
    setOpen(true);
    queueMicrotask(() => {
      const currentIndex = options.findIndex(
        (competition) => competition.competitionKey === props.value
      );
      focusAt(
        target === "first" ? 0 : target === "last" ? options.length - 1 : Math.max(currentIndex, 0)
      );
    });
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (
        !popupRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
        queueMicrotask(() => triggerRef.current?.focus());
      }
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      openPicker(
        event.key === "ArrowUp" || event.key === "End"
          ? "last"
          : event.key === "ArrowDown" || event.key === "Home"
            ? "first"
            : "current"
      );
    }
  };
  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : event.key === "ArrowDown"
              ? (index + 1) % options.length
              : (index - 1 + options.length) % options.length;
      focusAt(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onChange(options[index]?.competitionKey ?? props.value);
      close(true);
    }
  };

  return (
    <span className="jds-menu sp-standings-picker">
      <button
        ref={triggerRef}
        type="button"
        className="jds-menu__trigger sp-standings-picker__trigger"
        aria-label="Select standings league"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={onTriggerKeyDown}
      >
        {current?.label ?? "Select league"}
      </button>
      {open ? (
        <div
          ref={popupRef}
          className="jds-menu__list sp-standings-picker__popup"
          role="listbox"
          aria-label="Standings leagues"
        >
          {groups.map((group) => (
            <div
              className="sp-standings-picker__group"
              role="group"
              aria-label={group.label}
              key={group.label}
            >
              <div className="sp-standings-picker__heading">{group.label}</div>
              {group.regions.map((region) => (
                <div
                  role={region.label ? "group" : undefined}
                  aria-label={region.label ?? undefined}
                  key={region.label ?? group.label}
                >
                  {region.label ? (
                    <div className="sp-standings-picker__region">{region.label}</div>
                  ) : null}
                  {region.competitions.map((competition) => {
                    const index = optionIndex.get(competition.competitionKey) ?? 0;
                    const selected = competition.competitionKey === props.value;
                    return (
                      <button
                        ref={(element) => {
                          if (element) optionRefs.current[index] = element;
                        }}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`sp-standings-picker__option jds-btn jds-btn--sm ${
                          selected ? "jds-btn--primary" : "jds-btn--quiet"
                        }`}
                        key={competition.competitionKey}
                        tabIndex={selected ? 0 : -1}
                        onKeyDown={(event) => onOptionKeyDown(event, index)}
                        onClick={() => {
                          props.onChange(competition.competitionKey);
                          close(true);
                        }}
                      >
                        {competition.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
}
