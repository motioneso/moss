/** Pure rules for the News settings screen. They mirror the server's rules, so each is unit tested. */

const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const IPV4_DOTTED_QUAD = /^\d{1,3}(\.\d{1,3}){3}$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Reduces typed text to a publisher domain, or says why it cannot be one. */
export function normalizePublisherDomain(input) {
  const trimmed = String(input).trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > 2048) return { ok: false, reason: "input_too_long" };
  let url;
  try {
    url = new URL(SCHEME_PREFIX.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "non_https_scheme" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  if (url.port !== "") return { ok: false, reason: "explicit_port" };
  const hostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (hostname.startsWith("[") || hostname.includes(":"))
    return { ok: false, reason: "ip_literal" };
  if (IPV4_DOTTED_QUAD.test(hostname)) return { ok: false, reason: "ip_literal" };
  if (hostname.length > 253) return { ok: false, reason: "hostname_too_long" };
  const labels = hostname.split(".");
  if (labels.length < 2) return { ok: false, reason: "single_label" };
  if (!labels.every((label) => DNS_LABEL.test(label)))
    return { ok: false, reason: "invalid_label" };
  return { ok: true, domain: hostname };
}

/** True for the excluded domain itself and any subdomain of it. */
export function publisherDomainMatches(excluded, candidate) {
  return candidate === excluded || candidate.endsWith(`.${excluded}`);
}

const EXCLUSION_REJECTION_COPY = {
  empty: "Enter a publisher domain or HTTPS link.",
  input_too_long: "That input is too long to be a web address.",
  unparseable: "That doesn't look like a web address.",
  non_https_scheme: "Only HTTPS links or bare domains are accepted.",
  credentials: "Web addresses with embedded credentials aren't accepted.",
  explicit_port: "Web addresses with an explicit port aren't accepted.",
  ip_literal: "IP addresses aren't accepted — use the publisher's domain name.",
  single_label: "Enter a full domain, like example.com.",
  hostname_too_long: "That domain name is too long.",
  invalid_label: "That domain name contains characters that aren't allowed."
};

export const exclusionRejectionMessage = (reason) =>
  EXCLUSION_REJECTION_COPY[reason] ?? "That doesn't look like a web address.";

/** Is this source on under the saved choices? Explicit includes win over the catalog defaults, and excludes always subtract. */
export function sourceEnabled(source, prefs) {
  const includes = prefs.filter((pref) => pref.kind === "source");
  const excluded = prefs.some(
    (pref) => pref.kind === "source_exclude" && pref.key === source.sourceKey
  );
  const inBase =
    includes.length > 0
      ? includes.some((pref) => pref.key === source.sourceKey)
      : source.defaultEnabled;
  return inBase && !excluded;
}

/**
 * The ordered saves that flip one source. Turning on a non-default source with no includes first pins
 * today's defaults, so the first include does not drop them. Turning off the only include excludes it,
 * so deleting it does not bring the defaults back.
 */
export function planSourceToggle(sourceKey, sources, prefs) {
  const source = sources.find((entry) => entry.sourceKey === sourceKey);
  if (!source) return [];
  const includes = prefs.filter((pref) => pref.kind === "source");
  const includeRow = includes.find((pref) => pref.key === sourceKey);
  const excludeRow = prefs.find((pref) => pref.kind === "source_exclude" && pref.key === sourceKey);
  const excludedKeys = new Set(
    prefs.filter((pref) => pref.kind === "source_exclude").map((pref) => pref.key)
  );
  if (sourceEnabled(source, prefs)) {
    if (includeRow && includes.length > 1) return [{ op: "delete", id: includeRow.id }];
    return [{ op: "create", kind: "source_exclude", key: sourceKey }];
  }
  const ops = [];
  if (excludeRow) ops.push({ op: "delete", id: excludeRow.id });
  const inBase = includes.length > 0 ? includeRow !== undefined : source.defaultEnabled;
  if (!inBase) {
    if (includes.length === 0) {
      for (const other of sources) {
        if (other.sourceKey === sourceKey) continue;
        if (other.defaultEnabled && !excludedKeys.has(other.sourceKey)) {
          ops.push({ op: "create", kind: "source", key: other.sourceKey });
        }
      }
    }
    ops.push({ op: "create", kind: "source", key: sourceKey });
  }
  return ops;
}

/** "excluded" beats the on and off choice, because the server drops an excluded publisher before it reads it. */
export function curatedTileState(source, prefs, excludedDomains) {
  const normalized = normalizePublisherDomain(source.homepageUrl);
  if (normalized.ok && excludedDomains.some((d) => publisherDomainMatches(d, normalized.domain))) {
    return "excluded";
  }
  return sourceEnabled(source, prefs) ? "on" : "off";
}

export function planTopicToggle(topicKey, prefs) {
  const row = prefs.find((pref) => pref.kind === "topic" && pref.key === topicKey);
  if (row) return [{ op: "delete", id: row.id }];
  return [{ op: "create", kind: "topic", key: topicKey }];
}

const REDDIT_RATE_LIMIT = "Reddit is rate limiting Moss. Headlines resume automatically.";
const REDDIT_AUTH_REQUIRED = "This subreddit is private or restricted.";

const PREVIEW_REJECTION_COPY = {
  policy: "That source isn't allowed by the content policy.",
  redirected:
    "That site redirects somewhere else, so we can't add it. Try the address it sends you to.",
  invalid_input: "That doesn't look like a source we can check — try a homepage link.",
  unreachable: "We couldn't reach that site. Check the address and try again.",
  not_https: "Only HTTPS links or bare domains are accepted.",
  blocked: "That site doesn't allow automatic access, so we can't add it.",
  rate_limited: REDDIT_RATE_LIMIT,
  auth_required: REDDIT_AUTH_REQUIRED
};

export const PREVIEW_REQUEST_ERROR = "Could not check that source. Try again.";

/** Words for a refused preview, or null when the preview found candidates or carries a structured error. */
export function previewOutcomeMessage(result) {
  if (result.status === "rejected" || result.status === "invalid") {
    return (
      (result.reason ? PREVIEW_REJECTION_COPY[result.reason] : undefined) ??
      "That source can't be added."
    );
  }
  return null;
}

/** Words for a structured add-source error. */
export function addSourceErrorMessage(error) {
  if (error.class === "prerequisite") {
    return "Adding sources needs a configured JSON-capable economy model.";
  }
  if (error.class === "transient") {
    return "Source discovery is temporarily unavailable — try again shortly.";
  }
  return "This source could not be added.";
}

/** The preview sends candidates and their confirm handles as two lists. Pair them so a label never gets another one's handle. */
export function zipPreviewCandidates(result) {
  const candidates = result.candidates ?? [];
  const ids = result.candidateIds ?? [];
  return candidates
    .map((candidate, index) => ({ candidate, candidateId: ids[index] }))
    .filter((entry) => Boolean(entry.candidateId));
}

/** The reason web search is off decides what the gate says and where the fix lives. */
export function describedTopicsGate(reason) {
  switch (reason) {
    case "model-has-no-search":
      return {
        requirement: "Your chat model has no built-in search.",
        href: "/settings?section=assistant",
        linkLabel: "Pick a model under Your assistant, or ask an admin to add a Brave key"
      };
    case "native-disabled":
      return {
        requirement: "Built-in web search is switched off for this instance.",
        href: "/settings?section=aiproviders",
        linkLabel: "Turn it on or add a Brave key under AI providers"
      };
    case "no-key-no-native-model":
      return {
        requirement: "No web search is set up.",
        href: "/settings?section=aiproviders",
        linkLabel: "Add a model with built-in search or a Brave key under AI providers"
      };
    default:
      return {
        requirement: "Described topics need an AI model and web search.",
        href: "/settings?section=aiproviders",
        linkLabel: "Set it up in AI providers"
      };
  }
}

export const ADD_SOURCE_GATE = {
  requirement: "Adding sources needs an AI model with structured output.",
  href: "/settings?section=aiproviders",
  linkLabel: "Set it up in AI providers"
};

/** Words for a failed topic save. 422 and 503 are the route's own policy and availability answers. */
export function topicErrorMessage(error) {
  if (error?.status === 422) return "That topic isn't allowed by the content policy.";
  if (error?.status === 503) return "Topic checking is unavailable right now — try again shortly.";
  if (error?.status && error.message && error.message !== "News request failed")
    return error.message;
  return "Could not add that topic. Try again.";
}
