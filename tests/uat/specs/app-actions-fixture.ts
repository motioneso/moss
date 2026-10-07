import type { AestheticThemeTokens } from "@moss/shared";

export const APP_ACTION_THEME = {
  id: "uat-3065-midnight-fern",
  name: "UAT Midnight Fern",
  tokens: {
    paper: "#14251c",
    surface: "#1c3024",
    surface2: "#223a2b",
    surface3: "#2b4634",
    ink: "#f3f8ef",
    ink2: "#d8e8cf",
    ink3: "#b7cbae",
    ink4: "#91a789",
    line: "#496442",
    lineSubtle: "#354d30",
    lineStrong: "#75956b",
    accent: "#b5db87"
  } satisfies AestheticThemeTokens
} as const;

export const APP_ACTION_PROMPT = `Switch my theme to ${APP_ACTION_THEME.name}.`;
export const APP_ACTION_REPLY = `Your theme is now ${APP_ACTION_THEME.name}.`;
export const APP_ACTION_THEME_PATH = "/api/me/themes/active";

export interface ThemePutEvidence {
  readonly requestId: string;
  readonly method: "PUT";
  readonly path: typeof APP_ACTION_THEME_PATH;
  readonly statusCode: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read real Fastify request logs, including its in-process act-as requests. No payloads copied. */
export function themePutEvidence(log: string): readonly ThemePutEvidence[] {
  const entries = log.split("\n").flatMap((line): Record<string, unknown>[] => {
    // Docker Compose may prefix a JSON line with the service name and a pipe.
    const start = line.indexOf("{");
    if (start < 0) return [];
    try {
      const entry: unknown = JSON.parse(line.slice(start));
      return isRecord(entry) ? [entry] : [];
    } catch {
      return [];
    }
  });
  const statuses = new Map<string, number>();
  for (const entry of entries) {
    if (
      entry.msg === "request completed" &&
      typeof entry.reqId === "string" &&
      isRecord(entry.res) &&
      typeof entry.res.statusCode === "number"
    ) {
      statuses.set(entry.reqId, entry.res.statusCode);
    }
  }
  return entries.flatMap((entry): ThemePutEvidence[] => {
    if (
      entry.msg !== "incoming request" ||
      typeof entry.reqId !== "string" ||
      !isRecord(entry.req) ||
      entry.req.method !== "PUT" ||
      entry.req.url !== APP_ACTION_THEME_PATH
    ) {
      return [];
    }
    return [
      {
        requestId: entry.reqId,
        method: "PUT",
        path: APP_ACTION_THEME_PATH,
        statusCode: statuses.get(entry.reqId) ?? null
      }
    ];
  });
}
