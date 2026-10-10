import { useId, useRef, useState, type ReactNode } from "react";

export interface WeatherDayTileProps {
  readonly label: ReactNode;
  readonly icon: ReactNode;
  readonly temp: ReactNode;
  readonly detail: ReactNode;
}

export interface WeatherChipProps {
  readonly href: string;
  readonly location: ReactNode;
  readonly days: readonly WeatherDayTileProps[];
}

interface TooltipState {
  readonly index: number;
  readonly left: number;
  readonly top: number;
}

export function WeatherChip(props: WeatherChipProps) {
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const showTooltip = (index: number, target: HTMLElement) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const tileRect = target.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    setTooltip({
      index,
      left: tileRect.left + tileRect.width / 2 - wrapperRect.left,
      top: tileRect.bottom - wrapperRect.top
    });
  };

  const hideTooltip = () => setTooltip(null);

  return (
    <div
      className="jds-weather-chip-wrapper"
      ref={wrapperRef}
      onMouseLeave={hideTooltip}
      onKeyDown={(event) => {
        if (tooltip && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          hideTooltip();
        }
      }}
    >
      <span className="jds-weather-chip__location">{props.location}</span>
      <div className="jds-weather-chip">
        {props.days.map((day, index) => (
          <a
            key={index}
            href={props.href}
            target="_blank"
            rel="noopener noreferrer"
            className="jds-weather-chip__day"
            aria-describedby={tooltip?.index === index ? tooltipId : undefined}
            onMouseEnter={(event) => showTooltip(index, event.currentTarget)}
            onFocus={(event) => showTooltip(index, event.currentTarget)}
            onBlur={hideTooltip}
          >
            <span className="jds-weather-chip__label">{day.label}</span>
            {day.icon}
            <span className="jds-weather-chip__temp">{day.temp}</span>
          </a>
        ))}
      </div>
      {tooltip ? (
        <div
          id={tooltipId}
          role="tooltip"
          className="jds-weather-chip__tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          {props.days[tooltip.index]?.detail}
        </div>
      ) : null}
    </div>
  );
}
