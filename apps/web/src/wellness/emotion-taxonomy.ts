// Thin re-export + frontend color helpers for the wellness emotion taxonomy.
// Semantic CSS tokens keep category identity stable and react to theme changes.
import {
  EMOTIONS,
  EMOTION_POLARITY,
  moodIndex,
  moodBand,
  type WellnessEmotionCore,
  type EmotionEntry,
  type EmotionFeeling
} from "@moss/shared";

export { EMOTIONS, EMOTION_POLARITY, moodIndex, moodBand };
export type { WellnessEmotionCore, EmotionEntry, EmotionFeeling };

/** Look up an EmotionEntry by core key. */
export function getEmotion(core: WellnessEmotionCore): EmotionEntry {
  const entry = EMOTIONS.find((e) => e.core === core);
  if (!entry) throw new Error(`Unknown emotion core: ${core}`);
  return entry;
}

export interface ColorRamp {
  readonly soft: string;
  readonly soft2: string;
  readonly tint: string;
  readonly ink: string;
  readonly line: string;
  readonly onTint: string;
}

export type Theme = "light" | "dark";

const EMOTION_COLORS: Readonly<Record<WellnessEmotionCore, ColorRamp>> = {
  happy: {
    soft: "var(--wellness-happy-soft)",
    soft2: "var(--wellness-happy-soft2)",
    tint: "var(--wellness-happy-tint)",
    ink: "var(--wellness-happy-ink)",
    line: "var(--wellness-happy-line)",
    onTint: "var(--wellness-happy-on-tint)"
  },
  sad: {
    soft: "var(--wellness-sad-soft)",
    soft2: "var(--wellness-sad-soft2)",
    tint: "var(--wellness-sad-tint)",
    ink: "var(--wellness-sad-ink)",
    line: "var(--wellness-sad-line)",
    onTint: "var(--wellness-sad-on-tint)"
  },
  fear: {
    soft: "var(--wellness-fear-soft)",
    soft2: "var(--wellness-fear-soft2)",
    tint: "var(--wellness-fear-tint)",
    ink: "var(--wellness-fear-ink)",
    line: "var(--wellness-fear-line)",
    onTint: "var(--wellness-fear-on-tint)"
  },
  anger: {
    soft: "var(--wellness-anger-soft)",
    soft2: "var(--wellness-anger-soft2)",
    tint: "var(--wellness-anger-tint)",
    ink: "var(--wellness-anger-ink)",
    line: "var(--wellness-anger-line)",
    onTint: "var(--wellness-anger-on-tint)"
  },
  disgust: {
    soft: "var(--wellness-disgust-soft)",
    soft2: "var(--wellness-disgust-soft2)",
    tint: "var(--wellness-disgust-tint)",
    ink: "var(--wellness-disgust-ink)",
    line: "var(--wellness-disgust-line)",
    onTint: "var(--wellness-disgust-on-tint)"
  },
  surprise: {
    soft: "var(--wellness-surprise-soft)",
    soft2: "var(--wellness-surprise-soft2)",
    tint: "var(--wellness-surprise-tint)",
    ink: "var(--wellness-surprise-ink)",
    line: "var(--wellness-surprise-line)",
    onTint: "var(--wellness-surprise-on-tint)"
  }
};

const MED_COLORS: readonly ColorRamp[] = [
  {
    soft: "var(--wellness-med-1-soft)",
    soft2: "var(--wellness-med-1-soft2)",
    tint: "var(--wellness-med-1-tint)",
    ink: "var(--wellness-med-1-ink)",
    line: "var(--wellness-med-1-line)",
    onTint: "var(--wellness-med-1-on-tint)"
  },
  {
    soft: "var(--wellness-med-2-soft)",
    soft2: "var(--wellness-med-2-soft2)",
    tint: "var(--wellness-med-2-tint)",
    ink: "var(--wellness-med-2-ink)",
    line: "var(--wellness-med-2-line)",
    onTint: "var(--wellness-med-2-on-tint)"
  },
  {
    soft: "var(--wellness-med-3-soft)",
    soft2: "var(--wellness-med-3-soft2)",
    tint: "var(--wellness-med-3-tint)",
    ink: "var(--wellness-med-3-ink)",
    line: "var(--wellness-med-3-line)",
    onTint: "var(--wellness-med-3-on-tint)"
  },
  {
    soft: "var(--wellness-med-4-soft)",
    soft2: "var(--wellness-med-4-soft2)",
    tint: "var(--wellness-med-4-tint)",
    ink: "var(--wellness-med-4-ink)",
    line: "var(--wellness-med-4-line)",
    onTint: "var(--wellness-med-4-on-tint)"
  },
  {
    soft: "var(--wellness-med-5-soft)",
    soft2: "var(--wellness-med-5-soft2)",
    tint: "var(--wellness-med-5-tint)",
    ink: "var(--wellness-med-5-ink)",
    line: "var(--wellness-med-5-line)",
    onTint: "var(--wellness-med-5-on-tint)"
  },
  {
    soft: "var(--wellness-med-6-soft)",
    soft2: "var(--wellness-med-6-soft2)",
    tint: "var(--wellness-med-6-tint)",
    ink: "var(--wellness-med-6-ink)",
    line: "var(--wellness-med-6-line)",
    onTint: "var(--wellness-med-6-on-tint)"
  },
  {
    soft: "var(--wellness-med-7-soft)",
    soft2: "var(--wellness-med-7-soft2)",
    tint: "var(--wellness-med-7-tint)",
    ink: "var(--wellness-med-7-ink)",
    line: "var(--wellness-med-7-line)",
    onTint: "var(--wellness-med-7-on-tint)"
  }
];

/** CSS resolves the active theme without a render-time color-mode snapshot. */
export function emoColor(core: WellnessEmotionCore, _theme: Theme = "light"): ColorRamp {
  return EMOTION_COLORS[core];
}

/** Preserve the existing seven-color medication cycle. */
export function medColor(idx: number, _theme: Theme = "light"): ColorRamp {
  return MED_COLORS[((idx % MED_COLORS.length) + MED_COLORS.length) % MED_COLORS.length]!;
}

/** CSS custom properties dict for an emotion color set — spread onto style prop. */
export function emVars(
  core: WellnessEmotionCore | null,
  theme: Theme = "light"
): Record<string, string> {
  if (!core) return {};
  const c = emoColor(core, theme);
  return { "--em-soft": c.soft, "--em-tint": c.tint, "--em-ink": c.ink };
}

/** Human label for a mood band key. */
export const MOOD_BAND_LABELS: Readonly<Record<string, string>> = {
  bright: "Bright",
  lifted: "Lifted",
  even: "Even",
  low: "Low",
  heavy: "Heavy"
};

/** Capitalize a core key for display. */
export function coreLabel(core: WellnessEmotionCore): string {
  return core.charAt(0).toUpperCase() + core.slice(1);
}
