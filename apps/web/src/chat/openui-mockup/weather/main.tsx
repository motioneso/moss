/** Design fixtures only. No product routes, provider calls, or stored data. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge, BrandMark, Button, Card, Divider, EmptyState, Eyebrow, Select } from "@moss/ui";
import { Cloud, CloudMoon, CloudRain, Droplets, Moon, Wind } from "lucide-react";
import "../../../styles/tokens.css";
import "@moss/ui/styles.css";
import "./weather.css";

type Design = "A" | "B" | "C";
type State = "clear" | "rain" | "partial" | "fallback";
const names = { A: "Evening curve", B: "Hour by hour", C: "The evening at a glance" };
const hours = ["5–6", "6–7", "7–8", "8–9", "9–10"];
const temps = [72, 71, 70, 69, 67] as const;
const rainyTemps = [65, 64, 62, 61, 60] as const;
const rains = [10, 20, 40, 70, 80];
function WeatherIcon({ index, rain, size = 24 }: { index: number; rain: boolean; size?: number }) {
  const Icon = rain && index > 1 ? CloudRain : index < 2 ? CloudMoon : Moon;
  return <Icon size={size} strokeWidth={1.5} aria-hidden="true" />;
}
function Forecast({ design, state }: { design: Design; state: State }) {
  const rain = state === "rain";
  const partial = state === "partial";
  const values = rain ? rainyTemps : temps;
  const temperatureAt = (index: number) => values[index] ?? values[0];
  const known = values.filter((_, i) => !partial || i !== 2);
  const range = `${Math.min(...known)}–${Math.max(...known)}`;
  const isKnown = (i: number) => !partial || i !== 2;
  const peakRain = rain ? "80%" : "10%";
  const peakWind = rain ? "16 mph" : "8 mph";
  return (
    <div className={`forecast forecast-${design}`} data-testid="forecast">
      <header className="forecast-head">
        <div>
          <Eyebrow tone="accent">{partial ? "Available hours" : "This evening"}</Eyebrow>
          <h2>Pasadena</h2>
          <p>Sun, Oct 25 · 5–10 PM PDT{design === "B" ? " · °F" : ""}</p>
        </div>
        {state === "fallback" ? (
          <Cloud size={36} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <WeatherIcon index={rain ? 3 : 1} rain={rain} size={36} />
        )}
      </header>
      {state === "fallback" ? (
        <div role="status">
          <EmptyState
            icon={<Cloud size={28} aria-hidden="true" />}
            title="Hourly forecast unavailable"
            description="Try again in a moment."
          />
        </div>
      ) : (
        <>
          {partial && (
            <div className="coverage" role="status">
              <Badge tone="amber">Partial forecast</Badge>
              <span>7–8 PM unavailable</span>
            </div>
          )}
          {design === "A" && (
            <>
              <div className="curve-summary">
                <strong>
                  {range}
                  <span>°F</span>
                </strong>
                <span>{rain ? "Rain after 7 PM" : "Mostly clear"}</span>
              </div>
              <div
                className="curve"
                role="img"
                aria-label={`${range} degrees Fahrenheit. ${hours.map((h, i) => `${h} PM: ${isKnown(i) ? values[i] + " degrees" : "unavailable"}`).join(". ")}`}
              >
                <svg viewBox="0 0 500 110" preserveAspectRatio="none" aria-hidden="true">
                  <path className="baseline" d="M 50 95 H 450" />
                  {[0, 1, 2, 3].map((i) =>
                    isKnown(i) && isKnown(i + 1) ? (
                      <path
                        className="temp-line"
                        key={i}
                        d={`M ${50 + i * 100} ${20 + (values[0] - temperatureAt(i)) * 10} L ${150 + i * 100} ${20 + (values[0] - temperatureAt(i + 1)) * 10}`}
                      />
                    ) : null
                  )}
                  {values.map((v, i) =>
                    isKnown(i) ? (
                      <circle
                        className="temp-dot"
                        key={i}
                        cx={50 + i * 100}
                        cy={20 + (values[0] - v) * 10}
                        r="4"
                      />
                    ) : null
                  )}
                </svg>
                <div className="curve-values">
                  {values.map((v, i) => (
                    <div key={i}>
                      <span>{isKnown(i) ? `${v}°` : "—"}</span>
                      {isKnown(i) ? (
                        <WeatherIcon index={i} rain={rain} size={19} />
                      ) : (
                        <span aria-hidden="true">—</span>
                      )}
                      <small>{hours[i]}</small>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          {design === "B" && (
            <div className="hour-strip">
              {values.map((v, i) => (
                <div className={`hour ${!isKnown(i) ? "hour-missing" : ""}`} key={i}>
                  <span className="hour-time">{hours[i]}</span>
                  {isKnown(i) ? (
                    <WeatherIcon index={i} rain={rain} size={29} />
                  ) : (
                    <span className="missing-icon">—</span>
                  )}
                  <strong>{isKnown(i) ? `${v}°` : "—"}</strong>
                  <span className="hour-rain">
                    <Droplets size={12} aria-hidden="true" />
                    {isKnown(i) ? `${rain ? rains[i] : [0, 0, 0, 10, 10][i]}%` : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {design === "C" && (
            <div className="headline">
              <div className="headline-number">
                <span className="range-label">
                  {partial ? "Known range · °F" : "Temperature · °F"}
                </span>
                <strong>{range}°</strong>
                <span>{rain ? "Rain into the evening" : "Mostly clear"}</span>
              </div>
              <div className="temperature-ladder" aria-label="Hourly temperatures">
                {values.map((v, i) => (
                  <div className="ladder-row" key={i}>
                    <span>{hours[i]}</span>
                    <div className="ladder-track">
                      {isKnown(i) && (
                        <div style={{ width: `${35 + (v - Math.min(...values)) * 10}%` }} />
                      )}
                    </div>
                    <strong>{isKnown(i) ? `${v}°` : "—"}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="weather-facts">
            <div>
              <Droplets size={19} aria-hidden="true" />
              <div>
                <span>Rain chance{partial ? " · known hours" : " · peak"}</span>
                <strong>{peakRain}</strong>
              </div>
            </div>
            <div>
              <Wind size={21} aria-hidden="true" />
              <div>
                <span>Wind{partial ? " · known hours" : " · peak"}</span>
                <strong>{peakWind}</strong>
              </div>
            </div>
          </div>
        </>
      )}
      <Divider />
      <footer className="source">
        {state === "fallback"
          ? "Open-Meteo · Last attempt 4:42 PM"
          : "Open-Meteo · Updated 4:42 PM"}
      </footer>
    </div>
  );
}
function App() {
  const params = new URLSearchParams(location.search);
  const [design, setDesign] = useState<Design>(
    (["A", "B", "C"].includes(params.get("design") ?? "") ? params.get("design") : "A") as Design
  );
  const [state, setState] = useState<State>(
    (["clear", "rain", "partial", "fallback"].includes(params.get("state") ?? "")
      ? params.get("state")
      : "clear") as State
  );
  const [theme, setTheme] = useState(params.get("theme") ?? "light");
  const [view, setView] = useState(params.get("view") ?? "desktop");
  const update = (key: string, value: string) => {
    const url = new URL(location.href);
    url.searchParams.set(key, value);
    history.replaceState(null, "", url);
  };
  return (
    <div
      className="review jds-theme-scope"
      data-color-mode={theme === "dark" ? "dark" : "light"}
      data-theme={theme === "sage" ? "sage" : undefined}
    >
      <header className="review-head">
        <div>
          <Eyebrow tone="accent">Moss · Design study 3736</Eyebrow>
          <h1>Weather, with a little shape.</h1>
          <p>Mockups · Synthetic forecast data</p>
        </div>
        <div className="review-controls">
          <label>
            Appearance
            <Select
              aria-label="Appearance"
              value={theme}
              onChange={(e) => {
                setTheme(e.target.value);
                update("theme", e.target.value);
              }}
            >
              <option value="light">Forest light</option>
              <option value="dark">Forest dark</option>
              <option value="sage">Sage light</option>
            </Select>
          </label>
          <label>
            Width
            <Select
              aria-label="Width"
              value={view}
              onChange={(e) => {
                setView(e.target.value);
                update("view", e.target.value);
              }}
            >
              <option value="desktop">Desktop</option>
              <option value="phone">390px phone</option>
            </Select>
          </label>
          <label>
            Forecast
            <Select
              aria-label="Forecast"
              value={state}
              onChange={(e) => {
                setState(e.target.value as State);
                update("state", e.target.value);
              }}
            >
              <option value="clear">Mostly clear</option>
              <option value="rain">Rain & wind</option>
              <option value="partial">Missing hour</option>
              <option value="fallback">Unavailable</option>
            </Select>
          </label>
        </div>
      </header>
      <nav className="design-picker" aria-label="Weather designs">
        {(["A", "B", "C"] as const).map((d) => (
          <Button
            key={d}
            variant={d === design ? "primary" : "secondary"}
            aria-pressed={d === design}
            onClick={() => {
              setDesign(d);
              update("design", d);
            }}
          >
            {d} · {names[d]}
          </Button>
        ))}
      </nav>
      <main className="stage">
        <section
          className={`chat-stage ${view === "phone" ? "phone" : ""}`}
          aria-label="Chat preview"
        >
          <header className="chat-head">
            <BrandMark />
            <strong>Moss</strong>
            <span>Chat</span>
          </header>
          <div className="conversation">
            <div className="question">Do I need a jacket this evening?</div>
            <div className="answer-head">
              <BrandMark size={18} />
              <Eyebrow tone="accent">Moss</Eyebrow>
            </div>
            {state !== "fallback" && (
              <p className="answer">
                {state === "rain"
                  ? "Yes — bring a jacket and an umbrella. It’ll be 60–65°F, with rain after 7 PM and wind up to 16 mph."
                  : state === "partial"
                    ? "A light jacket would be useful. The available hours are 67–72°F; the 7–8 PM forecast is missing."
                    : "A light jacket would be useful. It’ll cool from 72°F to 67°F through 10 PM, with light wind."}
              </p>
            )}
            {design === "A" ? (
              <Forecast design={design} state={state} />
            ) : (
              <Card padding="lg">
                <Forecast design={design} state={state} />
              </Card>
            )}
          </div>
        </section>
      </main>
      <footer className="review-foot">
        {design} / {names[design]} · {view === "phone" ? "390px" : "Expanded chat"} · Design
        fixtures only
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
