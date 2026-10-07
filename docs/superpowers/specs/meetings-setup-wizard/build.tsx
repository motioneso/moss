/** Design artifacts only. Render the shipped @moss/ui primitives to static HTML. */
import React, { type ReactNode, type CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Divider,
  Eyebrow,
  Field,
  FormLabel,
  IconButton,
  Masthead,
  Note,
  RadioCardGroup,
  RowIndex,
  RowIndexItem,
  SectionHead,
  Select,
  Switch
} from "@moss/ui";
import { CAPTURE_MODES } from "../../../../packages/meetings/src/web/capture-modes.js";
import { ArrowRight, Check, Copy, Download, Laptop, Pause, Square } from "lucide-react";
Object.assign(globalThis, { React });
const out = resolve("docs/superpowers/specs/meetings-setup-wizard");
const S = { display: "flex", flexDirection: "column", gap: "var(--space-5)" } as CSSProperties;
const R = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-3)"
} as CSSProperties;
const noop = () => {};
const hint = (text: ReactNode) => (
  <p className="jds-hint" style={{ margin: 0 }}>
    {text}
  </p>
);
const stack = (children: ReactNode, style: CSSProperties = {}) => (
  <div style={{ ...S, ...style }}>{children}</div>
);
const row = (children: ReactNode, style: CSSProperties = {}) => (
  <div style={{ ...R, ...style }}>{children}</div>
);
function Pick({
  label,
  value,
  options = []
}: {
  label: string;
  value: string;
  options?: string[];
}) {
  return (
    <Field>
      <FormLabel>{label}</FormLabel>
      <Select defaultValue={value}>
        {[value, ...options].map((v) => (
          <option key={v}>{v}</option>
        ))}
      </Select>
    </Field>
  );
}
const href = (file: string) => `${file}.html`;
function Go({
  to,
  children,
  secondary = false
}: {
  to: string;
  children: ReactNode;
  secondary?: boolean;
}) {
  return (
    <ButtonLink href={href(to)} variant={secondary ? "secondary" : "primary"}>
      {children}
    </ButtonLink>
  );
}
function Section({
  number,
  title,
  children
}: {
  number?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section style={S}>
      <SectionHead number={number} title={title} rule />
      {children}
    </section>
  );
}
const pages: { file: string; title: string; content: ReactNode }[] = [];
const steps = [
  "Get the app",
  "Connect",
  "Check the link",
  "Microphone",
  "Computer audio",
  "Listen to",
  "Choose a microphone",
  "Summary",
  "Recording notice",
  "Ready"
];
function Wizard({
  step,
  title,
  lede,
  children,
  aside,
  back,
  next,
  nextLabel = "Continue"
}: {
  step: number;
  title: string;
  lede: string;
  children: ReactNode;
  aside: ReactNode;
  back?: string;
  next?: string;
  nextLabel?: string;
}) {
  return (
    <>
      {row(
        <>
          <strong style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-xl)" }}>
            moss
          </strong>
          <span className="jds-hint">Meetings</span>
          <span style={{ marginLeft: "auto" }}>
            <Button variant="quiet">Save and leave</Button>
          </span>
        </>,
        { padding: "var(--space-4) var(--space-6)" }
      )}
      <Masthead
        tone="field"
        eyebrow={`Set up meetings · Step ${step} of 10`}
        title={title}
        lede={lede}
      />
      <div style={{ padding: "var(--space-6)", ...S, gap: "var(--space-7)" }}>
        <nav
          aria-label="Setup progress"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(10,minmax(0,1fr))",
            gap: "var(--space-3)"
          }}
        >
          {steps.map((s, i) => (
            <div
              key={s}
              aria-current={i === step - 1 ? "step" : undefined}
              style={{
                ...S,
                gap: "var(--space-2)",
                paddingBottom: "var(--space-3)",
                borderBottom: `${i === step - 1 ? "3px" : "1px"} solid var(${i < step ? "--accent" : "--border"})`,
                color: `var(${i < step ? "--accent-fg" : "--text-muted"})`
              }}
            >
              <span className="jds-label">
                {i < step - 1 ? "✓" : String(i + 1).padStart(2, "0")}
              </span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: i === step - 1 ? "var(--weight-bold)" : undefined
                }}
              >
                {s}
              </span>
            </div>
          ))}
        </nav>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1.65fr) minmax(0,1fr)",
            gap: "var(--space-8)",
            alignItems: "start"
          }}
        >
          <section style={{ ...S, minHeight: 350 }}>
            {children}
            <div
              style={{
                ...R,
                marginTop: "auto",
                paddingTop: "var(--space-7)",
                borderTop: "1px solid var(--border)"
              }}
            >
              {back ? (
                <Go to={back} secondary>
                  Back
                </Go>
              ) : null}
              {next ? (
                <Go to={next}>
                  {nextLabel}
                  <ArrowRight size={16} />
                </Go>
              ) : null}
            </div>
          </section>
          <aside
            style={{ ...S, borderLeft: "1px solid var(--border)", paddingLeft: "var(--space-7)" }}
          >
            {aside}
          </aside>
        </div>
      </div>
    </>
  );
}
function AppWindow({ children, title = "Trail Marker" }: { children: ReactNode; title?: string }) {
  return (
    <Card padding="lg">
      {stack(
        <>
          <div
            style={{
              ...R,
              borderBottom: "1px solid var(--border)",
              paddingBottom: "var(--space-4)"
            }}
          >
            <Laptop size={20} />
            <strong>{title}</strong>
          </div>
          {children}
        </>
      )}
    </Card>
  );
}
const status = (title: string, text: string, tone: "forest" | "amber" = "forest") => (
  <RowIndex density="compact">
    <RowIndexItem
      title={title}
      excerpt={text}
      meta={
        <Badge tone={tone} dot>
          {tone === "forest" ? "Allowed" : "Not allowed yet"}
        </Badge>
      }
    />
  </RowIndex>
);
const add = (file: string, title: string, content: ReactNode) =>
  pages.push({ file, title, content });
add(
  "01-get-app",
  "Get Trail Marker",
  <Wizard
    step={1}
    title="First, get Trail Marker"
    lede="The small Mac app brings sound from your Mac into Moss."
    next="02-connect"
    nextLabel="I’ve opened Trail Marker"
    aside={stack(
      <>
        <Eyebrow tone="accent">On your Mac</Eyebrow>
        <AppWindow>
          {stack(
            <>
              <strong>Welcome to Trail Marker</strong>
              {hint("Connect this Mac to your Moss account.")}
              <Pick label="Moss address" value="https://moss.example.com" />
              <Button>Connect</Button>
            </>
          )}
        </AppWindow>
        {hint("Trail Marker stays in your menu bar after you close its window.")}
      </>
    )}
  >
    {stack(
      <>
        <SectionHead number="01" title="Install the Mac app" />
        <p>Download Trail Marker, move it into Applications, then open it.</p>
        {row(
          <>
            <Button icon={<Download size={17} />}>Download for Mac</Button>
            <Button variant="link">Installation help</Button>
          </>
        )}
        <Note variant="practical">
          Already have Trail Marker? Open it from Applications and continue.
        </Note>
      </>
    )}
  </Wizard>
);
add(
  "02-connect",
  "Connect your Mac",
  <Wizard
    step={2}
    title="Connect your Mac"
    lede="Open Trail Marker with this Moss address, then choose Connect."
    back="01-get-app"
    next="03-approve"
    nextLabel="I’m at the browser approval"
    aside={
      <AppWindow>
        {stack(
          <>
            <Pick label="Moss address" value="https://moss.example.com" />
            <Button>Connect</Button>
            {hint("Your browser opens to approve this Mac.")}
          </>
        )}
      </AppWindow>
    }
  >
    {stack(
      <>
        <ButtonLink href="03-approve.html">
          Open Trail Marker <ArrowRight size={16} />
        </ButtonLink>
        <Divider />
        <SectionHead title="Or copy the address" />
        {row(
          <>
            <input
              className="jds-input"
              aria-label="Your Moss address"
              readOnly
              value="https://moss.example.com"
              style={{ flex: 1, minWidth: 240 }}
            />
            <Button variant="secondary" icon={<Copy size={16} />}>
              Copy address
            </Button>
          </>
        )}
        <p>
          In Trail Marker, paste this into <strong>Moss address</strong>. Choose{" "}
          <strong>Connect</strong>.
        </p>
        {hint("If your browser asks to open the app, choose Open Trail Marker.")}
      </>
    )}
  </Wizard>
);
add(
  "03-approve",
  "Approve this Mac",
  <Wizard
    step={2}
    title="Approve this Mac in your browser"
    lede="Check the Mac name, then allow it to record meetings when you press Start."
    back="02-connect"
    next="04-waiting"
    nextLabel="I’ve approved my Mac"
    aside={stack(
      <>
        <Eyebrow tone="accent">Back in Trail Marker</Eyebrow>
        <AppWindow>
          {stack(
            <>
              <Badge tone="amber">Waiting for approval</Badge>
              <p>Finish connecting in your browser.</p>
              <Button variant="secondary">Open browser</Button>
            </>
          )}
        </AppWindow>
      </>
    )}
  >
    {
      <Card padding="lg">
        {stack(
          <>
            <SectionHead title="Connect MacBook Air?" />
            {hint("Moss · https://moss.example.com")}
            <Switch
              checked
              ariaLabel="Enable meeting recording"
              label="Enable meeting recording"
              onChange={noop}
            />
            <p>This Mac will send audio only after you press Start in Moss.</p>
            {row(
              <>
                <Go to="04-waiting">Approve Mac</Go>
                <Button variant="secondary">Cancel</Button>
              </>
            )}
          </>
        )}
      </Card>
    }
  </Wizard>
);
add(
  "04-waiting",
  "Waiting for your Mac",
  <Wizard
    step={3}
    title="Waiting for your Mac"
    lede="Keep Trail Marker open. This screen will move on when your Mac checks in."
    back="02-connect"
    aside={stack(
      <>
        <Eyebrow tone="accent">Connection</Eyebrow>
        <RowIndex density="compact">
          <RowIndexItem title="Browser approval" meta={<Badge tone="forest">Done</Badge>} />
          <RowIndexItem title="Mac connection" meta={<Badge tone="amber">Waiting</Badge>} />
        </RowIndex>
      </>
    )}
  >
    {stack(
      <>
        <SectionHead title="One moment…" />
        <p>Trail Marker is connecting to https://moss.example.com.</p>
        {hint("No need to refresh this page.")}
        <Button variant="link">My Mac hasn’t connected</Button>
      </>
    )}
  </Wizard>
);
add(
  "05-linked",
  "Your Mac is linked",
  <Wizard
    step={3}
    title="Your Mac is linked"
    lede="Now let’s check what Trail Marker can hear."
    back="02-connect"
    next="06-microphone"
    aside={
      <AppWindow>
        {stack(
          <>
            <Badge tone="forest" dot>
              Connected
            </Badge>
            <strong>MacBook Air</strong>
            {hint("https://moss.example.com")}
            {hint("Ready when you are.")}
          </>
        )}
      </AppWindow>
    }
  >
    {stack(
      <>
        <RowIndex>
          <RowIndexItem
            title="MacBook Air"
            excerpt="Connected just now"
            meta={
              <Badge tone="forest" dot>
                Linked
              </Badge>
            }
          />
        </RowIndex>
        <p>You’ll use this Mac for your meetings. You can change it later in Settings.</p>
      </>
    )}
  </Wizard>
);
add(
  "06-microphone",
  "Allow the microphone",
  <Wizard
    step={4}
    title="Allow your microphone"
    lede="This lets Trail Marker hear you when a meeting is recording."
    back="05-linked"
    aside={stack(
      <>
        <Eyebrow tone="accent">In Mac settings</Eyebrow>
        <AppWindow title="Privacy & Security">
          {stack(
            <>
              <strong>Microphone</strong>
              <Switch
                checked
                ariaLabel="Trail Marker microphone permission example"
                label="Trail Marker"
                onChange={noop}
              />
            </>
          )}
        </AppWindow>
        {hint("Turn on Trail Marker, then come back and choose Check again.")}
      </>
    )}
  >
    {stack(
      <>
        {status("Microphone", "MacBook Air", "amber")}
        {row(
          <>
            <Button>Open System Settings</Button>
            <Go to="06-microphone-allowed" secondary>
              Check again
            </Go>
          </>
        )}
      </>
    )}
  </Wizard>
);
add(
  "06-microphone-allowed",
  "Microphone allowed",
  <Wizard
    step={4}
    title="Your microphone is allowed"
    lede="Trail Marker can hear your microphone when you start recording."
    back="06-microphone"
    next="07-computer-audio"
    aside={hint("Next, allow the sound from calls and meeting apps.")}
  >
    <>{status("Microphone", "MacBook Air")}</>
  </Wizard>
);
add(
  "07-computer-audio",
  "Allow computer audio",
  <Wizard
    step={5}
    title="Allow computer audio"
    lede="Hear the other side of calls and meetings, too."
    back="06-microphone-allowed"
    aside={stack(
      <>
        <Eyebrow tone="accent">In Mac settings</Eyebrow>
        <AppWindow title="Privacy & Security">
          {stack(
            <>
              <strong>Screen & System Audio Recording</strong>
              <Switch
                checked
                ariaLabel="Trail Marker computer audio permission example"
                label="Trail Marker"
                onChange={noop}
              />
            </>
          )}
        </AppWindow>
        {hint("The setting name can vary by macOS version.")}
      </>
    )}
  >
    {stack(
      <>
        {status("Computer audio", "MacBook Air", "amber")}
        {row(
          <>
            <Button>Open System Settings</Button>
            <Go to="07-computer-audio-allowed" secondary>
              Check again
            </Go>
          </>
        )}
        <Note variant="practical">Prefer just your voice? You can skip computer audio.</Note>
        <Go to="08-listen-to" secondary>
          Use microphone only
        </Go>
      </>
    )}
  </Wizard>
);
add(
  "07-computer-audio-allowed",
  "Computer audio allowed",
  <Wizard
    step={5}
    title="Computer audio is allowed"
    lede="Trail Marker can hear sound from your Mac when you start recording."
    back="07-computer-audio"
    next="08-listen-to"
    aside={hint("Next, choose what you usually want to hear.")}
  >
    <>{status("Computer audio", "MacBook Air")}</>
  </Wizard>
);
add(
  "08-listen-to",
  "Choose what to hear",
  <Wizard
    step={6}
    title="What should Moss listen to?"
    lede="Choose a default. You can change it later in Settings."
    back="07-computer-audio"
    next="09-choose-microphone"
    aside={stack(
      <>
        <Eyebrow tone="accent">For calls and meetings</Eyebrow>
        <SectionHead title="Hear both sides" />
        <p>Microphone and computer audio records your voice and sound playing on your Mac.</p>
        <Note variant="practical">Other apps, media and notifications may be recorded.</Note>
      </>
    )}
  >
    {stack(
      <>
        <Pick
          label="Listen to"
          value="Microphone and computer audio"
          options={["Microphone only", "Microphone and one app"]}
        />
        {hint("For one app, you’ll also choose the meeting app.")}
      </>
    )}
  </Wizard>
);
add(
  "08-listen-to-one-app",
  "Listen to one app",
  <Wizard
    step={6}
    title="What should Moss listen to?"
    lede="Choose a default. You can change it later in Settings."
    back="07-computer-audio-allowed"
    next="09-choose-microphone"
    aside={hint(
      "Only your microphone and the chosen app are included. Open the app on your Mac if it is not listed."
    )}
  >
    <Pick label="Listen to" value="Microphone and one app" />
    <Pick label="Meeting app" value="Zoom" options={["Microsoft Teams"]} />
  </Wizard>
);
add(
  "09-choose-microphone",
  "Choose a microphone",
  <Wizard
    step={7}
    title="Which microphone?"
    lede="Use the microphone you usually use for calls."
    back="08-listen-to"
    next="10-summary"
    aside={stack(
      <>
        <Eyebrow tone="accent">Your Mac</Eyebrow>
        <RowIndex density="compact">
          <RowIndexItem
            title="MacBook Air"
            meta={
              <Badge tone="forest" dot>
                Connected
              </Badge>
            }
          />
          <RowIndexItem title="Microphone" meta={<Badge tone="forest">Allowed</Badge>} />
          <RowIndexItem title="Computer audio" meta={<Badge tone="forest">Allowed</Badge>} />
        </RowIndex>
        {hint("You can change the source later without repeating setup.")}
      </>
    )}
  >
    {stack(
      <>
        <Pick label="Microphone" value="MacBook Air Microphone" options={["USB microphone"]} />
        <Button variant="secondary">Check again</Button>
        {hint("Not listed? Connect your microphone and check again.")}
      </>
    )}
  </Wizard>
);
add(
  "10-summary",
  "Summary when you stop",
  <Wizard
    step={8}
    title="A summary when you stop"
    lede="Keep the decisions and next steps together with your notes."
    back="09-choose-microphone"
    next="11-notice"
    aside={stack(
      <>
        <Eyebrow tone="accent">After a meeting</Eyebrow>
        <SectionHead title="Ready to review" />
        <p>
          Moss finishes the transcript, then writes a summary and suggests tasks. You choose which
          tasks to keep.
        </p>
        {hint("Change the summary style later under Advanced in meeting settings.")}
      </>
    )}
  >
    {stack(
      <>
        <Switch
          checked
          ariaLabel="Write a summary when I stop"
          label="Write a summary when I stop"
          onChange={noop}
        />
        <p>On by default. Turn it off if you prefer to write your own.</p>
      </>
    )}
  </Wizard>
);
add(
  "11-notice",
  "Recording notice",
  <Wizard
    step={9}
    title="Before you record"
    lede="Let the people you’re speaking with know when you’re recording."
    back="10-summary"
    next="12-ready"
    nextLabel="Finish setup"
    aside={stack(
      <>
        <Eyebrow tone="accent">Asked once</Eyebrow>
        <p>
          Your acknowledgement is saved to your Moss account. You’ll see this again only if the
          notice changes.
        </p>
        {hint("You can read it any time in meeting settings.")}
      </>
    )}
  >
    {stack(
      <>
        <Note variant="practical">
          Make sure you have permission to record everyone taking part in a meeting. Follow the
          recording rules that apply to you.
        </Note>
        <Switch
          checked
          ariaLabel="Recording notice"
          label="I will tell people when I am recording"
          onChange={noop}
        />
      </>
    )}
  </Wizard>
);
add(
  "12-ready",
  "Ready meeting",
  <>
    {row(
      <>
        <strong>moss</strong>
        <Button variant="quiet">Meetings</Button>
        <span style={{ marginLeft: "auto" }}>
          <Button variant="secondary">Chat</Button>
        </span>
      </>,
      { padding: "var(--space-6)" }
    )}
    <main style={{ ...S, padding: "var(--space-6)", gap: "var(--space-7)" }}>
      {row(
        <>
          <SectionHead title="New meeting" titleAs="h1" />
          <span style={{ marginLeft: "auto" }}>
            <Badge tone="forest">Ready</Badge>
          </span>
          <Button>Start</Button>
        </>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: "var(--space-7)" }}>
        <Section title="Transcript">
          <p>Press Start when you’re ready.</p>
          {hint("MacBook Air · Microphone and computer audio")}
          {hint("Nothing is recording yet.")}
        </Section>
        <Section title="Notes">
          <textarea
            className="jds-input"
            aria-label="Notes"
            placeholder="Jot down an idea…"
            style={{ height: 300, resize: "none" }}
          />
          {hint("Saved")}
        </Section>
      </div>
    </main>
  </>
);
for (const [file, title, lede, action, to] of [
  [
    "13-mac-not-connected",
    "Your Mac hasn’t connected",
    "Open Trail Marker on your Mac and check that its Moss address is https://moss.example.com.",
    "Try connecting again",
    "02-connect"
  ],
  [
    "14-approval-expired",
    "The approval has expired",
    "Go back to Trail Marker and choose Connect to open a new approval.",
    "Open Trail Marker",
    "02-connect"
  ],
  [
    "15-permission-denied",
    "Microphone access is off",
    "Open System Settings, select Microphone, and turn on Trail Marker. Come back here to check again.",
    "Open System Settings",
    "06-microphone"
  ]
]) {
  add(
    file,
    title,
    <Wizard
      step={file === "15-permission-denied" ? 4 : 3}
      title={title}
      lede={lede}
      back="02-connect"
      aside={stack(
        <>
          <Eyebrow tone="accent">Your progress is saved</Eyebrow>
          <p>You don’t need to start setup over.</p>
          {hint("No audio is being recorded.")}
        </>
      )}
    >
      {stack(
        <>
          <Badge tone="amber">Needs your attention</Badge>
          {row(
            <>
              <Go to={to}>{action}</Go>
              <Button variant="secondary">Check again</Button>
            </>
          )}
          {file === "13-mac-not-connected"
            ? hint(
                "If Trail Marker says it is connected, check that you’re signed in to the same Moss account."
              )
            : null}
        </>
      )}
    </Wizard>
  );
}
function CurrentSettings() {
  return stack(
    <>
      <SectionHead title="Meetings" titleAs="h2" />
      {hint("Used when you press Start or Resume.")}
      <Section number="01" title="Your Mac">
        {hint("Moss listens through Trail Marker on your Mac. Linking never starts recording.")}
        <div className="meeting-settings-macs">
          <RowIndex density="compact">
            <RowIndexItem
              title="MacBook Air"
              excerpt={stack(
                <>
                  <span>Trail Marker</span>
                  <span>Last contact just now</span>
                  <span>Meeting recording enabled</span>
                  <span>Connected</span>
                </>,
                { gap: "var(--space-2)" }
              )}
              meta={stack(
                <>
                  <Badge tone="forest">Linked</Badge>
                  <Switch
                    checked
                    ariaLabel="Current meeting recording"
                    label="Meeting recording"
                    onChange={noop}
                  />
                  <Button variant="secondary">Unlink</Button>
                </>
              )}
            />
          </RowIndex>
        </div>
        <Pick label="Recording Mac" value="MacBook Air" />
        {row(
          <>
            <Button variant="link">Link a Mac or enable recording access</Button>
            <Button variant="secondary">Run setup again</Button>
          </>
        )}
        {hint(
          "Turning off meeting recording keeps the Mac linked. To enable it again, request a connection update in Trail Marker and approve it in Profile settings. Recording permission stays on until you turn it off, unlink the Mac, or its device access expires."
        )}
      </Section>
      <Section number="02" title="Recording">
        <FormLabel>Listen to</FormLabel>
        <RadioCardGroup
          name="current-mode"
          ariaLabel="Current Listen to"
          value="computer-audio"
          options={CAPTURE_MODES}
          onChange={noop}
        />
        <Pick label="Microphone" value="MacBook Air Microphone" />
        <Note variant="practical">Other apps, media and notifications may be recorded.</Note>
        {hint("Recording notice acknowledged on October 7.")}
        <Button variant="link">Review recording notice</Button>
        <RowIndex density="compact">
          <RowIndexItem title="Microphone" meta={<Badge tone="forest">Allowed</Badge>} />
          <RowIndexItem title="Computer audio" excerpt="Other people on the call" meta="Allowed" />
          <RowIndexItem title="Transcripts" meta="Ready" />
          <RowIndexItem title="Summaries" meta="Ready" />
        </RowIndex>
        {row(
          <>
            <Button variant="secondary">Check again</Button>
            <Button variant="link">AI providers</Button>
          </>
        )}
        {hint(
          "Transcripts use your configured transcription route. Summaries need an API-key model; CLI models cannot write meeting summaries today."
        )}
      </Section>
      <Section number="03" title="After a meeting">
        <Switch
          checked
          ariaLabel="Current summary preference"
          label="Write a summary when I stop"
          onChange={noop}
        />
        {hint(
          "A summary and suggested tasks appear next to your notes after the transcript finishes."
        )}
        <Pick label="Summary style" value="General meeting" />
      </Section>
      <Button>Save settings</Button>
    </>
  );
}
function NewSettings({ advanced = false }: { advanced?: boolean }) {
  return stack(
    <>
      {row(
        <>
          <SectionHead title="Meetings" titleAs="h2" />
          <span style={{ marginLeft: "auto" }}>
            <Button variant="secondary">Run setup again</Button>
          </span>
        </>
      )}
      <RowIndex density="compact">
        <RowIndexItem
          title="MacBook Air"
          excerpt="Ready to record"
          meta={
            <Badge tone="forest" dot>
              Connected
            </Badge>
          }
        />
      </RowIndex>
      <Section title="Recording">
        <Pick
          label="Listen to"
          value="Microphone and computer audio"
          options={["Microphone only", "Microphone and one app"]}
        />
        <Pick label="Microphone" value="MacBook Air Microphone" />
        {hint("Other apps, media and notifications may be recorded.")}
      </Section>
      <Section title="After a meeting">
        <Switch
          checked
          ariaLabel="Proposed summary preference"
          label="Write a summary when I stop"
          onChange={noop}
        />
      </Section>
      <Divider />
      <details open={advanced}>
        <summary
          style={{
            padding: "var(--space-3) 0",
            fontWeight: "var(--weight-semibold)",
            cursor: "pointer"
          }}
        >
          Advanced
        </summary>
        {stack(
          <>
            <Pick label="Recording Mac" value="MacBook Air" />
            <Pick label="Summary style" value="General meeting" />
            <SectionHead title="Mac access" />
            <RowIndex density="compact">
              <RowIndexItem title="Microphone" meta={<Badge tone="forest">Allowed</Badge>} />
              <RowIndexItem title="Computer audio" meta={<Badge tone="forest">Allowed</Badge>} />
            </RowIndex>
            {row(
              <>
                <Button variant="secondary">Open System Settings</Button>
                <Button variant="secondary">Check again</Button>
              </>
            )}
            <Switch
              checked
              ariaLabel="Allow meeting recording on MacBook Air"
              label="Allow meeting recording on this Mac"
              onChange={noop}
            />
            {hint("Turning this off stops meeting recording. Your Mac stays linked.")}
            <Button variant="secondary">Unlink MacBook Air</Button>
            <Divider />
            {row(
              <>
                <span className="jds-hint">Recording notice acknowledged October 7</span>
                <Button variant="link">Review notice</Button>
              </>
            )}
          </>,
          { paddingTop: "var(--space-5)" }
        )}
      </details>
      <Button>Save settings</Button>
    </>
  );
}
add(
  "16-settings-before-after",
  "Settings before and after",
  <main style={{ ...S, padding: "var(--space-6)", gap: "var(--space-7)" }}>
    <Masthead title="Fewer settings in your way" eyebrow="Design comparison" />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-8)" }}>
      {stack(
        <>
          <Eyebrow tone="muted">Current · source-based snapshot</Eyebrow>
          <CurrentSettings />
        </>
      )}
      {stack(
        <>
          <Eyebrow tone="accent">Proposed · everyday choices first</Eyebrow>
          <NewSettings />
        </>,
        { borderLeft: "1px solid var(--border)", paddingLeft: "var(--space-7)" }
      )}
    </div>
  </main>
);
add(
  "17-settings-advanced",
  "Advanced meeting settings",
  <main style={{ ...S, padding: "var(--space-6)" }}>
    <Masthead title="Meeting settings" eyebrow="Advanced open" />
    <div style={{ display: "grid", gridTemplateColumns: "1.65fr 1fr", gap: "var(--space-8)" }}>
      <NewSettings advanced />
      {stack(
        <>
          <Eyebrow tone="accent">Occasional changes</Eyebrow>
          <p>
            Change the Mac, summary style or recording access here. Everyday sound choices stay at
            the top.
          </p>
          <p>
            Run setup again walks through the existing connection and permissions without unlinking
            the Mac.
          </p>
        </>,
        { borderLeft: "1px solid var(--border)", paddingLeft: "var(--space-7)" }
      )}
    </div>
  </main>
);
function Meter({ flat = false }: { flat?: boolean }) {
  return (
    <svg
      width="32"
      height="16"
      viewBox="0 0 32 16"
      role="img"
      aria-label={flat ? "No sound arriving" : "Captured sound level"}
    >
      <path
        d={flat ? "M0 8H32" : "M2 6V10M7 3V13M12 5V11M17 1V15M22 4V12M27 6V10M32 7V9"}
        stroke="var(--accent-fg)"
        strokeWidth="2"
        fill="none"
      />
    </svg>
  );
}
function Pill({ flat = false }: { flat?: boolean }) {
  return (
    <div
      style={{
        width: 144,
        height: 36,
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "0 var(--space-2)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-pill)",
        background: "var(--surface)",
        boxShadow: "var(--shadow-md)"
      }}
    >
      <IconButton size="sm" aria-label="Stop recording" title="Stop recording">
        <Square size={12} fill="currentColor" />
      </IconButton>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "var(--radius-pill)",
          background: "var(--danger)",
          flexShrink: 0
        }}
      />
      <Meter flat={flat} />
      <span style={{ fontSize: "var(--text-2xs)", fontVariantNumeric: "tabular-nums" }}>13:24</span>
    </div>
  );
}
add(
  "18-recording-pill",
  "Smaller recording pill",
  <main style={{ ...S, padding: "var(--space-6)", gap: "var(--space-7)" }}>
    <Masthead title="Just enough to know it’s working" eyebrow="Recording pill · actual size" />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-8)" }}>
      <Section title="Current · 368 × 56">
        <div
          style={{
            width: 368,
            height: 56,
            ...R,
            flexWrap: "nowrap",
            padding: "var(--space-3)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-pill)",
            background: "var(--surface)"
          }}
        >
          <span style={{ color: "var(--danger)" }}>●</span>
          <span>
            Recording
            <br />
            <small>13:24</small>
          </span>
          <Meter />
          <IconButton aria-label="Pause">
            <Pause size={16} />
          </IconButton>
          <IconButton aria-label="Stop">
            <Square size={16} />
          </IconButton>
          <IconButton aria-label="Hide">×</IconButton>
        </div>
      </Section>
      <Section title="Proposed · 144 × 36">
        <Pill />
        {hint("25% of the current area. One button: Stop. Drag the rest of the pill to move it.")}
      </Section>
    </div>
    <Divider />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-8)" }}>
      <Section title="Sound arriving">
        <Pill />
        <p>The tiny level reflects the audio actually being captured. No looping animation.</p>
      </Section>
      <Section title="No sound arriving">
        <Pill flat />
        <p>
          The level goes flat when no fresh audio arrives. The menu bar keeps its red dot while
          recording.
        </p>
      </Section>
    </div>
    <Note variant="practical">
      Pause and Resume stay in Moss and the Trail Marker menu. These are frozen design examples, not
      measured audio or recording controls.
    </Note>
  </main>
);
function expandCSS(file: string): string {
  const path = resolve(file);
  return readFileSync(path, "utf8").replace(/@import\s+["']([^"']+)["'];/g, (_, p) =>
    expandCSS(resolve(dirname(path), p))
  );
}
mkdirSync(out, { recursive: true });
const css = (
  expandCSS("apps/web/src/styles/tokens.css") +
  "\n" +
  expandCSS("packages/ui/src/styles.css") +
  "\n" +
  expandCSS("apps/web/src/styles/components-forms.css") +
  "\n" +
  expandCSS("packages/meetings/src/web/meeting-settings.css")
).replace(
  /url\("\/fonts\/archivo\/([^"]+)"\)/g,
  (_, name) =>
    `url("data:font/woff2;base64,${readFileSync(resolve("apps/web/public/fonts/archivo", name)).toString("base64")}")`
);
writeFileSync(resolve(out, "moss-ui.css"), css);
copyFileSync("apps/web/public/fonts/archivo/OFL.txt", resolve(out, "FONT-LICENSE.txt"));
const base = `*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:var(--text-md);line-height:var(--leading-normal)}p{margin:0}h1,h2,h3{margin:0}button,a,input,select,textarea{font:inherit}`;
for (const p of pages)
  writeFileSync(
    resolve(out, p.file + ".html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${p.title} · Moss mockup</title><link rel="stylesheet" href="moss-ui.css"><style>${base}</style><body>${renderToStaticMarkup(p.content)}</body></html>`
  );
writeFileSync(
  resolve(out, "screens.json"),
  JSON.stringify(
    pages.map(({ file, title }) => ({ file, title })),
    null,
    2
  ) + "\n"
);
writeFileSync(
  resolve(out, "index.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Moss setup mockups</title><link rel="stylesheet" href="moss-ui.css"><style>${base}</style><body style="padding:var(--space-7)">${renderToStaticMarkup(
    stack(
      <>
        <Masthead
          title="Meetings, from the first click"
          lede="Static design review. No connection, permissions or recording actions are performed."
        />
        {pages.map((p) => (
          <a href={href(p.file)} key={p.file}>
            {p.file} · {p.title}
          </a>
        ))}
      </>
    )
  )}</body></html>`
);
console.log(`Built ${pages.length} static screens from @moss/ui.`);
