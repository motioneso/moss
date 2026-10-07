/** Design artifacts only. Render shipped Moss primitives as four static states. */
import React, { type ReactNode, type CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  FormLabel,
  IconButton,
  SectionHead,
  Select,
  Switch
} from "@moss/ui";
import {
  Pause,
  Square,
  X,
  Mic,
  MicOff,
  ChevronDown,
  Check,
  Volume2,
  VolumeX,
  Laptop
} from "lucide-react";
Object.assign(globalThis, { React });
const out = resolve("docs/superpowers/specs/meetings-setup-wizard");
const stack = { display: "flex", flexDirection: "column", gap: "var(--space-5)" } as CSSProperties;
const row = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-3)"
} as CSSProperties;
function Shell({ settings = false, children }: { settings?: boolean; children: ReactNode }) {
  return (
    <>
      <header
        style={{
          ...row,
          padding: "var(--space-4) var(--space-6)",
          borderBottom: "1px solid var(--border)"
        }}
      >
        <strong style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-xl)" }}>
          moss
        </strong>
        <span className="jds-hint">{settings ? "Settings / Meetings" : "Meetings"}</span>
        <span style={{ marginLeft: "auto" }}>
          <ButtonLink variant="quiet" href={settings ? "02-ready.html" : "04-settings.html"}>
            {settings ? "Done" : "Settings"}
          </ButtonLink>
        </span>
      </header>
      <main style={{ ...stack, padding: "var(--space-6)", gap: "var(--space-7)" }}>{children}</main>
    </>
  );
}
function SourceChoice({
  label,
  group,
  checked,
  icon
}: {
  label: string;
  group: string;
  checked: boolean;
  icon: ReactNode;
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} data-source-choice={group}>
      <Check aria-hidden style={{ width: 12, height: 12, opacity: checked ? 1 : 0 }} />
      {icon}
      <span>{label}</span>
    </button>
  );
}
function Pill({
  showClose = false,
  showSources = false
}: {
  showClose?: boolean;
  showSources?: boolean;
}) {
  const icon = { width: 14, height: 14 };
  return (
    <div
      aria-label="Recording controls"
      className="meeting-recording-pill"
      data-close-visible={showClose || undefined}
      style={{
        position: "relative",
        width: 248,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-3)",
        border: "0.8px solid var(--meeting-pill-border)",
        borderRadius: "var(--radius-pill)",
        background: "var(--meeting-pill-surface)",
        boxShadow: "var(--shadow-md)"
      }}
    >
      <svg
        width="24"
        height="18"
        viewBox="0 0 32 24"
        role="img"
        aria-label="Three-bar captured audio level meter: static example"
      >
        <rect x="3" y="8" width="6" height="9" rx="3" fill="var(--danger)" />
        <rect x="13" y="1" width="6" height="22" rx="3" fill="var(--danger)" />
        <rect x="23" y="5" width="6" height="14" rx="3" fill="var(--danger)" />
      </svg>
      <IconButton
        aria-label="Recording audio sources"
        title="Recording audio sources"
        aria-haspopup="menu"
        aria-expanded={showSources}
        data-source-trigger
        style={{
          width: 36,
          height: 24,
          minWidth: 36,
          minHeight: 24,
          padding: 0,
          display: "flex",
          gap: 2,
          color: "var(--meeting-pill-pause-ink)"
        }}
      >
        <Mic style={icon} />
        <ChevronDown style={{ width: 9, height: 9 }} />
      </IconButton>
      <IconButton
        aria-label="Pause recording"
        title="Pause recording"
        style={{
          width: 24,
          height: 24,
          minWidth: 24,
          minHeight: 24,
          padding: 0,
          border: "0.8px solid var(--meeting-pill-pause-ring)",
          borderRadius: "var(--radius-pill)",
          background: "var(--meeting-pill-surface)",
          color: "var(--meeting-pill-pause-ink)"
        }}
      >
        <Pause style={{ width: 10, height: 10 }} strokeWidth={2} />
      </IconButton>
      <IconButton
        aria-label="Stop recording"
        title="Stop recording"
        style={{
          width: 24,
          height: 24,
          minWidth: 24,
          minHeight: 24,
          padding: 0,
          borderRadius: "var(--radius-pill)",
          background: "var(--danger)",
          color: "var(--white)"
        }}
      >
        <Square style={{ width: 10, height: 10 }} fill="currentColor" strokeWidth={0} />
      </IconButton>
      <span
        aria-hidden
        data-close-divider
        style={{ width: 1, height: 16, background: "var(--meeting-pill-border)" }}
      />
      <IconButton
        aria-label="Hide recording pill"
        title="Hide recording pill"
        style={{
          width: 20,
          height: 20,
          minWidth: 20,
          minHeight: 20,
          padding: 0,
          borderRadius: "var(--radius-pill)",
          background: "var(--meeting-pill-surface)",
          color: "var(--meeting-pill-pause-ink)"
        }}
      >
        <X style={{ width: 10, height: 10 }} strokeWidth={2} />
      </IconButton>
      <div
        className="jds-menu__list meeting-source-menu"
        role="menu"
        aria-label="Recording audio sources"
        hidden={!showSources}
        data-source-menu
      >
        <div role="group" aria-label="Microphone">
          <p className="jds-hint" style={{ padding: "var(--space-2) var(--space-3)" }}>
            Microphone
          </p>
          <SourceChoice
            label="None"
            group="microphone"
            checked={false}
            icon={<MicOff style={icon} />}
          />
          <SourceChoice
            label="MacBook Air Microphone"
            group="microphone"
            checked
            icon={<Laptop style={icon} />}
          />
        </div>
        <hr
          style={{
            border: 0,
            borderTop: "1px solid var(--border)",
            margin: "var(--space-2) var(--space-3)"
          }}
        />
        <div role="group" aria-label="System Audio">
          <p className="jds-hint" style={{ padding: "var(--space-2) var(--space-3)" }}>
            System Audio
          </p>
          <SourceChoice
            label="No computer audio"
            group="system"
            checked={false}
            icon={<VolumeX style={icon} />}
          />
          <SourceChoice
            label="Record computer audio"
            group="system"
            checked
            icon={<Volume2 style={icon} />}
          />
        </div>
      </div>
    </div>
  );
}

function Meeting({
  recording = false,
  showClose = false,
  showSources = false
}: {
  recording?: boolean;
  showClose?: boolean;
  showSources?: boolean;
}) {
  return (
    <Shell>
      <div style={row}>
        <SectionHead title="New meeting" titleAs="h1" />
        <span style={{ marginLeft: "auto" }}>
          <Badge tone={recording ? "red" : "forest"}>{recording ? "Recording" : "Ready"}</Badge>
        </span>
        {!recording && <Button>Start recording</Button>}
      </div>
      <p className="jds-hint">MacBook Air · Connected</p>
      <div className="meeting-columns">
        <section style={stack}>
          <SectionHead title="Transcript" rule />
          <p className="jds-hint" role="status">
            {recording ? "Listening…" : "Start when you’re ready."}
          </p>
        </section>
        <section style={stack}>
          <SectionHead title="Notes" rule />
          <textarea
            className="jds-input"
            aria-label="Notes"
            placeholder="Add a note…"
            style={{ minHeight: 300, resize: "vertical" }}
          />
        </section>
      </div>
      {recording && (
        <aside style={{ position: "fixed", bottom: "var(--space-6)", right: "var(--space-6)" }}>
          <Pill showClose={showClose} showSources={showSources} />
        </aside>
      )}
    </Shell>
  );
}
const pages = [
  {
    file: "01-not-linked",
    title: "Not linked",
    content: (
      <Shell>
        <SectionHead title="Meetings" titleAs="h1" />
        <EmptyState
          title="Link your Mac"
          description="Open Trail Marker and follow its linking instructions."
        >
          <div style={{ marginTop: "var(--space-5)" }}>
            <Button>Download app</Button>
          </div>
        </EmptyState>
      </Shell>
    )
  },
  { file: "02-ready", title: "Ready", content: <Meeting /> },
  { file: "03-recording", title: "Recording", content: <Meeting recording /> },
  {
    file: "04-settings",
    title: "Settings",
    content: (
      <Shell settings>
        <SectionHead title="Meetings" titleAs="h1" />
        <section style={{ ...stack, gap: "var(--space-7)" }}>
          <div
            style={{
              ...row,
              paddingBottom: "var(--space-5)",
              borderBottom: "1px solid var(--border)"
            }}
          >
            <strong>MacBook Air</strong>
            <Badge tone="forest">Linked</Badge>
          </div>
          <div style={{ maxWidth: 420 }}>
            <Field>
              <FormLabel htmlFor="audio-source">Audio source</FormLabel>
              <Select id="audio-source" defaultValue="computer-audio">
                <option value="computer-audio">Microphone + system audio</option>
                <option value="microphone-only">Microphone only</option>
              </Select>
            </Field>
          </div>
          <div style={{ ...stack, gap: "var(--space-3)", maxWidth: 580 }}>
            <Switch
              ariaLabel="Summarize automatically after Stop"
              label="Summarize automatically after Stop"
              checked
            />
            <p className="jds-hint">
              Send the finalized transcript and notes to your default model after Stop.
              Turn this off to use Rewrite summary only when you choose.
            </p>
          </div>
          <div>
            <Button variant="quiet">Unlink Mac</Button>
          </div>
        </section>
      </Shell>
    )
  }
];
const base = `*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:var(--text-md);line-height:var(--leading-normal)}p,h1,h2,h3{margin:0}button,a,input,select,textarea{font:inherit}.meeting-columns{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:var(--space-7)}@media(max-width:720px){.meeting-columns{grid-template-columns:minmax(0,1fr)}}`;
function document(title: string, content: ReactNode) {
  const pillStyles = title.startsWith("Recording") ? '<link rel="stylesheet" href="pill.css">' : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Moss mockup</title><link rel="stylesheet" href="moss-ui.css"><link rel="stylesheet" href="tokens.css">${pillStyles}<style>${base}</style></head><body>${renderToStaticMarkup(content)}${title.startsWith("Recording") ? '<script src="pill-preview.js"></script>' : ""}</body></html>`;
}
for (const p of pages) writeFileSync(resolve(out, p.file + ".html"), document(p.title, p.content));
// Explicit states make the transient controls reviewable without pointer interaction.
writeFileSync(
  resolve(out, "03-recording-hover.html"),
  document("Recording · Close control", <Meeting recording showClose />)
);
writeFileSync(
  resolve(out, "03-recording-sources.html"),
  document("Recording · Audio sources", <Meeting recording showSources />)
);
writeFileSync(
  resolve(out, "screens.json"),
  JSON.stringify(
    pages.map(({ file, title }) => ({ file, title })),
    null,
    2
  ) + "\n"
);
// Keep the existing static index unchanged; this renderer updates only the four screen states.
// The existing moss-ui.css is the bundled repository tokens, primitives and embedded Archivo fonts.
// It remains unchanged; opening any HTML file needs no build step or network.
readFileSync(resolve(out, "moss-ui.css"));
console.log(`Built ${pages.length} static states.`);
