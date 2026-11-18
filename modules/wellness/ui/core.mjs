// Feelings, mood maths and calendar-day helpers for the Wellness screen.
// Same values and rules as the application's shared wellness code.

export const EMOTIONS = [
  { core: "happy", polarity: 1.0, blurb: "open, warm, at ease", feelings: [
    ["Joy", "Open", "Energetic"], ["Curious", "Awake", "Brow-furrow"], ["Proud", "Inflated", "Tall"],
    ["Satisfied", "Soft", "Calm"], ["Courageous", "Jaw set", "Steady"], ["Peaceful", "Relaxed", "Still"],
    ["Intimate", "Sensitive", "Warm"], ["Optimistic", "Light", "Buzzing"]] },
  { core: "sad", polarity: -1.0, blurb: "heavy, slow, withdrawn", feelings: [
    ["Guilt", "Looking down", "Empty"], ["Abandoned", "Curling up", "Slouching"], ["Despair", "Crying", "Body aches"],
    ["Depressed", "Tiredness", "Hollow feeling"], ["Lonely", "Slow heart", "Heaviness"], ["Apathetic", "Weak", "Eye rolls"]] },
  { core: "fear", polarity: -0.8, blurb: "braced, jittery, unsure", feelings: [
    ["Scared", "Trembling", "Numb hands"], ["Anxious", "Fidgety", "Foot-tapping"], ["Insecure", "Racing heart", "Quiet"],
    ["Inferior", "Frozen", "Tense"], ["Unwanted", "Cold", "Unsteady"], ["Embarrassed", "Blushing", "Tender"]] },
  { core: "anger", polarity: -0.7, blurb: "hot, tight, pushed", feelings: [
    ["Hurt", "Lip-tremble", "Limp"], ["Insecure", "Hiding", "Hot"], ["Hateful", "Scowl", "Turning away"],
    ["Mad", "Loud words", "Flushed"], ["Aggressive", "Racing heart", "Clenching"], ["Irritated", "Tight jaw", "Headache"],
    ["Distant", "Numb", "Gut-turning"], ["Critical", "Feeling hot", "Lip curled"]] },
  { core: "disgust", polarity: -0.7, blurb: "recoiling, queasy, done", feelings: [
    ["Disapproval", "Shuddering", "Writhing"], ["Disappointed", "Need to move", "Face-scrunched"],
    ["Awful", "Nausea", "Lump in throat"], ["Aversion", "Queasy", "Turn away"]] },
  { core: "surprise", polarity: 0.2, blurb: "wide-eyed, alert, struck", feelings: [
    ["Shock", "Jumpy", "Sweaty palms"], ["Confusion", "Breathless", "Speechless"], ["Awe", "Jaw drop", "Eyebrows up"],
    ["Excitement", "Electrified", "Jumpy"]] }
].map((e) => ({ ...e, feelings: e.feelings.map(([label, ...sensations]) => ({ label, sensations })) }));

export const emotion = (core) => EMOTIONS.find((e) => e.core === core);
export const coreLabel = (core) => core.charAt(0).toUpperCase() + core.slice(1);
export const MOOD_BAND_LABELS = { bright: "Bright", lifted: "Lifted", even: "Even", low: "Low", heavy: "Heavy" };

export function moodIndex(core, intensity) {
  const e = emotion(core);
  return e ? Math.round(e.polarity * intensity * 10) / 10 : 0;
}

export function moodBand(index) {
  if (index >= 3) return "bright";
  if (index >= 1) return "lifted";
  if (index > -1) return "even";
  if (index > -3) return "low";
  return "heavy";
}

export const emoVars = (core) =>
  core ? `--em-soft:var(--wellness-${core}-soft);--em-tint:var(--wellness-${core}-tint);--em-ink:var(--wellness-${core}-ink)` : "";

export function localDay(value, timeZone = "UTC") {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function localDayOffset(offsetDays, from) {
  const [y, m, d] = from.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - offsetDays);
  return base.toISOString().slice(0, 10);
}

const stampOf = (c) => c.checkedInAt ?? c.createdAt ?? "";

/** Consecutive completed days with a check-in, ending yesterday, up to 90. */
export function computeStreak(checkins, today, timeZone) {
  const seen = new Set(checkins.map(stampOf).filter(Boolean).map((t) => localDay(t, timeZone)));
  let streak = 0;
  for (let i = 1; i <= 90; i++) {
    if (seen.has(localDayOffset(i, today))) streak++;
    else break;
  }
  return streak;
}

/** Average mood over the fourteen completed days before today. */
export function recentMoodAverage(checkins, today, timeZone) {
  const since = localDayOffset(14, today);
  const recent = checkins.filter((c) => {
    const stamp = stampOf(c);
    if (!stamp) return false;
    const day = localDay(stamp, timeZone);
    return day >= since && day < today;
  });
  if (recent.length === 0) return null;
  const total = recent.reduce((sum, c) => sum + moodIndex(c.feelingCore, c.intensity ?? 3), 0);
  return Math.round((total / recent.length) * 10) / 10;
}

/** An instant one day before the oldest local day, so every zone's leading edge is inside. */
export function checkinWindowSince(oldestLocalDay) {
  return new Date(new Date(`${oldestLocalDay}T00:00:00.000Z`).getTime() - 86400000).toISOString();
}

export const stamp = stampOf;
