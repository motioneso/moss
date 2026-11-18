// Medication form rules: the six schedule choices, what is wrong with a form, and the request body.
export const SCHEDULE_CHOICES = [
  { value: "daily", label: "Every day", hint: "One or more times a day, every day." },
  { value: "selected_days", label: "Certain days", hint: "Only on the days of the week you pick." },
  { value: "every_interval", label: "Every so often", hint: "Every few days, weeks or months, counting from the start date." },
  { value: "monthly", label: "Monthly", hint: "Once a month, on a date or a weekday." },
  { value: "cycle", label: "In a cycle", hint: "So many days on, then so many days off." },
  { value: "as_needed", label: "Only when needed", hint: "No set times. Log a dose when you take it." }
];
export const WEEKDAY_LABELS = [
  [1, "Mon", "Monday"], [2, "Tue", "Tuesday"], [3, "Wed", "Wednesday"], [4, "Thu", "Thursday"],
  [5, "Fri", "Friday"], [6, "Sat", "Saturday"], [7, "Sun", "Sunday"]
].map(([value, short, long]) => ({ value, short, long }));
export const MONTH_POSITION_LABELS = ["first", "second", "third", "fourth", "last"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
export const MAX_DOSES_PER_DAY = 6;

export const startDateRequired = (choice) => choice === "every_interval" || choice === "monthly" || choice === "cycle";
export const supportsReminders = (choice) => choice !== "as_needed";
export const usesClockTimes = (choice) => choice !== "as_needed";
export const usesWeekdays = (s) => s.choice === "selected_days" || (s.choice === "every_interval" && s.intervalUnit === "weeks");

export function emptyMedForm(today) {
  return {
    name: "", dose: "", choice: "daily", times: ["08:00"], weekdays: [], intervalCount: 2, intervalUnit: "days",
    monthKind: "date", monthDay: 1, monthDayIsLast: false, monthWeekdayPosition: "first", monthWeekday: 1,
    cycleDaysOn: 21, cycleDaysOff: 7, startDate: today, remindersEnabled: false
  };
}

export function withChoice(state, choice, today) {
  const fresh = emptyMedForm(today);
  return {
    ...fresh, name: state.name, dose: state.dose, startDate: state.startDate,
    remindersEnabled: supportsReminders(choice) ? state.remindersEnabled : false, choice,
    times: choice === "as_needed" ? [] : state.times.length > 0 ? state.times : fresh.times
  };
}

const CHOICE_FOR_TYPE = {
  once_daily: "daily", times_per_day: "daily", specific_weekdays: "selected_days",
  every_interval: "every_interval", monthly: "monthly", cyclical: "cycle", as_needed: "as_needed"
};

export function medFormFromMedication(m) {
  const choice = CHOICE_FOR_TYPE[m.frequencyType] ?? "daily";
  const fresh = emptyMedForm(m.scheduleStartDate ?? "");
  const stored = (m.scheduleTimes ?? []).map((t) => t.slice(0, 5));
  return {
    ...fresh, name: m.name, dose: m.dosage ?? "", choice,
    times: !usesClockTimes(choice) ? [] : stored.length > 0 ? stored : fresh.times,
    weekdays: m.weekdays ?? [], intervalCount: m.intervalCount ?? fresh.intervalCount,
    intervalUnit: m.intervalUnit ?? fresh.intervalUnit, monthKind: m.monthKind ?? fresh.monthKind,
    monthDay: m.monthDay ?? fresh.monthDay, monthDayIsLast: Boolean(m.monthDayIsLast),
    monthWeekdayPosition: m.monthWeekdayPosition ?? fresh.monthWeekdayPosition,
    monthWeekday: m.monthWeekday ?? fresh.monthWeekday, cycleDaysOn: m.cycleDaysOn ?? fresh.cycleDaysOn,
    cycleDaysOff: m.cycleDaysOff ?? fresh.cycleDaysOff, startDate: m.scheduleStartDate ?? "",
    remindersEnabled: Boolean(m.remindersEnabled)
  };
}

export function isValidClockTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  return Number(value.slice(0, 2)) <= 23 && Number(value.slice(3, 5)) <= 59;
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function describeFormProblems(s) {
  const problems = [];
  if (!s.name.trim()) problems.push("Give the medication a name.");
  if (usesClockTimes(s.choice)) {
    if (s.times.length === 0) problems.push("Add at least one time of day.");
    else if (s.times.some((t) => !isValidClockTime(t))) problems.push("Enter each time of day as a real clock time, like 08:00.");
  }
  if (usesWeekdays(s) && s.weekdays.length === 0) problems.push("Pick at least one day of the week.");
  if (s.choice === "every_interval" && !Number.isInteger(s.intervalCount)) problems.push("Say how often it repeats.");
  else if (s.choice === "every_interval" && s.intervalCount < 1) problems.push("It has to repeat at least every one day, week or month.");
  if (s.choice === "monthly" && s.monthKind === "date" && !s.monthDayIsLast) {
    if (!Number.isInteger(s.monthDay) || s.monthDay < 1 || s.monthDay > 31) problems.push("Pick a day of the month between 1 and 31.");
  }
  if (s.choice === "cycle") {
    if (!Number.isInteger(s.cycleDaysOn) || s.cycleDaysOn < 1) problems.push("A cycle needs at least one day on.");
    if (!Number.isInteger(s.cycleDaysOff) || s.cycleDaysOff < 0) problems.push("Days off cannot be a negative number.");
  }
  if (s.startDate) {
    if (!isValidDateKey(s.startDate)) problems.push("Enter the start date as a real date.");
  } else if (startDateRequired(s.choice)) {
    problems.push("Pick the date this starts, so the repeat has something to count from.");
  }
  return problems;
}

export function buildCreateRequest(s) {
  const times = usesClockTimes(s.choice) ? s.times.filter((t) => t.trim().length > 0) : [];
  const startDate = s.startDate ? s.startDate : null;
  const base = { name: s.name.trim(), dosage: s.dose.trim() ? s.dose.trim() : null, startDate };
  const remind = { scheduleTimes: times, remindersEnabled: s.remindersEnabled };
  const days = [...s.weekdays].sort((a, b) => a - b);
  switch (s.choice) {
    case "as_needed": return { ...base, frequencyType: "as_needed" };
    case "daily":
      return times.length > 1
        ? { ...base, frequencyType: "times_per_day", timesPerDay: times.length, ...remind }
        : { ...base, frequencyType: "once_daily", ...remind };
    case "selected_days": return { ...base, frequencyType: "specific_weekdays", weekdays: days, ...remind };
    case "every_interval":
      return { ...base, frequencyType: "every_interval", intervalUnit: s.intervalUnit, intervalCount: s.intervalCount, weekdays: s.intervalUnit === "weeks" ? days : null, ...remind };
    case "monthly":
      return {
        ...base, frequencyType: "monthly", monthKind: s.monthKind,
        monthDay: s.monthKind === "date" && !s.monthDayIsLast ? s.monthDay : null,
        monthDayIsLast: s.monthKind === "date" ? s.monthDayIsLast : false,
        monthWeekdayPosition: s.monthKind === "weekdayPosition" ? s.monthWeekdayPosition : null,
        monthWeekday: s.monthKind === "weekdayPosition" ? s.monthWeekday : null, ...remind
      };
    default:
      return { ...base, frequencyType: "cyclical", cycleDaysOn: s.cycleDaysOn, cycleDaysOff: s.cycleDaysOff, cycleAnchorDate: startDate, ...remind };
  }
}
