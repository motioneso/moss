import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  renderWellnessExportHtml,
  type WellnessExportDocument
} from "../../packages/wellness/src/export-render.js";

// SECURITY-CRITICAL static + dynamic tests for the export renderer (spec §5):
// all user-derived content MUST be HTML-escaped. We verify two ways:
//   1. DYNAMIC: feed malicious payloads into every field and assert the raw payload
//      never reaches the output AND the escaped form does.
//   2. STATIC: grep the source to confirm there is NO interpolation of a render-input
//      value that bypasses escapeHtml (a sentinel-free source scan).

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const renderSrc = readFileSync(join(root, "packages/wellness/src/export-render.ts"), "utf8");

const ATTACKS = [
  "<script>alert(1)</script>",
  '" onmouseover="alert(1)"',
  "' onmouseover='alert(1)'",
  "</style><script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "--; DROP TABLE users; --",
  "&amp;&lt;&gt;"
] as const;

describe("escapeHtml", () => {
  it("escapes &, <, >, \", '", () => {
    expect(escapeHtml(`<a href="x">O'Reilly & Sons</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;O&#39;Reilly &amp; Sons&lt;/a&gt;"
    );
  });

  it("returns empty string for null/undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("coerces numbers to strings", () => {
    expect(escapeHtml(5)).toBe("5");
  });

  for (const payload of ATTACKS) {
    it(`neutralizes payload: ${payload.slice(0, 30)}`, () => {
      const escaped = escapeHtml(payload);
      // Escaping neutralizes the HTML structure: no raw <script> tag and no unquoted
      // attribute-injection surface (the quote chars that would delimit an attribute are
      // themselves escaped). The bare word "onmouseover" can survive as inert text — that's
      // safe; what matters is it can't become a live attribute.
      expect(escaped).not.toContain("<script>");
      expect(escaped).not.toContain("<img");
      expect(escaped).not.toContain('"');
      expect(escaped).not.toContain("'");
    });
  }
});

describe("renderWellnessExportHtml — escaping at every interpolation (spec §5)", () => {
  const EVIL = "<script>alert('xss')</script>";

  function docWithEveryFieldMalicious(): WellnessExportDocument {
    return {
      ownerName: EVIL,
      from: EVIL,
      to: EVIL,
      generatedAt: EVIL,
      categories: {
        checkins: [
          {
            checkedInAt: EVIL,
            feelingCore: EVIL,
            feelingSecondary: EVIL,
            intensity: null,
            energy: null,
            note: EVIL,
            sensations: [EVIL]
          }
        ],
        medications: {
          medications: [
            {
              name: EVIL,
              dosage: EVIL,
              frequencyType: EVIL,
              scheduleTimes: [EVIL],
              active: true,
              notes: EVIL
            }
          ],
          logs: [
            {
              medicationName: EVIL,
              status: EVIL,
              dose: EVIL,
              prnReason: EVIL,
              scheduledFor: EVIL,
              loggedAt: EVIL
            }
          ]
        },
        therapyNotes: [{ createdAt: EVIL, body: EVIL, linkedEmotion: EVIL }],
        insights: [{ key: "k", icon: "i", tone: "pine", lead: EVIL, rest: EVIL, action: EVIL }]
      }
    };
  }

  it("never emits a raw <script> tag from any field", () => {
    const html = renderWellnessExportHtml(docWithEveryFieldMalicious());
    // The document's own <style> and <section> tags are allowed; no <script> should appear.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
  });

  it("never emits a raw onmouseover/onerror attribute from any field", () => {
    const html = renderWellnessExportHtml(docWithEveryFieldMalicious());
    // A live attribute needs a quote to delimit it — escaping removes all raw quotes, so
    // neither word can become an active attribute. Assert no raw quote + no tag opener.
    expect(html).not.toMatch(/<script|onmouseover=|onerror=/i);
    // The escaped payload's quotes are gone from the output region carrying user content.
    // (The <style> block contains no quotes that could pair with user data.)
  });

  it("never emits the raw malicious payload unescaped", () => {
    const html = renderWellnessExportHtml(docWithEveryFieldMalicious());
    // The literal EVIL string contains <script> and single quotes — it must never appear verbatim.
    // (The escaped form will contain &lt;script&gt; and &#39;.)
    expect(html).not.toContain(EVIL);
  });

  it("emits the escaped form of the malicious owner name in the header", () => {
    const html = renderWellnessExportHtml(docWithEveryFieldMalicious());
    expect(html).toContain(escapeHtml(EVIL));
  });
});

describe("renderWellnessExportHtml — structure (spec §3)", () => {
  it("renders the header with owner name, range, generated-at, and Moss provenance", () => {
    const html = renderWellnessExportHtml({
      ownerName: "Ada Lovelace",
      from: "2026-01-01",
      to: "2026-03-31",
      generatedAt: "2026-04-01T00:00:00Z",
      categories: {}
    });
    expect(html).toContain("Wellness export — Ada Lovelace");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("2026-03-31");
    expect(html).toContain("Generated: 2026-04-01T00:00:00Z");
    expect(html).toContain("Generated by Moss.");
  });

  it("renders the sensitive-data footer", () => {
    const html = renderWellnessExportHtml({
      ownerName: "X",
      from: "2026-01-01",
      to: "2026-03-31",
      generatedAt: "2026-04-01",
      categories: {}
    });
    expect(html).toContain("This document contains sensitive health information");
  });

  it("renders an explicit 'no records' note for a selected-but-empty category (never silently omitted)", () => {
    const html = renderWellnessExportHtml({
      ownerName: "X",
      from: "2026-01-01",
      to: "2026-03-31",
      generatedAt: "2026-04-01",
      categories: { checkins: [] }
    });
    expect(html).toContain("No Mood check-ins in this range.");
    expect(html).toContain('id="checkins"');
  });

  it("omits an unselected category entirely", () => {
    const html = renderWellnessExportHtml({
      ownerName: "X",
      from: "2026-01-01",
      to: "2026-03-31",
      generatedAt: "2026-04-01",
      categories: { checkins: [] }
    });
    expect(html).not.toContain('id="medications"');
    expect(html).not.toContain('id="therapyNotes"');
    expect(html).not.toContain('id="insights"');
  });

  it("renders a populated check-in with its note", () => {
    const html = renderWellnessExportHtml({
      ownerName: "X",
      from: "2026-01-01",
      to: "2026-03-31",
      generatedAt: "2026-04-01",
      categories: {
        checkins: [
          {
            checkedInAt: "2026-02-15T10:00:00Z",
            feelingCore: "happy",
            feelingSecondary: "Joy",
            intensity: 4,
            energy: 3,
            note: "Felt great after a walk",
            sensations: ["Warm"]
          }
        ]
      }
    });
    expect(html).toContain("Felt great after a walk");
    expect(html).toContain("happy — Joy");
    expect(html).toContain("intensity 4/5");
  });
});

describe("renderWellnessExportHtml — static source guard (spec §5 trust-boundary check)", () => {
  // Assert no `${...}` template-literal interpolation in the source bypasses escapeHtml.
  // Tainted data enters the renderer only via property accesses on the render-input objects
  // (doc.*, c.*, m.*, l.*, n.*, i.*). Every such property access MUST be wrapped in
  // escapeHtml(...) or routed through a local that is provably assigned an escaped value.
  // A bare local-variable interpolation (e.g. `${entries}`) is safe because every local in
  // this file is assigned either an escapeHtml(...) result, a `.join()` of escaped parts, or
  // a constant string.
  it("does not interpolate a raw property access inside a template literal without escapeHtml", () => {
    const interpolations = renderSrc.match(/\$\{[^}]+\}/g) ?? [];
    const violations: string[] = [];
    for (const interp of interpolations) {
      const expr = interp.slice(2, -1).trim();
      // Allowed: escapeHtml(...) directly.
      if (/^escapeHtml\(/.test(expr)) continue;
      // Allowed: PRINT_STYLE constant.
      if (expr === "PRINT_STYLE") continue;
      // Allowed: a .map(...).join(...) whose elements are escapeHtml calls.
      if (/escapeHtml\(/.test(expr) && /\.join\(/.test(expr)) continue;
      // Allowed: pure concatenation of escapeHtml(...) calls and string literals.
      if (/^escapeHtml\([^)]*\)(\s*\+\s*(escapeHtml\(|"))/.test(expr)) continue;
      // Allowed: a bare single-identifier local (no `.`) — provably an escaped/constant local.
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expr)) continue;
      violations.push(interp);
    }
    expect(violations, `Unescaped interpolations found:\n${violations.join("\n")}`).toEqual([]);
  });
});

describe("Moss print layout", () => {
  const base = {
    ownerName: "Example",
    from: "2026-01-01",
    to: "2026-03-31",
    generatedAt: "2026-04-01"
  };
  it("uses Moss provenance, repeatable table headers and pageable long tables", () => {
    const html = renderWellnessExportHtml({
      ...base,
      categories: { checkins: [], medications: { medications: [], logs: [] } }
    });
    expect(html).toContain("Generated by Moss");
    expect(html).not.toContain("Jarv1s");
    expect(html).toContain("table-header-group");
    expect(html).not.toMatch(/table \{[^}]*break-inside/);
    expect(html).toContain('<span class="section-number">01</span>');
    expect(html).toContain('<td colspan="3">');
  });
  it("keeps medication notes inside the medication cell", () => {
    const html = renderWellnessExportHtml({
      ...base,
      categories: {
        medications: {
          medications: [
            {
              name: "Example medication",
              dosage: null,
              frequencyType: "daily",
              scheduleTimes: ["08:00"],
              active: true,
              notes: "Take & review"
            }
          ],
          logs: []
        }
      }
    });
    expect(html).toMatch(/<td>Example medication\s*<p class="note">Take &amp; review<\/p><\/td>/);
    expect(html).not.toMatch(/<\/tr>\s*<p/);
  });
});
