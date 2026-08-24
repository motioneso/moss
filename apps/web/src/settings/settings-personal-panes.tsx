import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LocaleSettingsDto,
  MeResponse,
  PutWeatherLocationRequest,
  QuietHoursSettingsDto,
  WeatherLocationDto,
  WeatherUnit
} from "@moss/shared";
import { Button } from "@moss/ui";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  getLocaleSettings,
  getQuietHoursSettings,
  putLocaleSettings,
  putQuietHoursSettings,
  updateMyProfile
} from "../api/client";
import {
  getWeatherLocationSettings,
  getWeatherUnitSettings,
  putWeatherLocationSettings,
  putWeatherUnitSettings,
  searchWeatherLocations
} from "../api/weather-client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import { DeleteAccount } from "./delete-account";
import { useFeedback } from "./settings-feedback";
import { DataExport, Sessions } from "./settings-profile-subviews";
import { readError, type PaneProps } from "./settings-types";
import {
  Avatar,
  Badge,
  Field,
  Group,
  PaneHead,
  Row,
  Segmented,
  Select,
  Switch
} from "./settings-ui";

const DEFAULT_LOCALE_SETTINGS: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "24"
};

function timeZoneOffsetMinutes(timeZone: string, date: Date): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  })
    .formatToParts(date)
    .find((entry) => entry.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d+)(?::(\d+))?/.exec(part ?? "");
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function formatTimeZoneOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

// Sorted by UTC offset (then name) and labeled with that offset, rather than
// the browser's arbitrary IANA-list order — the plain list read as unsorted noise.
const SUPPORTED_TIME_ZONES = Intl.supportedValuesOf("timeZone")
  .map((timeZone) => {
    const offsetMinutes = timeZoneOffsetMinutes(timeZone, new Date());
    return {
      timeZone,
      offsetMinutes,
      label: `(${formatTimeZoneOffset(offsetMinutes)}) ${timeZone}`
    };
  })
  .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.timeZone.localeCompare(b.timeZone));

const DEFAULT_QUIET_HOURS: QuietHoursSettingsDto = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  timezone: null
};

export function isValidQuietHoursTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

interface WeatherLocationFields {
  readonly label: string;
  readonly lat: string;
  readonly lon: string;
}

export function parseWeatherLocationFields(
  fields: WeatherLocationFields
): WeatherLocationDto | null {
  const label = fields.label.trim();
  const lat = fields.lat.trim() === "" ? Number.NaN : Number(fields.lat);
  const lon = fields.lon.trim() === "" ? Number.NaN : Number(fields.lon);
  if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { label, lat, lon };
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface ProfileFields {
  name: string;
  addressed: string;
}

function useProfileAutoSave(initial: ProfileFields) {
  const [fields, setFields] = useState<ProfileFields>(initial);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const dirty = useRef(false);
  const clearTimer = useRef<number | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!dirty.current) return;
    setStatus("saving");
    const save = window.setTimeout(() => {
      updateMyProfile({ name: fields.name, addressed: fields.addressed })
        .then((data: MeResponse) => {
          queryClient.setQueryData(queryKeys.auth.me, data);
          setStatus("saved");
          if (clearTimer.current) window.clearTimeout(clearTimer.current);
          clearTimer.current = window.setTimeout(() => setStatus("idle"), 1600);
        })
        .catch(() => {
          setStatus("error");
          if (clearTimer.current) window.clearTimeout(clearTimer.current);
          clearTimer.current = window.setTimeout(() => setStatus("idle"), 3000);
        });
    }, 600);
    return () => window.clearTimeout(save);
  }, [fields, queryClient]);

  useEffect(
    () => () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
    },
    []
  );

  const set = (patch: Partial<ProfileFields>) => {
    dirty.current = true;
    setFields((f) => ({ ...f, ...patch }));
  };
  return { fields, set, status };
}

function SaveStatusChip({ status }: { readonly status: SaveStatus }) {
  if (status === "idle") return null;
  if (status === "error") {
    return <span className="psona-save__state psona-save__state--error">Save failed</span>;
  }
  return (
    <span className="psona-save__state">
      {status === "saving" ? (
        <>
          <LoaderCircle size={13} className="dexp__spin" aria-hidden="true" />
          Saving…
        </>
      ) : (
        <>
          <Check size={13} aria-hidden="true" />
          Saved
        </>
      )}
    </span>
  );
}

export function ProfilePane({ me }: PaneProps) {
  const user = me.user;
  const role = user.isBootstrapOwner ? "Owner" : user.isInstanceAdmin ? "Admin" : "Member";
  const firstName = (user.name ?? "").split(/\s+/)[0] ?? "";
  const { fields, set, status } = useProfileAutoSave({
    name: user.name ?? "",
    addressed: me.profilePrefs.addressed ?? firstName
  });
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const assistantName = useAssistantName();
  const localeQuery = useQuery({
    queryKey: queryKeys.settings.locale,
    queryFn: getLocaleSettings,
    retry: false
  });
  const locale = localeQuery.data?.locale ?? DEFAULT_LOCALE_SETTINGS;
  const localeMutation = useMutation({
    mutationFn: (next: LocaleSettingsDto) => putLocaleSettings({ locale: next }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.locale, data);
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const quietHoursQuery = useQuery({
    queryKey: queryKeys.settings.quietHours,
    queryFn: getQuietHoursSettings,
    retry: false
  });
  const quietHours = quietHoursQuery.data?.quietHours ?? DEFAULT_QUIET_HOURS;
  const quietHoursMutation = useMutation({
    mutationFn: (next: QuietHoursSettingsDto) => putQuietHoursSettings({ quietHours: next }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.quietHours, data);
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const updateLocale = (patch: Partial<LocaleSettingsDto>) => {
    localeMutation.mutate({ ...locale, ...patch });
  };
  const updateQuietHours = (patch: Partial<QuietHoursSettingsDto>) => {
    quietHoursMutation.mutate({ ...quietHours, ...patch });
  };

  const weatherLocationQuery = useQuery({
    queryKey: queryKeys.weather.location,
    queryFn: getWeatherLocationSettings,
    retry: false
  });
  const weatherLocation = weatherLocationQuery.data?.location ?? null;
  const weatherLocationMutation = useMutation({
    mutationFn: (next: PutWeatherLocationRequest) => putWeatherLocationSettings(next),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.weather.location, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.weather.today });
      weatherLocationSearchMutation.reset();
      toast(
        data.location
          ? `Weather location saved: ${data.location.label}.`
          : "Weather location reset to automatic detection.",
        { tone: "ready" }
      );
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const [weatherLocationSearch, setWeatherLocationSearch] = useState("");
  const weatherLocationSearchMutation = useMutation({
    mutationFn: searchWeatherLocations,
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const clearWeatherLocation = () => {
    weatherLocationMutation.mutate(null);
  };
  const weatherUnitQuery = useQuery({
    queryKey: queryKeys.weather.unit,
    queryFn: getWeatherUnitSettings,
    retry: false
  });
  const weatherUnit: WeatherUnit = weatherUnitQuery.data?.unit ?? "metric";
  const weatherUnitMutation = useMutation({
    mutationFn: putWeatherUnitSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.weather.unit, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.weather.today });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const weatherUnitBusy = weatherUnitQuery.isLoading || weatherUnitMutation.isPending;

  return (
    <>
      <PaneHead
        title="Account & preferences"
        desc={`Who you are to ${assistantName}: your identity and account status. How ${assistantName} sounds and behaves lives in Assistant & AI.`}
      />
      <Group
        title="Account"
        desc="Changes save automatically."
        action={<SaveStatusChip status={status} />}
      >
        <div className="prof">
          <Avatar name={fields.name || user.email} size="lg" />
          <div className="prof__main">
            <div className="prof__name">{fields.name || "Unnamed"}</div>
            <div className="prof__email">{user.email}</div>
          </div>
          <div className="prof__badges">
            <Badge tone="neutral">{role}</Badge>
          </div>
        </div>
        <Field label="Display name">
          <input
            className="jds-input"
            value={fields.name}
            onChange={(e) => set({ name: e.target.value })}
            aria-label="Display name"
          />
        </Field>
        <Field
          label={`How ${assistantName} addresses you`}
          hint="Used in the briefing and throughout the day."
        >
          <input
            className="jds-input"
            value={fields.addressed}
            onChange={(e) => set({ addressed: e.target.value })}
            aria-label={`How ${assistantName} addresses you`}
          />
        </Field>
      </Group>

      <Group title="Location">
        <div className="fld">
          <div className="fld__lbl">Time zone</div>
          <div className="fld__row">
            <Select
              value={locale.timezone}
              aria-label="Time zone"
              disabled={localeQuery.isLoading || localeMutation.isPending}
              onChange={(event) => updateLocale({ timezone: event.currentTarget.value })}
            >
              {SUPPORTED_TIME_ZONES.map((zone) => (
                <option key={zone.timeZone} value={zone.timeZone}>
                  {zone.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="fld">
          <div className="fld__lbl">Language &amp; region</div>
          <div className="fld__row">
            <Select
              value={locale.region}
              aria-label="Language & region"
              disabled
              onChange={(event) => updateLocale({ region: event.currentTarget.value })}
            >
              <option value="en-US">English (United States)</option>
              <option value="en-GB">English (United Kingdom)</option>
              <option value="fr-FR">Français (France)</option>
              <option value="de-DE">Deutsch (Deutschland)</option>
            </Select>
          </div>
        </div>
        <div className="fld">
          <div className="fld__lbl">Date &amp; time format</div>
          <div className="fld__row">
            <Select
              value={locale.dateFormat}
              aria-label="Date and time format"
              disabled={localeQuery.isLoading || localeMutation.isPending}
              onChange={(event) =>
                updateLocale({
                  dateFormat: event.currentTarget.value as LocaleSettingsDto["dateFormat"]
                })
              }
            >
              <option value="24">13 Jun · 24-hour</option>
              <option value="12">Jun 13 · 12-hour</option>
            </Select>
          </div>
        </div>
      </Group>

      <Group
        title="Weather"
        desc="Search for a place to use instead of approximate timezone-based detection."
      >
        <Field
          label="Search for a place"
          hint="Choose a result to save it as your weather location."
        >
          <input
            className="jds-input"
            value={weatherLocationSearch}
            aria-label="Search for a weather location"
            placeholder="City, region, or country"
            disabled={weatherLocationSearchMutation.isPending || weatherLocationMutation.isPending}
            onChange={(event) => {
              setWeatherLocationSearch(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && weatherLocationSearch.trim()) {
                weatherLocationSearchMutation.mutate(weatherLocationSearch.trim());
              }
            }}
          />
        </Field>
        <Row
          name="Search"
          control={
            <Button
              size="sm"
              disabled={!weatherLocationSearch.trim() || weatherLocationSearchMutation.isPending}
              onClick={() => weatherLocationSearchMutation.mutate(weatherLocationSearch.trim())}
            >
              Search
            </Button>
          }
        />
        {weatherLocationSearchMutation.data?.candidates.map((candidate) => (
          <Row
            key={`${candidate.lat}:${candidate.lon}`}
            name={candidate.label}
            control={
              <Button
                size="sm"
                disabled={weatherLocationMutation.isPending}
                onClick={() => weatherLocationMutation.mutate(candidate)}
              >
                Use this place
              </Button>
            }
          />
        ))}
        <Row
          name="Manual override"
          desc={
            weatherLocation
              ? `Currently using ${weatherLocation.label}.`
              : "Using automatic timezone-based location."
          }
          control={
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                variant="quiet"
                size="sm"
                disabled={!weatherLocation || weatherLocationMutation.isPending}
                onClick={clearWeatherLocation}
              >
                Clear override
              </Button>
            </div>
          }
        />
        <Row
          name="Unit"
          desc={`Weather temperatures are shown in ${weatherUnit === "imperial" ? "Fahrenheit" : "Celsius"}.`}
          control={
            <Segmented
              ariaLabel="Unit"
              value={weatherUnit}
              options={[
                { value: "metric", label: "Celsius", disabled: weatherUnitBusy },
                { value: "imperial", label: "Fahrenheit", disabled: weatherUnitBusy }
              ]}
              onChange={(unit) => weatherUnitMutation.mutate(unit)}
            />
          }
        />
      </Group>

      <Group
        title="Quiet hours"
        desc={`${assistantName} stays silent during these hours — no nudges unless something is genuinely urgent.`}
      >
        <Row
          name="Enable quiet hours"
          control={
            <Switch
              ariaLabel="Enable quiet hours"
              checked={quietHours.enabled}
              disabled={quietHoursQuery.isLoading || quietHoursMutation.isPending}
              onChange={(enabled) => updateQuietHours({ enabled })}
            />
          }
        />
        <div className="fld">
          <div className="fld__lbl">From / to</div>
          <div className="fld__row">
            <input
              className="jds-input"
              type="time"
              value={quietHours.start}
              aria-label="Quiet hours from"
              disabled={quietHoursQuery.isLoading || quietHoursMutation.isPending}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isValidQuietHoursTime(value)) updateQuietHours({ start: value });
              }}
              style={{ flex: "0 0 130px", minWidth: 0 }}
            />
            <span className="fld__sep">→</span>
            <input
              className="jds-input"
              type="time"
              value={quietHours.end}
              aria-label="Quiet hours to"
              disabled={quietHoursQuery.isLoading || quietHoursMutation.isPending}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isValidQuietHoursTime(value)) updateQuietHours({ end: value });
              }}
              style={{ flex: "0 0 130px", minWidth: 0 }}
            />
          </div>
        </div>
      </Group>

      <Sessions />

      <DataExport />

      <DeleteAccount me={me} />
    </>
  );
}
