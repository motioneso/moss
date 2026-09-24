import { Cloud, CloudRain, CloudSnow, CloudSun, Sun, Wind } from "lucide-react";
import type { ComponentType } from "react";
import { Link } from "react-router";
import type { WeatherTodayDto } from "@moss/shared";
import { WeatherChip, type WeatherDayTileProps } from "@moss/ui";

import { formatDate, useUserLocale } from "../locale/locale-format.js";
import type { WeatherIcon } from "./feed-source";
import type { TodayMode } from "./evening-mode.js";

const ICONS: Record<
  WeatherIcon,
  ComponentType<{ readonly size?: number; readonly color?: string }>
> = {
  sun: Sun,
  cloud: Cloud,
  "cloud-sun": CloudSun,
  "cloud-rain": CloudRain,
  "cloud-snow": CloudSnow,
  wind: Wind
};

const ICON_COLOR: Record<WeatherIcon, string> = {
  sun: "var(--gold)",
  cloud: "var(--steel)",
  "cloud-sun": "var(--steel)",
  "cloud-rain": "var(--steel)",
  "cloud-snow": "var(--steel)",
  wind: "var(--steel)"
};

const WEEKDAY_OPTS: Intl.DateTimeFormatOptions = { weekday: "short" };

export function TodayWeatherRow(props: {
  readonly weather: WeatherTodayDto | null | undefined;
  readonly mode: TodayMode;
  readonly isPending: boolean;
  readonly isError: boolean;
}) {
  const locale = useUserLocale();
  if (props.isPending) return null;
  const wx = props.weather ?? null;
  if (!wx || props.isError) {
    return (
      <p className="cmd-empty" role="status">
        Weather isn&apos;t available right now.{" "}
        <Link to="/settings?section=profile">Weather settings</Link>
      </p>
    );
  }

  const unitSymbol = wx.unit === "metric" ? "C" : "F";
  const NowIcon = ICONS[wx.icon];
  const first = wx.forecast[0] ?? null;
  const days: WeatherDayTileProps[] = [
    {
      label: "Now",
      icon: <NowIcon size={16} color={ICON_COLOR[wx.icon]} />,
      temp: `${wx.temp}°`,
      detail: (
        <>
          <div>{wx.condition}</div>
          <div>
            {wx.temp}°, feels like {wx.feelsLike}°
          </div>
          <div>Humidity {wx.humidity}%</div>
          <div>Dew point {wx.dewPoint}°</div>
          <div>Wind {wx.windSpeed}</div>
        </>
      )
    },
    ...wx.forecast.map((day) => {
      const DayIcon = ICONS[day.icon];
      return {
        label: formatDate(day.date, locale, WEEKDAY_OPTS),
        icon: <DayIcon size={16} color={ICON_COLOR[day.icon]} />,
        temp: `${day.high}°/${day.low}°`,
        detail: (
          <div>
            High {day.high}° / Low {day.low}°
          </div>
        )
      };
    })
  ];

  // Morning hero: the study weather row, current conditions and today's range.
  if (props.mode === "day") {
    return (
      <>
        <div className="wx-now">
          <NowIcon aria-hidden="true" />
          <strong>
            {`${wx.temp}°`}
            <small>{unitSymbol}</small>
          </strong>
        </div>
        <div className="wx-outlook">
          <strong>{wx.condition}</strong>
          {first !== null ? <span>{`High ${first.high}° · Low ${first.low}°`}</span> : null}
        </div>
      </>
    );
  }

  const href = `https://www.wunderground.com/weather/${wx.lat},${wx.lon}`;
  const city = wx.location.split(",")[0]?.trim() ?? wx.location;

  return (
    <>
      <div className="wx-row">
        <NowIcon size={24} color={ICON_COLOR[wx.icon]} aria-hidden="true" />
        <div>
          <div className="jds-brief__title">{`${wx.temp}°${unitSymbol}`}</div>
          <div>{wx.condition}</div>
          {first !== null ? (
            <div>
              {props.mode === "evening"
                ? `Overnight low ${first.low}°`
                : `High ${first.high}° · Low ${first.low}°`}
            </div>
          ) : null}
        </div>
      </div>
      <WeatherChip href={href} location={city} days={days} />
    </>
  );
}
