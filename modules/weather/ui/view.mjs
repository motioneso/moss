/** Pure helpers for the Weather screens. Wording follows the current Profile pane and chat card. */

export function locationHint(location, source) {
  if (!location) {
    return "No place chosen yet, so the forecast is for the main city of your time zone.";
  }
  if (source === "auto") return `Using ${location.label}, found with Use my location.`;
  if (source === "search") return `Using ${location.label}, set by searching.`;
  return `Using ${location.label}.`;
}

export const unitDescription = (unit) =>
  `Temperatures are shown in ${unit === "imperial" ? "Fahrenheit" : "Celsius"}.`;

export const savedMessage = (location) =>
  location
    ? `Weather location saved: ${location.label}.`
    : "Weather location reset to automatic detection.";

/** Message for a failed browser position request. */
export function positionFailure(error) {
  return error?.code === 1
    ? "Location access was blocked. Allow it in the browser, or search for a place."
    : "Your location couldn't be found right now. Search for a place instead.";
}

/** Asks the browser for a position, with the same limits and messages as the current app. */
export function readBrowserPosition(env = globalThis) {
  const geo = env.navigator?.geolocation;
  if (!geo) {
    return Promise.reject(
      new Error("This browser can't share your location. Search for a place instead.")
    );
  }
  if (env.isSecureContext === false) {
    return Promise.reject(
      new Error("Location sharing needs a secure (https) address. Search for a place instead.")
    );
  }
  return new Promise((resolve, reject) => {
    geo.getCurrentPosition(resolve, (e) => reject(new Error(positionFailure(e))), {
      enableHighAccuracy: false,
      timeout: 15000,
      maximumAge: 300000
    });
  });
}

/* ---- Forecast card ---- */

const clock = (at, zone) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, timeZone: zone }).format(at);

export function intervalLabel(start, end, zone) {
  const from = clock(start, zone);
  const to = clock(end, zone);
  const same = from.slice(-2) === to.slice(-2);
  return `${same ? from.slice(0, -3) : from}–${to}`;
}

const HOUR = 3600000;
const dayText = (at, zone) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: zone
  }).format(at);
const zoneName = (at, zone) =>
  new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: zone })
    .format(at)
    .split(", ")
    .at(-1);
const localDay = (at, zone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);

/** Hour starts for the window, as milliseconds. Uses the intervals the server returned plus gaps. */
function slots(v) {
  const start = Date.parse(v.requestedStart);
  const end = Date.parse(v.requestedEnd);
  const out = [];
  for (let t = start; t < end; t += HOUR) out.push(t);
  return out;
}

export function forecastPresentation(v) {
  const byStart = new Map(v.intervals.map((i) => [Date.parse(i.startsAt), i]));
  const all = slots(v);
  const labels = all.map((at) => clock(at, v.timeZone));
  const hours = all.map((at, index) => {
    const item = byStart.get(at);
    const repeated = labels.indexOf(labels[index]) !== labels.lastIndexOf(labels[index]);
    const zone = repeated ? ` ${zoneName(at, v.timeZone)}` : "";
    return {
      at,
      item,
      label: intervalLabel(at, at + HOUR, v.timeZone) + zone,
      temperature: item ? Math.round(item.temperature) : null
    };
  });
  const temperatures = v.intervals.map((i) => Math.round(i.temperature));
  const counts = new Map();
  for (const i of v.intervals) counts.set(i.condition, (counts.get(i.condition) ?? 0) + 1);
  const condition = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const start = Date.parse(v.requestedStart);
  const sameDay = localDay(Date.parse(v.retrievedAt), v.timeZone) === v.localDate;
  const evening = v.startHour >= 17 && v.endHour <= 24;
  const date = dayText(start, v.timeZone);
  return {
    hours,
    min: Math.min(...temperatures),
    max: Math.max(...temperatures),
    condition,
    day: sameDay ? (evening ? "This evening" : "Today") : date,
    window: `${date} · ${intervalLabel(start, Date.parse(v.requestedEnd), v.timeZone)} ${zoneName(start, v.timeZone)}`,
    peak: (values, unit) =>
      values.every((n) => typeof n === "number")
        ? `${Math.round(Math.max(...values))}${unit}`
        : "Unknown"
  };
}

/** Icon name for a condition, using the evening variant between 18:00 and 06:00. */
export function conditionIcon(condition, at, zone) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(at)
  );
  const night = hour >= 18 || hour < 6;
  const table = [
    [/thunder/i, "cloud-lightning"],
    [/snow|hail/i, "cloud-snow"],
    [/rain|drizzle|shower/i, "cloud-rain"],
    [/fog/i, "cloud-fog"],
    [/partly cloudy/i, night ? "cloud-moon" : "cloud-sun"],
    [/clear/i, night ? "moon" : "sun"],
    [/overcast|cloud/i, "cloud"]
  ];
  return table.find(([p]) => p.test(condition))?.[1] ?? "circle-help";
}

export const updatedTime = (v) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: v.timeZone
  }).format(Date.parse(v.retrievedAt));
