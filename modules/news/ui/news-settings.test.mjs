import assert from "node:assert/strict";
import test from "node:test";

import {
  ADD_SOURCE_GATE,
  curatedTileState,
  describedTopicsGate,
  exclusionRejectionMessage,
  normalizePublisherDomain,
  planSourceToggle,
  planTopicToggle,
  previewOutcomeMessage,
  publisherDomainMatches,
  sourceEnabled,
  topicErrorMessage,
  zipPreviewCandidates
} from "./domain.mjs";

const sources = [
  { sourceKey: "a", homepageUrl: "https://a.com", defaultEnabled: true },
  { sourceKey: "b", homepageUrl: "https://b.com", defaultEnabled: true },
  { sourceKey: "c", homepageUrl: "https://c.com", defaultEnabled: false }
];

test("normalizes domains and rejects bad input", () => {
  assert.deepEqual(normalizePublisherDomain("https://News.Example.com/x"), {
    ok: true,
    domain: "news.example.com"
  });
  assert.equal(normalizePublisherDomain("").reason, "empty");
  assert.equal(normalizePublisherDomain("http://a.com").reason, "non_https_scheme");
  assert.equal(normalizePublisherDomain("10.0.0.1").reason, "ip_literal");
  assert.equal(normalizePublisherDomain("localhost").reason, "single_label");
  assert.equal(normalizePublisherDomain("https://a.com:8080").reason, "explicit_port");
  assert.match(exclusionRejectionMessage("single_label"), /full domain/);
});

test("subdomains match an excluded domain", () => {
  assert.ok(publisherDomainMatches("a.com", "www.a.com"));
  assert.ok(!publisherDomainMatches("a.com", "nota.com"));
});

test("source defaults, includes and excludes", () => {
  assert.ok(sourceEnabled(sources[0], []));
  assert.ok(!sourceEnabled(sources[2], []));
  assert.ok(!sourceEnabled(sources[0], [{ kind: "source", key: "c" }]));
  assert.ok(!sourceEnabled(sources[0], [{ kind: "source_exclude", key: "a" }]));
});

test("turning on a non-default source pins today's defaults first", () => {
  const ops = planSourceToggle("c", sources, []);
  assert.deepEqual(ops, [
    { op: "create", kind: "source", key: "a" },
    { op: "create", kind: "source", key: "b" },
    { op: "create", kind: "source", key: "c" }
  ]);
});

test("turning off the only include excludes it", () => {
  const prefs = [{ id: "1", kind: "source", key: "c" }];
  assert.deepEqual(planSourceToggle("c", sources, prefs), [
    { op: "create", kind: "source_exclude", key: "c" }
  ]);
});

test("turning off one of several includes deletes it", () => {
  const prefs = [
    { id: "1", kind: "source", key: "a" },
    { id: "2", kind: "source", key: "b" }
  ];
  assert.deepEqual(planSourceToggle("a", sources, prefs), [{ op: "delete", id: "1" }]);
});

test("turning an excluded default back on deletes the exclusion", () => {
  const prefs = [{ id: "9", kind: "source_exclude", key: "a" }];
  assert.deepEqual(planSourceToggle("a", sources, prefs), [{ op: "delete", id: "9" }]);
});

test("excluded publisher beats the on state", () => {
  assert.equal(curatedTileState(sources[0], [], ["a.com"]), "excluded");
  assert.equal(curatedTileState(sources[0], [], []), "on");
  assert.equal(curatedTileState(sources[2], [], []), "off");
});

test("topic toggle creates or deletes", () => {
  assert.deepEqual(planTopicToggle("tech", []), [{ op: "create", kind: "topic", key: "tech" }]);
  assert.deepEqual(planTopicToggle("tech", [{ id: "5", kind: "topic", key: "tech" }]), [
    { op: "delete", id: "5" }
  ]);
});

test("preview messages", () => {
  assert.match(previewOutcomeMessage({ status: "rejected", reason: "policy" }), /content policy/);
  assert.equal(
    previewOutcomeMessage({ status: "rejected", reason: "zzz" }),
    "That source can't be added."
  );
  assert.equal(previewOutcomeMessage({ status: "ok" }), null);
});

test("candidates pair with their ids", () => {
  const pairs = zipPreviewCandidates({
    candidates: [{ label: "x" }, { label: "y" }],
    candidateIds: ["1"]
  });
  assert.deepEqual(pairs, [{ candidate: { label: "x" }, candidateId: "1" }]);
});

test("web-search gate names its reason", () => {
  assert.match(
    describedTopicsGate("no-key-no-native-model").requirement,
    /No web search is set up/
  );
  assert.match(describedTopicsGate("model-has-no-search").requirement, /no built-in search/);
  assert.match(describedTopicsGate("native-disabled").requirement, /switched off/);
  assert.match(describedTopicsGate("other").requirement, /AI model and web search/);
  assert.ok(ADD_SOURCE_GATE.href.startsWith("/"));
});

test("topic errors", () => {
  assert.match(topicErrorMessage({ status: 503 }), /unavailable/);
  assert.match(topicErrorMessage({ status: 422 }), /content policy/);
  assert.match(topicErrorMessage(new Error("x")), /Could not add/);
});
