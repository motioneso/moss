// Drawn stand-in for a story photo: seeded marching-squares contour art. Ported from
// packages/news/src/web/lead-art.tsx so the picture matches the TypeScript screen.

const WIDTH = 800;
const HEIGHT = 450;
const CELL = 10;
const COLUMNS = WIDTH / CELL;
const ROWS = HEIGHT / CELL;
const LEVELS = 24;

// Topic keys and labels map onto four families, each with its own colors and terrain; anything
// else draws as World.
const PALETTE_BY_TOPIC = {
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

export function leadArtPalette(topic) {
  const key = (topic ?? "").trim().toLowerCase();
  return Object.hasOwn(PALETTE_BY_TOPIC, key) ? PALETTE_BY_TOPIC[key] : "world";
}

/** FNV-1a over the NFKC-normalized story fields, so the same story always draws the same hills. */
export function leadArtSeed(story) {
  const text = [story.topic, story.headline, story.publisher]
    .map((value) => value.normalize("NFKC").trim())
    .join("|");
  let seed = 2166136261;
  for (const character of text) seed = Math.imul(seed ^ character.codePointAt(0), 16777619) >>> 0;
  return seed;
}

/** Triangle wave with period 2 and range 0..1, for creased ridges. */
function fold(value) {
  return Math.abs((((value % 2) + 2) % 2) - 1);
}

/** Each topic family gets its own ground; the seed only places and sizes it. */
function shapeTerrain(kind, random) {
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

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** One path per height level; every fifth level is a gold line. */
export function drawLeadContours(seed, kind) {
  const { height, step } = shapeTerrain(kind, seededRandom(seed));
  const field = [];
  for (let row = 0; row <= ROWS; row += 1) {
    const values = [];
    for (let column = 0; column <= COLUMNS; column += 1)
      values.push(height(column * CELL, row * CELL));
    field.push(values);
  }

  const paths = Array.from({ length: LEVELS }, () => "");
  const corners = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const x = column * CELL;
      const y = row * CELL;
      corners[0] = [x, y, field[row][column]];
      corners[1] = [x + CELL, y, field[row][column + 1]];
      corners[2] = [x + CELL, y + CELL, field[row + 1][column + 1]];
      corners[3] = [x, y + CELL, field[row + 1][column]];
      const low = Math.min(corners[0][2], corners[1][2], corners[2][2], corners[3][2]);
      const high = Math.max(corners[0][2], corners[1][2], corners[2][2], corners[3][2]);

      // Only the levels that pass through this cell can cross its edges.
      const first = Math.max(1, Math.ceil(low / step));
      const last = Math.min(LEVELS, Math.floor(high / step));
      for (let levelIndex = first; levelIndex <= last; levelIndex += 1) {
        const level = levelIndex * step;
        const crossings = [];
        for (let edge = 0; edge < 4; edge += 1) {
          const start = corners[edge];
          const end = corners[(edge + 1) % 4];
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

const cache = new Map();

export function leadArtSvg(story) {
  const seed = leadArtSeed(story);
  const kind = leadArtPalette(story.topic);
  const key = `${kind}:${seed}`;
  let lines = cache.get(key);
  if (!lines) {
    lines = drawLeadContours(seed, kind);
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    cache.set(key, lines);
  }
  const paths = lines
    .map(
      (line) =>
        `<path d="${line.d}" class="${line.gold ? "nw-leadart__gold" : "nw-leadart__line"}" stroke-width="${line.gold ? 2.2 : 1.1}" opacity="${line.gold ? 0.85 : 0.44}"/>`
    )
    .join("");
  return (
    `<span class="nw-leadart nw-leadart--${kind}" aria-hidden="true" data-seed="${seed}">` +
    `<svg class="nw-leadart__svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid slice" fill="none" focusable="false">${paths}` +
    `<path d="M34 46h21m-10-10v21M745 397h21m-10-10v21" class="nw-leadart__gold" stroke-width="2"/>` +
    `<circle cx="45" cy="46" r="18" class="nw-leadart__gold" opacity="0.6"/></svg>` +
    `<span class="nw-leadart__label">Moss topic artwork</span></span>`
  );
}
