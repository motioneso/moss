import { useMemo, type ReactNode } from "react";

/**
 * Drawn stand-in for the Today lead photo: the "contour print" study
 * (~/moss-placeholder-mockups/direction-1.html). Topic, headline and publisher hash to a seed;
 * the seed places five smooth hills; marching squares traces their height lines into SVG paths.
 * Decorative only, so the whole layer is aria-hidden and the headline carries the meaning.
 */

export type LeadArtPalette = "climate" | "world" | "culture" | "technology";

export interface LeadArtStory {
  readonly topic: string;
  readonly headline: string;
  readonly publisher: string;
}

export interface LeadArtLine {
  readonly d: string;
  readonly gold: boolean;
}

const WIDTH = 800;
const HEIGHT = 450;
const CELL = 10;
const COLUMNS = WIDTH / CELL;
const ROWS = HEIGHT / CELL;
const LEVELS = 24;
const LEVEL_STEP = 0.115;

// Topic keys and labels map onto the four studied color pairs; anything else draws as World.
const PALETTE_BY_TOPIC: Readonly<Record<string, LeadArtPalette>> = {
  climate: "climate",
  science: "climate",
  health: "climate",
  environment: "climate",
  world: "world",
  us: "world",
  "u.s.": "world",
  politics: "world",
  culture: "culture",
  arts: "culture",
  technology: "technology",
  tech: "technology",
  business: "technology"
};

export function leadArtPalette(topic: string | null | undefined): LeadArtPalette {
  return PALETTE_BY_TOPIC[(topic ?? "").trim().toLowerCase()] ?? "world";
}

/** FNV-1a over the NFKC-normalized story fields, so the same story always draws the same hills. */
export function leadArtSeed(story: LeadArtStory): number {
  const text = [story.topic, story.headline, story.publisher]
    .map((value) => value.normalize("NFKC").trim())
    .join("|");
  let seed = 2166136261;
  for (const character of text) seed = Math.imul(seed ^ character.codePointAt(0)!, 16777619) >>> 0;
  return seed;
}

interface Hill {
  readonly x: number;
  readonly y: number;
  readonly sx: number;
  readonly sy: number;
  readonly height: number;
}

function placeHills(seed: number): Hill[] {
  let state = seed;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return Array.from({ length: 5 }, () => ({
    x: random() * 900 - 50,
    y: random() * 500 - 25,
    sx: 100 + random() * 140,
    sy: 75 + random() * 120,
    height: 0.5 + random()
  }));
}

/** One path per height level; every fifth level is a gold line. */
export function drawLeadContours(seed: number): LeadArtLine[] {
  const hills = placeHills(seed);
  const field: number[][] = [];
  for (let row = 0; row <= ROWS; row += 1) {
    const values: number[] = [];
    for (let column = 0; column <= COLUMNS; column += 1) {
      const x = column * CELL;
      const y = row * CELL;
      let value = 0.12 * Math.sin(x / 75 + y / 90);
      for (const hill of hills) {
        value +=
          hill.height *
          Math.exp(
            -((x - hill.x) ** 2 / (2 * hill.sx ** 2) + (y - hill.y) ** 2 / (2 * hill.sy ** 2))
          );
      }
      values.push(value);
    }
    field.push(values);
  }

  const paths: string[] = Array.from({ length: LEVELS }, () => "");
  const corners: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const x = column * CELL;
      const y = row * CELL;
      corners[0] = [x, y, field[row]![column]!];
      corners[1] = [x + CELL, y, field[row]![column + 1]!];
      corners[2] = [x + CELL, y + CELL, field[row + 1]![column + 1]!];
      corners[3] = [x, y + CELL, field[row + 1]![column]!];
      const low = Math.min(corners[0][2], corners[1][2], corners[2][2], corners[3][2]);
      const high = Math.max(corners[0][2], corners[1][2], corners[2][2], corners[3][2]);

      // Only the levels that pass through this cell can cross its edges.
      const first = Math.max(1, Math.ceil(low / LEVEL_STEP));
      const last = Math.min(LEVELS, Math.floor(high / LEVEL_STEP));
      for (let levelIndex = first; levelIndex <= last; levelIndex += 1) {
        const level = levelIndex * LEVEL_STEP;
        const crossings: string[] = [];
        for (let edge = 0; edge < 4; edge += 1) {
          const start = corners[edge]!;
          const end = corners[(edge + 1) % 4]!;
          if (start[2] < level !== end[2] < level) {
            const ratio = (level - start[2]) / (end[2] - start[2]);
            crossings.push(
              `${(start[0] + ratio * (end[0] - start[0])).toFixed(1)},${(start[1] + ratio * (end[1] - start[1])).toFixed(1)}`
            );
          }
        }
        for (let index = 0; index + 1 < crossings.length; index += 2) {
          paths[levelIndex - 1] += `M${crossings[index]}L${crossings[index + 1]}`;
        }
      }
    }
  }

  return paths
    .map((d, index) => ({ d, gold: (index + 1) % 5 === 0 }))
    .filter((line) => line.d.length > 0);
}

// Remounts and re-renders of the same lead reuse the traced paths instead of re-tracing them.
const CACHE_LIMIT = 16;
const contourCache = new Map<number, LeadArtLine[]>();

function cachedContours(seed: number): LeadArtLine[] {
  const hit = contourCache.get(seed);
  if (hit) return hit;
  const lines = drawLeadContours(seed);
  if (contourCache.size >= CACHE_LIMIT) {
    const oldest = contourCache.keys().next().value;
    if (oldest !== undefined) contourCache.delete(oldest);
  }
  contourCache.set(seed, lines);
  return lines;
}

/**
 * The placeholder layer. It fills its positioned 16:9 frame, so a later image layer can stack
 * over it in the same frame and fade in.
 */
export function LeadArt(props: LeadArtStory): ReactNode {
  const { topic, headline, publisher } = props;
  const seed = leadArtSeed({ topic, headline, publisher });
  const lines = useMemo(() => cachedContours(seed), [seed]);
  return (
    <span
      className={`nw-leadart nw-leadart--${leadArtPalette(topic)}`}
      aria-hidden="true"
      data-seed={seed}
    >
      <svg
        className="nw-leadart__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        focusable="false"
      >
        {lines.map((line, index) => (
          <path
            key={index}
            d={line.d}
            className={line.gold ? "nw-leadart__gold" : "nw-leadart__line"}
            strokeWidth={line.gold ? 2.2 : 1.1}
            opacity={line.gold ? 0.85 : 0.44}
          />
        ))}
        <path
          d="M34 46h21m-10-10v21M745 397h21m-10-10v21"
          className="nw-leadart__gold"
          strokeWidth={2}
        />
        <circle cx={45} cy={46} r={18} className="nw-leadart__gold" opacity={0.6} />
      </svg>
      <span className="nw-leadart__label">Moss topic artwork</span>
    </span>
  );
}
