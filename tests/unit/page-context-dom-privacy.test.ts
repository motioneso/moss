// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { capturePageContextSnapshot } from "../../apps/web/src/chat/page-context.js";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

function select(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("capturePageContextSnapshot DOM privacy (#3211)", () => {
  it("leaves opted-out descendant text out of an ancestor paragraph", () => {
    document.body.innerHTML = `<p>Visible <span data-jarvis-no-capture>SECRET-A</span> tail</p>`;
    const snap = capturePageContextSnapshot();
    expect(JSON.stringify(snap)).not.toContain("SECRET-A");
    expect(snap.visibleText.join(" ")).toContain("Visible");
  });

  it("leaves hidden descendant text out of an ancestor list item", () => {
    document.body.innerHTML = `<ul><li>Shown <span hidden>SECRET-B</span><span aria-hidden="true">SECRET-C</span></li></ul>`;
    const snap = capturePageContextSnapshot();
    expect(JSON.stringify(snap)).not.toContain("SECRET-B");
    expect(JSON.stringify(snap)).not.toContain("SECRET-C");
  });

  it("drops selected text that touches an opted-out area", () => {
    document.body.innerHTML = `<div><p id="p">Before <span data-jarvis-no-capture>SECRET-D</span></p></div>`;
    select(document.getElementById("p")!);
    expect(capturePageContextSnapshot().selectedText).toBeNull();
  });

  it("drops selected text inside hidden content", () => {
    document.body.innerHTML = `<div aria-hidden="true"><p id="p">SECRET-E</p></div>`;
    select(document.getElementById("p")!);
    expect(capturePageContextSnapshot().selectedText).toBeNull();
  });

  it("keeps ordinary selected text", () => {
    document.body.innerHTML = `<p id="p">Plain words</p>`;
    select(document.getElementById("p")!);
    expect(capturePageContextSnapshot().selectedText).toBe("Plain words");
  });

  it("does not use a focused textarea's text as its label", () => {
    document.body.innerHTML = `<textarea id="t">SECRET-F draft</textarea>`;
    document.getElementById("t")!.focus();
    const snap = capturePageContextSnapshot();
    expect(JSON.stringify(snap)).not.toContain("SECRET-F");
    expect(snap.focused?.tag).toBe("textarea");
  });

  it("does not read form-control text inside a captured label", () => {
    document.body.innerHTML = `<label>Notes <textarea>SECRET-G</textarea></label>`;
    expect(JSON.stringify(capturePageContextSnapshot())).not.toContain("SECRET-G");
  });
});
