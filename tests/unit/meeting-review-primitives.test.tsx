import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadioCardGroup, RowIndex, RowIndexItem, Switch, Tabs } from "@moss/ui";
let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
describe("meeting review shared primitives", () => {
  it("offers compact factual rows without changing the default RowIndex", () => {
    const row = <RowIndexItem title="Transcript" meta="2 retained turns" />;
    expect(renderToStaticMarkup(<RowIndex>{row}</RowIndex>)).not.toContain("jds-index--facts");
    const facts = renderToStaticMarkup(<RowIndex variant="facts">{row}</RowIndex>);
    expect(facts).toContain("jds-index--facts");
    expect(facts).toContain("2 retained turns");
    expect(facts).not.toContain("button");
  });
  it("keeps panels mounted with tab relationships and keyboard navigation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const change = vi.fn();
    const items = [
      { value: "summary", label: "Summary", content: <input defaultValue="Unsaved" /> },
      { value: "notes", label: "Notes", count: 1, content: <p>Notes</p> }
    ];
    await act(async () => {
      renderer = create(
        <Tabs id="review" ariaLabel="Review" value="summary" items={items} onChange={change} />
      );
    });
    const input = renderer.root.findByType("input");
    const focus = vi.fn();
    const preventDefault = vi.fn();
    renderer.root.findByProps({ id: "review-tab-summary" }).props.onKeyDown({
      key: "ArrowRight",
      preventDefault,
      currentTarget: {
        parentElement: { querySelectorAll: () => [{ focus: vi.fn() }, { focus }] }
      }
    });
    expect(change).toHaveBeenCalledWith("notes");
    expect(focus).toHaveBeenCalledOnce();
    await act(async () =>
      renderer.update(
        <Tabs id="review" ariaLabel="Review" value="notes" items={items} onChange={change} />
      )
    );
    expect(renderer.root.findByType("input")).toBe(input);
    expect(renderer.root.findByProps({ id: "review-panel-summary" }).props.hidden).toBe(true);
    expect(renderer.root.findByProps({ id: "review-tab-notes" }).props["aria-controls"]).toBe(
      "review-panel-notes"
    );
  });
  it("hides a lone tab without remounting its editor when a second section arrives", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const note = { value: "notes", label: "Notes", content: <input defaultValue="Kept" /> };
    await act(async () => {
      renderer = create(
        <Tabs id="single" ariaLabel="Sections" value="notes" items={[note]} onChange={() => {}} />
      );
    });
    const input = renderer.root.findByType("input");
    expect(renderer.root.findByProps({ role: "tablist" }).props.hidden).toBe(true);
    expect(renderer.root.findByProps({ id: "single-panel-notes" }).props.role).toBeUndefined();
    await act(async () =>
      renderer.update(
        <Tabs
          id="single"
          ariaLabel="Sections"
          value="notes"
          items={[note, { value: "summary", label: "Summary", content: <p>Summary</p> }]}
          onChange={() => {}}
        />
      )
    );
    expect(renderer.root.findByType("input")).toBe(input);
    expect(renderer.root.findByProps({ role: "tablist" }).props.hidden).toBe(false);
    expect(renderer.root.findByProps({ id: "single-panel-notes" }).props.role).toBe("tabpanel");
  });
  it("uses native mutually exclusive radios and clickable visible switch labels", () => {
    const radio = renderToStaticMarkup(
      <RadioCardGroup
        name="capture"
        ariaLabel="Capture"
        value="mic"
        options={[
          { value: "mic", label: "Microphone" },
          { value: "app", label: "App" }
        ]}
        onChange={() => {}}
      />
    );
    expect(radio.match(/type="radio"/g)).toHaveLength(2);
    expect(radio).toContain('role="radiogroup"');
    expect(radio).not.toContain("aria-pressed");
    const label = renderToStaticMarkup(
      <Switch ariaLabel="Save default" label="Save default" checked={false} />
    );
    expect(label).toMatch(
      /<label[^>]*>.*<input.*<span class="jds-switch__label">Save default<\/span><\/label>/
    );
  });
});
