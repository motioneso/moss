import assert from "node:assert/strict";
import test from "node:test";
import { launchFocus } from "./focus.mjs";

test("launch focus accepts only the three presets", () => {
  assert.equal(launchFocus("?focus=atrisk"), "atrisk");
  assert.equal(launchFocus("?x=1&focus=priorities"), "priorities");
  assert.equal(launchFocus("?focus=donetoday"), "donetoday");
  assert.equal(launchFocus("?focus=other"), null);
  assert.equal(launchFocus("?focus="), null);
  assert.equal(launchFocus(""), null);
});
