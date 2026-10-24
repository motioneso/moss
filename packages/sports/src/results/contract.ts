import type { ModuleVisualTemplate } from "@moss/module-sdk/visual-template";
import { tryCopyVisualSnapshot, type VisualSnapshotV1 } from "@moss/shared";
import type {
  SportsCompletedResult as CompletedResult,
  SportsResultSide as ResultSide
} from "@moss/shared";
import { ESPN_IMAGE_HOSTS } from "../source/espn-assets.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const id = (v: unknown): v is string => typeof v === "string" && /^\d{1,20}$/.test(v);
const number = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000);
function crest(v: unknown): v is string | null {
  if (v === null) return true;
  if (typeof v !== "string" || v.length > 500) return false;
  try {
    const u = new URL(v);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      ESPN_IMAGE_HOSTS.includes(u.hostname)
    );
  } catch {
    return false;
  }
}
function side(value: unknown): value is ResultSide {
  const v = record(value);
  return Boolean(
    v &&
    Object.keys(v).length === 6 &&
    id(v.id) &&
    text(v.name) &&
    crest(v.crestUrl) &&
    number(v.score) &&
    number(v.shootout) &&
    number(v.aggregate)
  );
}

export function readSportsResultSnapshot(value: unknown): CompletedResult | null {
  const copied = tryCopyVisualSnapshot(value);
  if (!copied.ok) return null;
  const snapshot = copied.snapshot;
  const v = snapshot.fields;
  if (
    snapshot.kind !== "sports.result" ||
    snapshot.origin !== "source" ||
    snapshot.source.id !== "espn" ||
    snapshot.source.label !== "ESPN" ||
    Object.keys(v).length !== 8 ||
    !id(v.id) ||
    !text(v.sport) ||
    !text(v.competitionKey) ||
    !text(v.competition) ||
    !text(v.startsAt) ||
    !Number.isFinite(Date.parse(v.startsAt)) ||
    !text(v.status) ||
    !side(v.home) ||
    !side(v.away) ||
    v.home.id === v.away.id
  )
    return null;
  return {
    id: v.id,
    sport: v.sport,
    competitionKey: v.competitionKey,
    competition: v.competition,
    startsAt: v.startsAt,
    status: v.status,
    home: v.home,
    away: v.away
  };
}

export function formatSportsResultSnapshot(value: unknown): string {
  const result = readSportsResultSnapshot(value);
  if (!result) return "";
  const snapshot = value as VisualSnapshotV1;
  const score = (v: number | null) => (v === null ? "Unknown" : String(v));
  const shootout =
    result.home.shootout !== null || result.away.shootout !== null
      ? `; shootout ${score(result.home.shootout)}–${score(result.away.shootout)}`
      : "";
  const aggregate =
    result.home.aggregate !== null || result.away.aggregate !== null
      ? `; aggregate ${score(result.home.aggregate)}–${score(result.away.aggregate)}`
      : "";
  return `${result.home.name} ${score(result.home.score)}–${score(result.away.score)} ${result.away.name}${shootout}${aggregate}. ${result.competition}, ${result.startsAt}, ${result.status}. ESPN; retrieved ${snapshot.retrievedAt}. ${snapshot.coverage}`;
}

export const sportsResultTemplate: ModuleVisualTemplate = Object.freeze({
  kind: "sports.result",
  snapshotKind: "sports.result",
  validate: (value: unknown) => readSportsResultSnapshot(value) !== null,
  format: formatSportsResultSnapshot
});
export default [sportsResultTemplate];
