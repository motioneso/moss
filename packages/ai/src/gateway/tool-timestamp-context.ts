import { isDate, isProxy } from "node:util/types";
import { isValidTimeZone, localDayKey, timeZoneOffsetMinutes } from "@moss/module-sdk/time";

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const PRIVATE_OR_ID_KEY =
  /(?:^|[_-])(?:id|ids|token|secret|password|cursor|url)(?:$|[_-])|(?:Id|Ids|Token|Secret|Password|Cursor|Url)$/;
export const MAX_TIMESTAMP_CONTEXT_CHARS = 16_000;
const MAX_VISITED = 4_096;
const MAX_DEPTH = 24;
const MAX_REFERENCES = 512;

interface TimestampReference {
  source: string;
  localDate: string;
  localTime: string;
  utcOffsetMinutes: number;
}

function parseInstant(value: string): Date | null {
  const match = ISO_INSTANT.exec(value);
  if (!match || match[7] === "-00:00") return null;
  const [, y, m, d, h, min, sec, zone] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(h) > 23 ||
    Number(min) > 59 ||
    Number(sec) > 59
  )
    return null;
  if (zone !== "Z" && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59)) return null;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

/** Model-only references, never rewrites authoritative result data or copies arbitrary prose.
 * Only complete ISO scalar values already visible in the capped result may be referenced.
 * The supplied renderer keeps these derived values inside the existing outside-content boundary.
 */
export function renderToolTimestampContext(
  data: Record<string, unknown>,
  visibleText: string,
  timezone: string | undefined,
  render: (text: string) => string,
  maxChars = MAX_TIMESTAMP_CONTEXT_CHARS
): string | undefined {
  if (!timezone || !isValidTimeZone(timezone)) return undefined;
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const seenObjects = new WeakSet<object>();
  const seenValues = new Set<string>();
  const references: TimestampReference[] = [];
  let visited = 0;
  let eligible = 0;
  let scanLimited = false;
  const walk = (value: unknown, key = "", depth = 0): void => {
    if (++visited > MAX_VISITED || depth > MAX_DEPTH) {
      scanLimited = true;
      return;
    }
    if (PRIVATE_OR_ID_KEY.test(key) || key === "timestampContext") return;
    if (typeof value === "string") {
      if (seenValues.has(value)) return;
      const instant = parseInstant(value);
      if (!instant) {
        // Some tools return JSON inside a text block rather than as data fields.
        // Only parse a complete bounded JSON document (optionally tool-wrapped), not prose.
        if (value.length <= 16_000) {
          let json = value.trim();
          if (json.startsWith('<tool_result source="timestamp-reference">')) return;
          const wrapped = /^<tool_result(?: [^>]*)?>\n([\s\S]*)\n<\/tool_result>$/.exec(json);
          if (wrapped)
            json = wrapped[1]!
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&amp;/g, "&");
          if (json.startsWith("{") || json.startsWith("[")) {
            try {
              walk(JSON.parse(json), "", depth + 1);
            } catch {
              /* Incomplete or ambiguous text stays unchanged. */
            }
          }
        }
        return;
      }
      if (!visibleText.includes(value)) return;
      seenValues.add(value);
      eligible += 1;
      if (references.length < MAX_REFERENCES)
        references.push({
          source: value,
          localDate: localDayKey(instant, timezone),
          localTime: clock.format(instant),
          utcOffsetMinutes: timeZoneOffsetMinutes(instant, timezone)
        });
      return;
    }
    if (!value || typeof value !== "object" || isProxy(value) || seenObjects.has(value)) return;
    if (isDate(value)) {
      if (Number.isFinite(value.getTime())) walk(value.toISOString(), key, depth + 1);
      return;
    }
    seenObjects.add(value);
    for (const property of Object.keys(value)) {
      if (visited >= MAX_VISITED) {
        scanLimited = true;
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (descriptor && "value" in descriptor) walk(descriptor.value, property, depth + 1);
    }
  };
  walk(data);
  if (eligible === 0 && !scanLimited) return undefined;
  const offset = (minutes: number) => {
    const absolute = Math.abs(minutes);
    return `${minutes < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  };
  // Generated lines contain only validated timestamps, computed fields and a validated zone.
  // Keep the outside-content wrapper, without JSON quotes repeated/escaped for every field.
  const encode = () =>
    render(
      [
        `Account-local timestamp references: ${timezone}`,
        ...references.map(
          (ref) =>
            `${ref.source} = ${ref.localDate} ${ref.localTime} (UTC${offset(ref.utcOffsetMinutes)})`
        ),
        `Omitted references: ${eligible - references.length}; scan limited: ${scanLimited ? "yes" : "no"}.`
      ].join("\n")
    );
  const wireLength = (text: string) => JSON.stringify({ type: "text", text }).length;
  let text = encode();
  while (wireLength(text) > maxChars && references.length > 0) {
    references.pop();
    text = encode();
  }
  return wireLength(text) <= maxChars ? text : undefined;
}
