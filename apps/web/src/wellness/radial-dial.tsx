import { useId } from "react";
import { RadioCardGroup } from "@moss/ui";
import { EMOTIONS } from "./emotion-taxonomy";
import { emoColor, coreLabel, type WellnessEmotionCore, type Theme } from "./emotion-taxonomy";

function pol(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function sector(cx: number, cy: number, ri: number, ro: number, a0: number, a1: number): string {
  const [x0o, y0o] = pol(cx, cy, ro, a0);
  const [x1o, y1o] = pol(cx, cy, ro, a1);
  const [x0i, y0i] = pol(cx, cy, ri, a0);
  const [x1i, y1i] = pol(cx, cy, ri, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0o} ${y0o} A${ro} ${ro} 0 ${large} 1 ${x1o} ${y1o} L${x1i} ${y1i} A${ri} ${ri} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

interface RadialDialProps {
  value: WellnessEmotionCore | null;
  onPick: (core: WellnessEmotionCore) => void;
  theme: Theme;
}

export function RadialDial({ value, onPick, theme }: RadialDialProps) {
  const choiceName = useId();
  const cx = 150,
    cy = 150,
    ri = 92,
    ro = 130,
    pad = 2.4;
  const n = EMOTIONS.length;

  return (
    <>
      <div className="wl-dial" aria-hidden="true">
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 300 300"
          className="wl-dial__svg"
          style={{ width: "100%", maxWidth: 300, height: "auto", aspectRatio: "1" }}
        >
          {EMOTIONS.map((e, i) => {
            const a0 = i * (360 / n) + pad;
            const a1 = (i + 1) * (360 / n) - pad;
            const mid = (a0 + a1) / 2;
            const c = emoColor(e.core, theme);
            const on = value === e.core;
            const [lx, ly] = pol(cx, cy, (ri + ro) / 2, mid);
            return (
              <g
                key={e.core}
                className="wl-dial__seg"
                onClick={() => onPick(e.core)}
                style={{ cursor: "pointer" }}
              >
                <path
                  d={sector(cx, cy, ri, ro, a0, a1)}
                  fill={on ? c.tint : c.soft}
                  stroke="var(--surface)"
                  strokeWidth="2.5"
                />
                {on ? <path d={sector(cx, cy, ro + 3, ro + 5, a0, a1)} fill={c.tint} /> : null}
                <text
                  x={lx}
                  y={ly + 3.5}
                  textAnchor="middle"
                  fontSize="11"
                  fontFamily="inherit"
                  style={{
                    fill: on ? c.onTint : c.ink,
                    userSelect: "none",
                    pointerEvents: "none"
                  }}
                >
                  {coreLabel(e.core)}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="wl-dial__hub">
          <span style={{ fontSize: 11, color: "var(--text-subtle)", display: "block" }}>
            {value ? "Feeling" : "Choose"}
          </span>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
            {value ? coreLabel(value) : "How do you feel?"}
          </span>
        </div>
      </div>
      <div className="wl-emotion-choices">
        <RadioCardGroup
          name={choiceName}
          ariaLabel="Core emotion"
          value={value}
          options={EMOTIONS.map((emotion) => ({
            value: emotion.core,
            label: coreLabel(emotion.core)
          }))}
          onChange={onPick}
        />
      </div>
    </>
  );
}
