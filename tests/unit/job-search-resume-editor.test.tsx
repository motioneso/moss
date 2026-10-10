// tests/unit/job-search-resume-editor.test.tsx
//
// Task #108: the résumé upload/replace UI (resume-editor.tsx). `.tsx` test files are not
// typechecked (issue #1335 — fixtures drift silently), so this suite is the only proof the
// component actually behaves as documented, not just that it compiles.
//
// Mocks `./resume-save` (the one seam ResumeEditor treats as opaque) rather than `../api`
// directly — resume-save.ts already has its own transport (uploadResumeAttachment -> runQueue)
// documented and is exercised indirectly by job-search-profile.test.tsx's `api.runQueue` mock;
// this file is about the UI state machine (idle -> editing -> [confirming] -> saving ->
// feedback), not the transport underneath it.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../external-modules/job-search/src/web/screens/resume-save", () => ({
  saveResume: vi.fn()
}));

// The editor re-reads the résumé after a queued save to find out whether the worker actually
// wrote it — that is the whole of the success state. Mocking the transport lets a test hand back
// a bumped version and assert the "Saved" line, and leaves every other test with a read that
// resolves to nothing, which is the same as "the worker hasn't got to it yet".
vi.mock("../../external-modules/job-search/src/web/api", () => ({
  invokeTool: vi.fn(async () => ({ resume: null }))
}));

import {
  ResumeSection,
  type ResumeState
} from "../../external-modules/job-search/src/web/screens/resume-editor";
import * as resumeSave from "../../external-modules/job-search/src/web/screens/resume-save";
import * as api from "../../external-modules/job-search/src/web/api";

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function flatten(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  if (typeof node === "object" && "children" in (node as { children?: unknown })) {
    return flatten((node as { children?: unknown }).children);
  }
  return "";
}

function text(renderer: ReactTestRenderer): string {
  return flatten(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

// The résumé facts block always renders a literal "Saved on" row, so a plain text scan for
// "Saved" can never distinguish "the success badge is on screen" from "the stats table exists".
// The success state is the forest badge specifically, so assert on that.
function hasSavedBadge(renderer: ReactTestRenderer): boolean {
  return (
    renderer.root.findAll((node) =>
      String((node.props as { className?: string }).className ?? "")
        .split(" ")
        .includes("jds-badge--forest")
    ).length > 0
  );
}

function buttons(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => typeof node.type === "string" && node.type === "button");
}

function findButton(renderer: ReactTestRenderer, matcher: RegExp, className?: RegExp) {
  const match = buttons(renderer).find((node) => {
    if (!matcher.test(flatten(node.props.children))) return false;
    if (className && !className.test(String(node.props.className ?? ""))) return false;
    return true;
  });
  expect(match, `expected a button matching ${matcher} ${className ?? ""}`).toBeDefined();
  return match!;
}

function findTextarea(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => typeof node.type === "string" && node.type === "textarea"
  )[0];
}

function findFileInput(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => typeof node.type === "string" && node.type === "input" && node.props.type === "file"
  )[0];
}

async function renderSection(
  state: ResumeState,
  onSaved: () => void = vi.fn()
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ResumeSection, { profileId: "p1", state, onSaved }));
  });
  return renderer;
}

describe("ResumeSection / ResumeEditor", () => {
  beforeEach(() => {
    vi.mocked(resumeSave.saveResume).mockReset();
    vi.mocked(api.invokeTool).mockReset();
    vi.mocked(api.invokeTool).mockResolvedValue({ resume: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the empty state with an 'Add résumé' trigger and no confirm gate on first save", async () => {
    vi.mocked(resumeSave.saveResume).mockResolvedValue({ kind: "queued" });
    const onSaved = vi.fn();

    const renderer = await renderSection({ status: "ready", resume: null }, onSaved);
    expect(text(renderer)).toContain("None yet");
    expect(text(renderer)).toContain("Add résumé");

    await act(async () => {
      findButton(renderer, /^Add résumé$/).props.onClick();
    });
    await flush();

    const textarea = findTextarea(renderer);
    await act(async () => {
      textarea.props.onChange({ target: { value: "Some pasted résumé text" } });
    });
    await flush();

    await act(async () => {
      findButton(renderer, /^Save résumé$/).props.onClick();
    });
    await flush();

    // Nothing on file yet, so no confirm dialog — saveResume is called directly.
    expect(resumeSave.saveResume).toHaveBeenCalledWith("p1", {
      kind: "text",
      content: "Some pasted résumé text"
    });
    // Enqueue only proves the queue accepted it, so the screen says "Saving", not "Saved", and
    // does not refetch yet — onSaved fires when the watch below sees the worker's write land.
    expect(onSaved).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Saving your résumé…");
    expect(hasSavedBadge(renderer)).toBe(false);
  });

  it("renders the on-file facts (version, saved-on, length) when a résumé exists", async () => {
    const renderer = await renderSection({
      status: "ready",
      resume: { version: 4, updatedAt: "2026-07-20T00:00:00.000Z", length: 850 }
    });

    const rendered = text(renderer);
    expect(rendered).toContain("Replace résumé");
    expect(rendered).toContain("4");
    expect(rendered).toContain("Jul 20");
    expect(rendered).toContain("850 characters");
    expect(rendered).not.toContain("None yet");
  });

  it("gates a replace behind an explicit confirm step naming what gets cleared", async () => {
    vi.mocked(resumeSave.saveResume).mockResolvedValue({ kind: "queued" });

    const renderer = await renderSection({
      status: "ready",
      resume: { version: 1, updatedAt: "2026-07-01T00:00:00.000Z", length: 100 }
    });

    await act(async () => {
      findButton(renderer, /^Replace résumé$/, /jds-btn--secondary/).props.onClick();
    });
    await flush();

    const textarea = findTextarea(renderer);
    await act(async () => {
      textarea.props.onChange({ target: { value: "New résumé text" } });
    });
    await flush();

    await act(async () => {
      findButton(renderer, /^Save résumé$/).props.onClick();
    });
    await flush();

    // Confirm dialog up, save not yet called.
    expect(resumeSave.saveResume).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Replace résumé?");
    expect(text(renderer)).toContain("scored again against the new");
    expect(text(renderer)).not.toContain("stays exactly as it is");

    await act(async () => {
      findButton(renderer, /^Replace résumé$/, /jds-btn--danger/).props.onClick();
    });
    await flush();

    expect(resumeSave.saveResume).toHaveBeenCalledWith("p1", {
      kind: "text",
      content: "New résumé text"
    });
  });

  it("reads an uploaded .md file client-side via File.text() into the draft", async () => {
    const renderer = await renderSection({ status: "ready", resume: null });

    await act(async () => {
      findButton(renderer, /^Add résumé$/).props.onClick();
    });
    await flush();

    const fakeFile = {
      name: "resume.md",
      size: 42,
      text: async () => "Content read from the file"
    };
    const fileInput = findFileInput(renderer);
    await act(async () => {
      fileInput.props.onChange({ target: { files: [fakeFile], value: "resume.md" } });
    });
    await flush();

    expect(findTextarea(renderer).props.value).toBe("Content read from the file");
  });

  it("rejects an unsupported file extension without touching the draft", async () => {
    const renderer = await renderSection({ status: "ready", resume: null });

    await act(async () => {
      findButton(renderer, /^Add résumé$/).props.onClick();
    });
    await flush();

    // .rtf is genuinely unsupported — .pdf/.docx moved to the supported binary branch (#112).
    const fakeFile = { name: "resume.rtf", size: 42, text: async () => "should not be read" };
    const fileInput = findFileInput(renderer);
    await act(async () => {
      fileInput.props.onChange({ target: { files: [fakeFile], value: "resume.rtf" } });
    });
    await flush();

    expect(text(renderer)).toContain("Only .txt, .md, .pdf, and .docx files are supported.");
    expect(findTextarea(renderer).props.value).toBe("");
  });

  it("uploads a .pdf as raw bytes with application/pdf, deriving mime from the extension", async () => {
    vi.mocked(resumeSave.saveResume).mockResolvedValue({ kind: "queued" });
    const onSaved = vi.fn();

    const renderer = await renderSection({ status: "ready", resume: null }, onSaved);

    await act(async () => {
      findButton(renderer, /^Add résumé$/).props.onClick();
    });
    await flush();

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fakeFile = {
      name: "resume.pdf",
      size: pdfBytes.byteLength,
      // A PDF is binary — this branch must never call File.text() on it.
      text: async () => {
        throw new Error("should never read a PDF via File.text()");
      },
      arrayBuffer: async () => pdfBytes.buffer
    };
    const fileInput = findFileInput(renderer);
    await act(async () => {
      fileInput.props.onChange({ target: { files: [fakeFile], value: "resume.pdf" } });
    });
    await flush();

    // Nothing to preview — the editor names the file on the picker row and defers to save,
    // rather than filling the textarea. The name is what Ben asked to see there instead of the
    // browser's stale "No file selected" (2026-07-29).
    expect(text(renderer)).toContain("resume.pdf");
    expect(text(renderer)).not.toContain("No file chosen");
    expect(text(renderer)).toContain("The text is extracted from this file when it saves.");
    expect(findTextarea(renderer).props.value).toBe("");

    await act(async () => {
      findButton(renderer, /^Save résumé$/).props.onClick();
    });
    await flush();

    expect(resumeSave.saveResume).toHaveBeenCalledWith("p1", {
      kind: "binary",
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      bytes: pdfBytes.buffer
    });
    expect(text(renderer)).toContain("Saving your résumé…");
  });

  it("refuses a file over the 10 MB limit client-side, without reading it", async () => {
    const renderer = await renderSection({ status: "ready", resume: null });

    await act(async () => {
      findButton(renderer, /^Add résumé$/).props.onClick();
    });
    await flush();

    const fakeFile = {
      name: "resume.pdf",
      size: 10 * 1024 * 1024 + 1,
      text: async () => "should not be read",
      arrayBuffer: async () => {
        throw new Error("should never read an oversize file");
      }
    };
    const fileInput = findFileInput(renderer);
    await act(async () => {
      fileInput.props.onChange({ target: { files: [fakeFile], value: "resume.pdf" } });
    });
    await flush();

    expect(text(renderer)).toContain("larger than the 10 MB limit");
    expect(findTextarea(renderer).props.value).toBe("");
  });

  it("shows a real error state and keeps the draft when the save fails", async () => {
    vi.mocked(resumeSave.saveResume).mockResolvedValue({
      kind: "error",
      message: "Couldn't upload the résumé. Try again."
    });
    const onSaved = vi.fn();

    const renderer = await renderSection({ status: "ready", resume: null }, onSaved);

    await act(async () => {
      findButton(renderer, /^Add résumé$/).props.onClick();
    });
    await flush();

    const textarea = findTextarea(renderer);
    await act(async () => {
      textarea.props.onChange({ target: { value: "Draft that should survive a failed save" } });
    });
    await flush();

    await act(async () => {
      findButton(renderer, /^Save résumé$/).props.onClick();
    });
    await flush();

    expect(text(renderer)).toContain("Couldn't upload the résumé. Try again.");
    expect(onSaved).not.toHaveBeenCalled();
    // Still in the editor, draft intact — a failed save doesn't cost the user their paste/upload.
    expect(findTextarea(renderer).props.value).toBe("Draft that should survive a failed save");
  });

  it("treats already-queued the same as queued — honest 'queued', never 'saved'", async () => {
    vi.mocked(resumeSave.saveResume).mockResolvedValue({ kind: "already-queued" });
    const onSaved = vi.fn();

    const renderer = await renderSection({ status: "ready", resume: null }, onSaved);

    await act(async () => {
      findButton(renderer, /^Add résumé$/).props.onClick();
    });
    await flush();

    const textarea = findTextarea(renderer);
    await act(async () => {
      textarea.props.onChange({ target: { value: "Some résumé text" } });
    });
    await flush();

    await act(async () => {
      findButton(renderer, /^Save résumé$/).props.onClick();
    });
    await flush();

    expect(onSaved).not.toHaveBeenCalled();
    expect(text(renderer)).toContain("Saving your résumé…");
    expect(hasSavedBadge(renderer)).toBe(false);
  });
  it("turns a queued save into a real 'Saved' state once the worker's write shows up", async () => {
    // Ben's fifth finding: "after saving it says it is queued for saving, and the user doesn't
    // know what to do. There's no success so the user doesn't know if they need to stay on the
    // page, try again, etc." Ruling I5 still holds — the queue never resolves "done" — so the
    // proof has to be observed, and this is that observation: the résumé's version moving past
    // the one that was on screen when the save was queued.
    vi.useFakeTimers();
    try {
      vi.mocked(resumeSave.saveResume).mockResolvedValue({ kind: "queued" });
      const onSaved = vi.fn();
      const renderer = await renderSection(
        {
          status: "ready",
          resume: { version: 2, updatedAt: "2026-07-20T00:00:00.000Z", length: 10 }
        },
        onSaved
      );

      await act(async () => {
        findButton(renderer, /^Replace résumé$/).props.onClick();
      });
      await act(async () => {
        findTextarea(renderer).props.onChange({ target: { value: "New résumé text" } });
      });
      await act(async () => {
        findButton(renderer, /^Save résumé$/).props.onClick();
      });
      await act(async () => {
        findButton(renderer, /^Replace résumé$/, /danger/).props.onClick();
      });

      expect(text(renderer)).toContain("Saving your résumé…");
      expect(onSaved).not.toHaveBeenCalled();

      // The worker hasn't written yet — still the same version, so still "Saving".
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(hasSavedBadge(renderer)).toBe(false);

      // Now it has.
      vi.mocked(api.invokeTool).mockResolvedValue({
        resume: { version: 3, content: "New résumé text", updatedAt: "2026-07-29T00:00:00.000Z" }
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(hasSavedBadge(renderer)).toBe(true);
      // The one thing the old dead end never told them.
      expect(text(renderer)).toContain("You can leave this page.");
      expect(onSaved).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
