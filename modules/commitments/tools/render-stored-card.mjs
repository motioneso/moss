// Invoked by the installed DB test with the actual prepareCommitmentAction result on stdin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reviewCardHtml } from "../ui/review-card.mjs";
const card = JSON.parse(readFileSync(0, "utf8"));
assert.equal(card.target, "Stored review <budget> & draft");
assert.ok(card.version.includes(process.argv[2]));
const action = process.argv[3];
{
  const html = reviewCardHtml(card, action);
  assert.ok(html.includes("Stored review &lt;budget&gt; &amp; draft"));
  assert.ok(html.includes('data-decision="approve"'));
  assert.ok(html.includes('data-decision="reject"'));
  if (action === "snooze") {
    assert.match(html, /Snooze until/);
    assert.match(html, /2026-12-01T00:00:00Z/);
  }
}
console.log(`PASS stored commitment prepares and renders the ${action} approval card`);
