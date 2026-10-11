// Pure server-side HTML renderer for the Wellness selective export (#484).
//
// No React/DOM — string templating only. SECURITY-CRITICAL: every value that originates
// from user data (notes, med names, therapy-note bodies, owner name, dates, etc.) MUST go
// through `escapeHtml` before being interpolated into the document. The companion static
// test (tests/unit/wellness-export-render.test.ts) asserts that no raw payload value
// reaches the output and that the escape helper is applied at every interpolation point.
//
// Output is a self-contained, printable HTML document: a header (owner, range,
// generated-at, Moss provenance), one section per selected category (selected-but-empty
// categories render an explicit "No <category> in this range" note — never silently
// omitted, so the recipient sees the category was considered), and a footer with a
// sensitive-data warning. Print CSS is inline in a <style> tag so the file is standalone.

import type { WellnessInsightDto } from "@moss/shared";

// ── Render input shape ──────────────────────────────────────────────────────
// Decoupled from raw DB rows so the renderer is a pure, trivially-testable fn. The worker
// (export-job.ts) maps DB rows → these interfaces. A category present in `categories` but
// with an empty/missing record list renders the "no records" note.

export interface ExportCheckinItem {
  readonly checkedInAt: string | null;
  readonly feelingCore: string;
  readonly feelingSecondary: string | null;
  readonly intensity: number | null;
  readonly energy: number | null;
  readonly note: string | null;
  readonly sensations: readonly string[];
}

export interface ExportMedicationItem {
  readonly name: string;
  readonly dosage: string | null;
  readonly frequencyType: string;
  readonly scheduleTimes: readonly string[] | null;
  readonly active: boolean;
  readonly notes: string | null;
}

export interface ExportMedicationLogItem {
  readonly medicationName: string;
  readonly status: string;
  readonly dose: string | null;
  readonly prnReason: string | null;
  readonly scheduledFor: string | null;
  readonly loggedAt: string | null;
}

export interface ExportTherapyNoteItem {
  readonly createdAt: string | null;
  readonly body: string;
  readonly linkedEmotion: string | null;
}

export interface WellnessExportDocument {
  readonly ownerName: string;
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  readonly categories: {
    readonly checkins?: readonly ExportCheckinItem[] | null;
    readonly medications?: {
      readonly medications: readonly ExportMedicationItem[];
      readonly logs: readonly ExportMedicationLogItem[];
    } | null;
    readonly therapyNotes?: readonly ExportTherapyNoteItem[] | null;
    readonly insights?: readonly WellnessInsightDto[] | null;
  };
}

// ── Escaping ────────────────────────────────────────────────────────────────

/**
 * Escape a string for safe interpolation into HTML text content or a double-quoted
 * attribute. Escapes & < > " '. MUST be applied to every user-derived value before it
 * touches the document. Non-strings are coerced via String(); null/undefined → "".
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Section renderers ───────────────────────────────────────────────────────

type ExportCategoryKey = "checkins" | "medications" | "therapyNotes" | "insights";

const CATEGORY_LABELS: Readonly<Record<ExportCategoryKey, string>> = {
  checkins: "Mood check-ins",
  medications: "Medications",
  therapyNotes: "Therapy notes",
  insights: "Insights"
};

function emptySectionNote(category: string): string {
  return `    <p class="empty">No ${escapeHtml(category)} in this range.</p>\n`;
}

function renderCheckinsSection(items: readonly ExportCheckinItem[] | null | undefined): string {
  if (!items || items.length === 0) return emptySectionNote("Mood check-ins");
  const rows = items
    .map((c) => {
      const ts = escapeHtml(c.checkedInAt ?? "—");
      const core = escapeHtml(c.feelingCore);
      const secondary = c.feelingSecondary ? ` — ${escapeHtml(c.feelingSecondary)}` : "";
      const intensity = c.intensity !== null ? ` · intensity ${escapeHtml(c.intensity)}/5` : "";
      const energy = c.energy !== null ? ` · energy ${escapeHtml(c.energy)}/5` : "";
      const sensations =
        c.sensations.length > 0 ? c.sensations.map((s) => escapeHtml(s)).join(", ") : "";
      const note = c.note ? `    <p class="note">${escapeHtml(c.note)}</p>\n` : "";
      const sensationsLine = sensations
        ? `    <p class="sensations">Sensations: ${sensations}</p>\n`
        : "";
      return `  <li>
    <p class="timestamp">${ts}</p>
    <p class="feeling">${core}${secondary}${intensity}${energy}</p>
${sensationsLine}${note}  </li>`;
    })
    .join("\n");
  return `  <ul class="timeline">\n${rows}\n  </ul>\n`;
}

function renderMedicationsSection(
  data:
    | {
        readonly medications: readonly ExportMedicationItem[];
        readonly logs: readonly ExportMedicationLogItem[];
      }
    | null
    | undefined
): string {
  if (!data) return emptySectionNote("Medications");
  const { medications, logs } = data;

  const hasMeds = medications.length > 0;
  const medRows = hasMeds
    ? medications
        .map((m) => {
          const schedule =
            m.scheduleTimes && m.scheduleTimes.length > 0
              ? m.scheduleTimes.map((s) => escapeHtml(s)).join(", ")
              : "as needed";
          const dosage = m.dosage ? ` (${escapeHtml(m.dosage)})` : "";
          const state = m.active ? "active" : "inactive";
          const notes = m.notes ? `\n      <p class="note">${escapeHtml(m.notes)}</p>` : "";
          return `    <tr>
      <td>${escapeHtml(m.name)}${dosage}${notes}</td>
      <td>${escapeHtml(m.frequencyType)} — ${escapeHtml(schedule)}</td>
      <td>${escapeHtml(state)}</td>
    </tr>`;
        })
        .join("\n")
    : '    <tr><td colspan="3">' + emptySectionNote("Medications (schedule)") + "</td></tr>";

  const hasLogs = logs.length > 0;
  const logRows = hasLogs
    ? logs
        .map((l) => {
          const ts = escapeHtml(l.scheduledFor ?? l.loggedAt ?? "—");
          const reason = l.prnReason ? ` — ${escapeHtml(l.prnReason)}` : "";
          const dose = l.dose ? ` (${escapeHtml(l.dose)})` : "";
          return `    <tr>
      <td>${escapeHtml(l.medicationName)}</td>
      <td>${escapeHtml(l.status)}${dose}${reason}</td>
      <td>${ts}</td>
    </tr>`;
        })
        .join("\n")
    : '    <tr><td colspan="3">' + emptySectionNote("Medication logs") + "</td></tr>";

  return `  <h3>Medication schedule</h3>
  <table class="fixed-columns">
    <colgroup><col class="col-medication"><col class="col-schedule"><col class="col-state"></colgroup>
    <thead><tr><th>Medication</th><th>Schedule</th><th>State</th></tr></thead>
    <tbody>
${medRows}
    </tbody>
  </table>
  <h3>Medication logs</h3>
  <table class="fixed-columns">
    <colgroup><col class="col-log-medication"><col class="col-log-status"><col class="col-log-when"></colgroup>
    <thead><tr><th>Medication</th><th>Status</th><th>When</th></tr></thead>
    <tbody>
${logRows}
    </tbody>
  </table>
`;
}

function renderTherapyNotesSection(
  items: readonly ExportTherapyNoteItem[] | null | undefined
): string {
  if (!items || items.length === 0) return emptySectionNote("Therapy notes");
  const entries = items
    .map((n) => {
      const ts = escapeHtml(n.createdAt ?? "—");
      const emotion = n.linkedEmotion ? ` <em>(${escapeHtml(n.linkedEmotion)})</em>` : "";
      return `  <div class="therapy-note">
    <p class="timestamp">${ts}${emotion}</p>
    <p class="body">${escapeHtml(n.body)}</p>
  </div>`;
    })
    .join("\n");
  return `${entries}\n`;
}

function renderInsightsSection(items: readonly WellnessInsightDto[] | null | undefined): string {
  if (!items || items.length === 0) return emptySectionNote("Insights");
  const entries = items
    .map((i) => {
      const lead = escapeHtml(i.lead);
      const rest = escapeHtml(i.rest);
      const action = i.action ? `    <p class="action">${escapeHtml(i.action)}</p>\n` : "";
      return `  <div class="insight">
    <p class="lead">${lead}</p>
    <p class="rest">${rest}</p>
${action}  </div>`;
    })
    .join("\n");
  return `${entries}\n`;
}

// ── Document renderer ───────────────────────────────────────────────────────

// Frozen print palette: offline exports do not fetch app styles or remote fonts.
const PRINT_STYLE = `
  :root { --print-ink: #1a1a1a; --print-muted: #444; --print-rule: #ccc; --print-paper: #fff; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--print-ink); background: var(--print-paper); margin: 2em; font-size: 12pt; line-height: 1.5; }
  h1 { font-size: 24pt; font-weight: 900; border-bottom: 2px solid var(--print-ink); padding-bottom: .4em; line-height: 1.15; }
  h2 { font-size: 18pt; font-weight: 900; margin-top: 1.8em; border-top: 1px solid var(--print-rule); padding-top: .6em; break-after: avoid; }
  h3 { font-size: 13pt; margin-top: 1.5em; break-after: avoid; }
  .section-number { margin-right: .7em; font-size: 11pt; font-weight: 700; }
  .header-meta { color: var(--print-muted); font-size: 11pt; margin-bottom: 2em; }
  .timeline { list-style: none; padding-left: 0; }
  .timeline li { border-top: 1px solid var(--print-rule); padding: .7em 0; break-inside: avoid; }
  .timestamp { font-weight: 600; margin: 0 0 .2em; font-size: 11pt; }
  .feeling { margin: 0 0 .2em; }
  .note, .sensations { margin: .2em 0; color: var(--print-muted); font-size: 11pt; white-space: pre-wrap; overflow-wrap: anywhere; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1em; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { border-bottom: 1px solid var(--print-rule); padding: .5em .6em; text-align: left; vertical-align: top; font-size: 11pt; overflow-wrap: anywhere; }
  th { border-bottom-color: var(--print-ink); }

  /* Fixed column shares: break-anywhere cells in an auto table let long notes starve short columns. */
  .fixed-columns { table-layout: fixed; }
  .col-medication { width: 50%; }
  .col-schedule { width: 32%; }
  .col-state { width: 18%; }
  .col-log-medication { width: 34%; }
  .col-log-status { width: 36%; }
  .col-log-when { width: 30%; }

  .therapy-note, .insight { margin-bottom: 1em; }
  .body { margin: .2em 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { color: var(--print-muted); font-style: italic; }
  footer { margin-top: 3em; padding-top: 1em; border-top: 1px solid var(--print-rule); color: var(--print-muted); font-size: 11pt; }
  @page { margin: 18mm; }
  @media print { body { margin: 0; } }

`;

/**
 * Render a self-contained, printable Wellness export document. Pure: no I/O, no globals.
 * Every user-derived value is escaped via {@link escapeHtml}.
 */
export function renderWellnessExportHtml(doc: WellnessExportDocument): string {
  const cat = doc.categories;
  const sectionOrder: ReadonlyArray<{
    readonly key: ExportCategoryKey;
    readonly present: boolean;
  }> = [
    { key: "checkins", present: cat.checkins !== undefined },
    { key: "medications", present: cat.medications !== undefined },
    { key: "therapyNotes", present: cat.therapyNotes !== undefined },
    { key: "insights", present: cat.insights !== undefined }
  ];

  const sections = sectionOrder
    .filter((s) => s.present)
    .map((s, index) => {
      const sectionNumber = String(index + 1).padStart(2, "0");
      const label = escapeHtml(CATEGORY_LABELS[s.key]);
      let body: string;
      if (s.key === "checkins") body = renderCheckinsSection(cat.checkins);
      else if (s.key === "medications") body = renderMedicationsSection(cat.medications);
      else if (s.key === "therapyNotes") body = renderTherapyNotesSection(cat.therapyNotes);
      else body = renderInsightsSection(cat.insights);
      return `  <section id="${escapeHtml(s.key)}">\n    <h2><span class="section-number">${sectionNumber}</span>${label}</h2>\n${body}  </section>`;
    })
    .join("\n\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wellness export — ${escapeHtml(doc.ownerName)}</title>
  <style>${PRINT_STYLE}</style>
</head>
<body>
  <h1>Wellness export — ${escapeHtml(doc.ownerName)}</h1>
  <div class="header-meta">
    <p>Date range: ${escapeHtml(doc.from)} to ${escapeHtml(doc.to)}</p>
    <p>Generated: ${escapeHtml(doc.generatedAt)}</p>
    <p>Generated by Moss.</p>
  </div>

${sections}

  <footer>
    <p>Generated by Moss on ${escapeHtml(doc.generatedAt)}.</p>
    <p><strong>This document contains sensitive health information.</strong> Share it only with people you trust, such as your doctor or therapist.</p>
  </footer>
</body>
</html>`;
}
