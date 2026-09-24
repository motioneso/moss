import { useMemo, type ReactNode } from "react";

/**
 * Drawn stand-in for the Today lead photo: the "contour print" study
 * (~/moss-placeholder-mockups/direction-1.html). Topic, headline and publisher hash to a seed.
 * The topic family picks a terrain shape and the seed places it, so stories in one topic share a
 * look but never a picture. Marching squares traces the terrain's height lines into SVG paths.
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

// Topic keys and labels map onto four families, each with its own colors and terrain; anything
// else draws as World.
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

interface Terrain {
  readonly height: (x: number, y: number) => number;

  /** Height between neighboring contour lines; smaller steps pack the lines tighter. */
  readonly step: number;
}

/** Triangle wave with period 2 and range 0..1, for creased ridges. */
function fold(value: number): number {
  return Math.abs((((value % 2) + 2) % 2) - 1);
}

/** Each topic family gets its own ground; the seed only places and sizes it. */
function shapeTerrain(kind: LeadArtPalette, random: () => number): Terrain {
  switch (kind) {
    // Broad rolling hills with wide, soft spacing.
    case "climate": {
      const hills = Array.from({ length: 4 }, (_, index) => ({
        x: index * 230 + random() * 180 - 40,
        y: 60 + random() * 330,
        sx: 120 + random() * 70,
        sy: 90 + random() * 60,
        lift: 0.55 + random() * 0.45
      }));
      const phase = random() * Math.PI * 2;
      return {
        step: 0.1,
        height: (x, y) => {
          let value = 0.15 * Math.sin(x / 140 + y / 190 + phase);
          for (const hill of hills) {
            value +=
              hill.lift *
              Math.exp(
                -((x - hill.x) ** 2 / (2 * hill.sx ** 2) + (y - hill.y) ** 2 / (2 * hill.sy ** 2))
              );
          }
          return value;
        }
      };
    }

    // One or two steep summits ringed by tight, even contours, like a mountain map.
    case "world": {
      const count = random() < 0.5 ? 1 : 2;
      const peaks = Array.from({ length: count }, (_, index) => ({
        x: 160 + random() * 480,
        y: 110 + random() * 230,
        reach: 150 + random() * 60,
        lift: index === 0 ? 1.95 : 1.1 + random() * 0.5
      }));
      const wobble = random() * Math.PI * 2;
      return {
        step: 0.085,
        height: (x, y) => {
          let value = 0;
          for (const peak of peaks) {
            const distance = Math.hypot(x - peak.x, y - peak.y);
            const angle = Math.atan2(y - peak.y, x - peak.x);
            const reach =
              peak.reach * (1 + 0.07 * Math.sin(2 * angle + wobble) + 0.04 * Math.sin(5 * angle));
            value = Math.max(value, peak.lift * Math.exp(-((distance / reach) ** 1.4)));
          }
          return value;
        }
      };
    }

    // A meandering river channel with bands that flow along it across the frame.
    case "culture": {
      const center = 150 + random() * 150;
      const bends = [
        { size: 45 + random() * 35, span: 70 + random() * 40, phase: random() * Math.PI * 2 },
        { size: 15 + random() * 20, span: 30 + random() * 20, phase: random() * Math.PI * 2 }
      ];
      const tilt = (random() - 0.5) * 0.5;
      return {
        step: 0.13,
        height: (x, y) => {
          let river = center + tilt * (x - 400);
          for (const bend of bends) river += bend.size * Math.sin(x / bend.span + bend.phase);

          // The rounded valley floor leaves the channel open instead of tracing specks along it.
          return Math.hypot(y - river, 45) / 120;
        }
      };
    }

    // Regular creased ridges crossing at an angle, like terraced or faceted ground.
    case "technology": {
      const angle = (0.25 + random() * 0.5) * (random() < 0.5 ? 1 : -1);
      const across = angle + Math.PI / 2 + (random() - 0.5) * 0.4;
      const pitch = 230 + random() * 80;
      const crossPitch = 300 + random() * 120;
      const offset = random() * 2;
      return {
        step: 0.115,
        height: (x, y) =>
          1.55 * fold((x * Math.cos(angle) + y * Math.sin(angle)) / pitch + offset) +
          1.05 * fold((x * Math.cos(across) + y * Math.sin(across)) / crossPitch)
      };
    }
  }
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** One path per height level; every fifth level is a gold line. */
export function drawLeadContours(seed: number, kind: LeadArtPalette): LeadArtLine[] {
  const { height, step } = shapeTerrain(kind, seededRandom(seed));
  const field: number[][] = [];
  for (let row = 0; row <= ROWS; row += 1) {
    const values: number[] = [];
    for (let column = 0; column <= COLUMNS; column += 1)
      values.push(height(column * CELL, row * CELL));
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
      const first = Math.max(1, Math.ceil(low / step));
      const last = Math.min(LEVELS, Math.floor(high / step));
      for (let levelIndex = first; levelIndex <= last; levelIndex += 1) {
        const level = levelIndex * step;
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
const contourCache = new Map<string, LeadArtLine[]>();

function cachedContours(seed: number, kind: LeadArtPalette): LeadArtLine[] {
  const key = `${kind}:${seed}`;
  const hit = contourCache.get(key);
  if (hit) return hit;
  const lines = drawLeadContours(seed, kind);
  if (contourCache.size >= CACHE_LIMIT) {
    const oldest = contourCache.keys().next().value;
    if (oldest !== undefined) contourCache.delete(oldest);
  }
  contourCache.set(key, lines);
  return lines;
}

/**
 * The placeholder layer. It fills its positioned 16:9 frame, so a later image layer can stack
 * over it in the same frame and fade in.
 */
export function LeadArt(props: LeadArtStory): ReactNode {
  const { topic, headline, publisher } = props;
  const seed = leadArtSeed({ topic, headline, publisher });
  const kind = leadArtPalette(topic);
  const lines = useMemo(() => cachedContours(seed, kind), [seed, kind]);
  return (
    <span className={`nw-leadart nw-leadart--${kind}`} aria-hidden="true" data-seed={seed}>
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
