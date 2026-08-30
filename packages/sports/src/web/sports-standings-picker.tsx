import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
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

type PickerView =
  | { readonly level: "root" }
  | { readonly level: "sport"; readonly sportLabel: string }
  | {
      readonly level: "region";
      readonly sportLabel: string;
      readonly regionLabel: string;
    };

type PickerRow =
  | { readonly kind: "competition"; readonly competition: CompetitionRef }
  | { readonly kind: "sport"; readonly label: string }
  | { readonly kind: "region"; readonly label: string; readonly sportLabel: string }
  | { readonly kind: "back"; readonly target: PickerView };

interface PickerSection {
  readonly label: string | null;
  readonly rows: readonly PickerRow[];
}

export function StandingsPicker(props: StandingsPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>({ level: "root" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<HTMLButtonElement[]>([]);
  const focusTarget = useRef<"current" | "first" | "last">("current");
  const groups = useMemo(
    () => buildStandingsPickerGroups(props.catalog, props.follows, props.selectedCompetitionKeys),
    [props.catalog, props.follows, props.selectedCompetitionKeys]
  );
  const following = groups.find((group) => group.label === "Following");
  const sports = groups.filter((group) => group.label !== "Following");
  const current = props.catalog.find((competition) => competition.competitionKey === props.value);

  const sections = useMemo<readonly PickerSection[]>(() => {
    if (view.level === "root") {
      const root: PickerSection[] = [];
      const followed = following?.regions.flatMap((region) => region.competitions) ?? [];
      if (followed.length > 0) {
        root.push({
          label: "Following",
          rows: followed.map((competition) => ({ kind: "competition", competition }))
        });
      }
      if (sports.length > 0) {
        root.push({
          label: "Sports",
          rows: sports.map((group) => ({ kind: "sport", label: group.label }))
        });
      }
      return root;
    }

    const sport = sports.find((group) => group.label === view.sportLabel);
    if (!sport) return [];
    if (view.level === "region") {
      const region = sport.regions.find((entry) => entry.label === view.regionLabel);
      return region
        ? [
            {
              label: "Leagues",
              rows: region.competitions.map((competition) => ({
                kind: "competition",
                competition
              }))
            }
          ]
        : [];
    }

    const regionRows: PickerRow[] = sport.regions
      .filter((region) => region.label !== null)
      .map((region) => ({
        kind: "region",
        label: region.label as string,
        sportLabel: sport.label
      }));
    const directRows: PickerRow[] = sport.regions
      .filter((region) => region.label === null)
      .flatMap((region) =>
        region.competitions.map((competition) => ({ kind: "competition", competition }))
      );
    return [
      ...(regionRows.length > 0
        ? [{ label: "Countries and regions", rows: regionRows } satisfies PickerSection]
        : []),
      ...(directRows.length > 0
        ? [{ label: "Leagues", rows: directRows } satisfies PickerSection]
        : [])
    ];
  }, [following, sports, view]);

  const backRow: PickerRow | null =
    view.level === "root"
      ? null
      : {
          kind: "back",
          target:
            view.level === "region"
              ? { level: "sport", sportLabel: view.sportLabel }
              : { level: "root" }
        };
  const rows = [...(backRow ? [backRow] : []), ...sections.flatMap((section) => section.rows)];
  const viewTitle =
    view.level === "root"
      ? "Standings leagues"
      : view.level === "sport"
        ? view.sportLabel
        : view.regionLabel;
  const rowKey = (row: PickerRow) =>
    row.kind === "competition"
      ? `competition:${row.competition.competitionKey}`
      : row.kind === "back"
        ? "back"
        : `${row.kind}:${row.label}`;
  const rowIndexes = new Map(rows.map((row, index) => [rowKey(row), index]));

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };
  const focusAt = (index: number) => rowRefs.current[index]?.focus();
  const navigate = (next: PickerView) => {
    focusTarget.current = "first";
    setView(next);
  };
  const activate = (row: PickerRow) => {
    if (row.kind === "competition") {
      props.onChange(row.competition.competitionKey);
      close(true);
    } else if (row.kind === "sport") {
      navigate({ level: "sport", sportLabel: row.label });
    } else if (row.kind === "region") {
      navigate({ level: "region", sportLabel: row.sportLabel, regionLabel: row.label });
    } else {
      navigate(row.target);
    }
  };
  const openPicker = (target: "current" | "first" | "last" = "current") => {
    focusTarget.current = target;
    setView({ level: "root" });
    setOpen(true);
  };

  useEffect(() => {
    if (!open || rows.length === 0) return;
    const currentIndex = rows.findIndex(
      (row) => row.kind === "competition" && row.competition.competitionKey === props.value
    );
    const firstContentIndex = backRow && rows.length > 1 ? 1 : 0;
    const index =
      focusTarget.current === "last"
        ? rows.length - 1
        : focusTarget.current === "current" && currentIndex >= 0
          ? currentIndex
          : firstContentIndex;
    focusTarget.current = "first";
    focusAt(index);
  }, [open, props.value, rows.length, view]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (
        !popupRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) {
        close(true);
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
  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, row: PickerRow) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "ArrowLeft" && view.level !== "root") {
      event.preventDefault();
      activate(backRow as PickerRow);
    } else if (event.key === "ArrowRight" && (row.kind === "sport" || row.kind === "region")) {
      event.preventDefault();
      activate(row);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : event.key === "ArrowDown"
              ? (index + 1) % rows.length
              : (index - 1 + rows.length) % rows.length;
      focusAt(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(row);
    }
  };

  const renderRow = (row: PickerRow) => {
    const index = rowIndexes.get(rowKey(row)) ?? 0;
    const selected = row.kind === "competition" && row.competition.competitionKey === props.value;
    const label =
      row.kind === "competition" ? row.competition.label : row.kind === "back" ? "Back" : row.label;
    return (
      <button
        ref={(element) => {
          if (element) rowRefs.current[index] = element;
        }}
        type="button"
        role={row.kind === "competition" ? "menuitemradio" : "menuitem"}
        aria-checked={row.kind === "competition" ? selected : undefined}
        className="sp-standings-picker__row"
        key={rowKey(row)}
        tabIndex={-1}
        onKeyDown={(event) => onRowKeyDown(event, index, row)}
        onClick={() => activate(row)}
      >
        {row.kind === "back" ? <ChevronLeft size={15} aria-hidden="true" /> : null}
        <span>{label}</span>
        {selected ? <Check size={15} aria-hidden="true" /> : null}
        {row.kind === "sport" || row.kind === "region" ? (
          <ChevronRight size={15} aria-hidden="true" />
        ) : null}
      </button>
    );
  };

  return (
    <span className="jds-menu sp-standings-picker">
      <button
        ref={triggerRef}
        type="button"
        className="jds-menu__trigger sp-standings-picker__trigger"
        aria-label="Select standings league"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={onTriggerKeyDown}
      >
        <span>{current?.label ?? "Select league"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={popupRef}
          className="jds-menu__list sp-standings-picker__popup"
          role="menu"
          aria-label="Standings leagues"
        >
          <div className="sp-standings-picker__title jds-label">
            {backRow ? renderRow(backRow) : null}
            <span>{viewTitle}</span>
          </div>
          {sections.map((section) => (
            <div
              className="sp-standings-picker__group"
              role="group"
              aria-label={section.label ?? undefined}
              key={section.label}
            >
              {section.label ? (
                <div className="sp-standings-picker__heading jds-eyebrow">{section.label}</div>
              ) : null}
              {section.rows.map(renderRow)}
            </div>
          ))}
          {rows.length === 0 ? <span className="jds-hint">No leagues available.</span> : null}
        </div>
      ) : null}
    </span>
  );
}
