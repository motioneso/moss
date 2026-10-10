export type ProactiveSource = "tasks" | "calendar" | "email" | "notes";

export type ProactiveCardStatus = "active" | "dismissed" | "expired" | "suppressed";

export interface ProactiveSourcePreference {
  readonly enabled: boolean;
  readonly dailyCardCap: number;
}

export interface ProactiveMonitoringPreferenceV1 {
  readonly version: 1;
  /** An explicit unsolicited-email choice. Absent records retain legacy semantics. */
  readonly automaticEmailAlerts?: boolean;
  readonly enabled: boolean;
  readonly sources: Record<ProactiveSource, ProactiveSourcePreference>;
  readonly dailyCardCap: number;
  readonly quietHours: {
    readonly enabled: boolean;
    readonly startLocalTime: string;
    readonly endLocalTime: string;
  };
  readonly updatedAt: string;
}

export interface ProactiveCardDto {
  readonly id: string;
  readonly source: ProactiveSource;
  readonly stableKey: string;
  readonly title: string;
  readonly summary: string;
  readonly signalType: string;
  readonly priorityBand: "critical" | "high" | "normal" | "low";
  readonly priorityReasons: readonly string[];
  readonly status: ProactiveCardStatus;
  readonly occurredAt: string | null;
  readonly targetAt: string | null;
  readonly deferredUntil: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly createdAt: string;
}

export interface ProactiveCardsResponse {
  readonly cards: readonly ProactiveCardDto[];
}

export interface ProactiveRefreshResponse {
  readonly enqueued: number;
}

export interface ProactiveMonitoringSettingsDto {
  readonly settings: ProactiveMonitoringPreferenceV1;
}

export const PROACTIVE_MONITORING_PREFERENCE_KEY = "proactive.monitoring.v1";

export function defaultProactiveMonitoringPreference(): ProactiveMonitoringPreferenceV1 {
  return {
    version: 1,
    enabled: false,
    sources: {
      tasks: { enabled: false, dailyCardCap: 3 },
      calendar: { enabled: false, dailyCardCap: 3 },
      email: { enabled: false, dailyCardCap: 3 },
      notes: { enabled: false, dailyCardCap: 3 }
    },
    dailyCardCap: 8,
    quietHours: {
      enabled: true,
      startLocalTime: "22:00",
      endLocalTime: "08:00"
    },
    updatedAt: new Date(0).toISOString()
  };
}
