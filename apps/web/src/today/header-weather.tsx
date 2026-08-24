import { Cloud, CloudRain, CloudSnow, CloudSun, Sun, Wind } from "lucide-react";
import type { ComponentType } from "react";
import type { WeatherTodayDto } from "@moss/shared";
import { WeatherChip, type WeatherDayTileProps } from "@moss/ui";

import type { WeatherIcon } from "./feed-source";

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

const WEEKDAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "short" });

export function HeaderWeather(props: { readonly weather?: WeatherTodayDto | null }) {
  const wx = props.weather ?? null;
  if (!wx) return null;

  const NowIcon = ICONS[wx.icon];
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
        label: WEEKDAY_FORMAT.format(new Date(day.date)),
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

  const href = `https://www.wunderground.com/weather/${wx.lat},${wx.lon}`;
  const city = wx.location.split(",")[0]?.trim() ?? wx.location;

  return <WeatherChip href={href} location={city} days={days} />;
}
