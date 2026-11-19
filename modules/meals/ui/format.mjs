/** Pure helpers for the Meals screens. No DOM access, so node can test them. */

export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

/** Today in the browser's own calendar, as YYYY-MM-DD. */
export function todayIso(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function parts(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

export const weekdayName = (iso) => WEEKDAY_NAMES[parts(iso).weekday];

/** "Monday, Nov 2" */
export function dayTitle(iso) {
  const { month, day } = parts(iso);
  return `${weekdayName(iso)}, ${MONTHS[month - 1]} ${day}`;
}

/** "Nov 2 to 8", or "Nov 28 to Dec 4" across a month. One day reads "Nov 2". */
export function dateRange(first, last) {
  const a = parts(first);
  const b = parts(last);
  const start = `${MONTHS[a.month - 1]} ${a.day}`;
  if (first === last) return start;
  return a.month === b.month
    ? `${start} to ${b.day}`
    : `${start} to ${MONTHS[b.month - 1]} ${b.day}`;
}

export const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1);

const FRACTIONS = [
  [0.25, "¼"],
  [0.5, "½"],
  [0.75, "¾"]
];

/** A readable number. Quarters read as fractions; anything else rounds to two places. */
export function formatNumber(value, fractions = true) {
  const plain = () => String(value >= 10 ? Math.round(value) : Math.round(value * 100) / 100);
  if (!fractions) return plain();
  const whole = Math.floor(value + 1e-9);
  const rest = value - whole;
  for (const [fraction, glyph] of FRACTIONS) {
    if (Math.abs(rest - fraction) < 0.02) return whole === 0 ? glyph : `${whole}${glyph}`;
  }
  return plain();
}

/** "500 ml", "2 cloves", or just "6" for a plain count. */
export function amountText(quantity, unit) {
  const number = formatNumber(quantity, false);
  return unit ? `${number} ${unit}` : number;
}

/** A typed amount such as "2 l" or "6". Null when it does not start with a number. */
export function parseAmount(text) {
  const match = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(text.trim());
  if (match === null) return null;
  const quantity = Number(match[1]);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const unit = (match[2] ?? "").trim();
  return { quantity, unit: unit === "" ? null : unit };
}

/** A written or failed recipe meal that is neither locked nor cooked. */
export function isReplaceable(meal) {
  return (
    meal.kind === "recipe" &&
    !meal.locked &&
    meal.cookedAt === null &&
    (meal.status === "ready" || meal.status === "failed")
  );
}

/** True while the plan still has days or meals to write and is not stopped or paused. */
export function isWriting(plan) {
  return (
    plan.state === "active" &&
    plan.days.some(
      (day) =>
        day.status === "pending" ||
        day.status === "writing" ||
        day.meals.some((meal) => meal.status === "pending" || meal.status === "writing")
    )
  );
}

/** A meal shows only once it is written and every eater's Safety result is known. */
export const isShown = (meal) =>
  meal.status === "ready" && meal.eaters.every((eater) => eater.safety !== "pending");

export function tonight(plan, today) {
  const day = plan.days.find((entry) => entry.date === today);
  return (
    day?.meals.find(
      (meal) =>
        meal.slotName === "dinner" &&
        meal.status === "ready" &&
        meal.title !== null &&
        meal.eaters.every((eater) => eater.safety !== "pending")
    ) ?? null
  );
}

export const PANTRY_LABEL = {
  ignore: "Ignore the Pantry",
  prefer: "Prefer what's on hand",
  only: "Only what's on hand"
};

export const PAUSE_TEXT = {
  invocation: "Moss hit its limit for work started from one request.",
  pending: "Moss has too much waiting to write.",
  hourly: "Moss hit its hourly limit for background writing."
};

const FAILURE_TEXT = {
  needs_config: "No AI model is set up for Moss yet.",
  provider_error: "The AI service had a problem.",
  usage_limited: "The AI service hit its usage limit.",
  validation_failed: "Moss got an answer it could not use.",
  aborted: "The run was interrupted.",
  safety_cap: "Every try had something from an eater's Never serve list.",
  timeout: "It took too long to write.",
  stopped: "Writing stopped before this day."
};

export const failureText = (reason) => (reason == null ? null : (FAILURE_TEXT[reason] ?? null));

export const plural = (count, one, many = `${one}s`) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

const SLOT_ORDER = ["breakfast", "lunch", "dinner"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const joinTitled = (words) => words.map(titleCase).join(", ");

export function dailyTarget(member) {
  const { calorieTarget, macroTargets } = member;
  const parts = [
    calorieTarget !== null ? `${calorieTarget.toLocaleString("en-US")} kcal` : null,
    macroTargets.proteinG !== null ? `${macroTargets.proteinG} g protein` : null,
    macroTargets.carbG !== null ? `${macroTargets.carbG} g carbs` : null,
    macroTargets.fatG !== null ? `${macroTargets.fatG} g fat` : null
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Every slot any member eats, breakfast, lunch and dinner first. */
export function slotsEaten(members) {
  const all = new Set(members.flatMap((member) => member.mealPattern));
  const known = SLOT_ORDER.filter((slot) => all.has(slot));
  const extra = [...all].filter((slot) => !SLOT_ORDER.includes(slot)).sort();
  return [...known, ...extra];
}

export function sharingRule(rule) {
  const days = rule?.soloWeekdays ?? [];
  const key = days.join(",");
  if (key === "") return "Shared every day";
  if (key === "1,2,3,4,5,6,7") return "Solo every day";
  if (key === "1,2,3,4,5") return "Solo on weekdays, shared at weekends";
  if (key === "6,7") return "Solo at weekends, shared on weekdays";
  return `Solo on ${days.map((day) => WEEKDAYS[day - 1]).join(", ")}`;
}

/** A comma-separated list typed into one box. */
export const words = (text) =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");
