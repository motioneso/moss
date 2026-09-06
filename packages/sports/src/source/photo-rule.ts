import { Ajv } from "ajv";
import { compile, selectOne } from "css-select";
import { DomUtils, parseDocument } from "htmlparser2";

import { publisherIdentity } from "./publisher-identity.js";

/**
 * #2237 slice 2 — the saved photo rule for one custom source (spec decision 5).
 *
 * A rule is a small, verified instruction for finding the lead photo on one publisher's article
 * pages. It is internal: no user ever sees it or the word "rule", and it is never rendered. Moss
 * proposes one in slice 3; this file owns its shape, its validator, and the step that runs it over
 * a page the reader already fetched.
 */

export type SportsPhotoRuleAttribute = "src" | "content" | "data-src" | "href";

export interface SportsPhotoRule {
  readonly version: 1;
  readonly kind: "html";
  /** Hosts the rule is allowed to be run against; always inside the source's own allow list. */
  readonly fetchHosts: readonly string[];
  readonly photo: {
    readonly selector: string;
    readonly source: "attribute";
    readonly attribute: SportsPhotoRuleAttribute;
  };
  readonly fallback: "share_image" | "none";
}

/** The longest selector a proposal may carry (spec decision 5). */
export const SPORTS_PHOTO_RULE_MAX_SELECTOR_LENGTH = 120;

export const SPORTS_PHOTO_RULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "kind", "fetchHosts", "photo", "fallback"],
  properties: {
    version: { const: 1 },
    kind: { const: "html" },
    fetchHosts: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 253 }
    },
    photo: {
      type: "object",
      additionalProperties: false,
      required: ["selector", "source", "attribute"],
      properties: {
        selector: {
          type: "string",
          minLength: 1,
          maxLength: SPORTS_PHOTO_RULE_MAX_SELECTOR_LENGTH
        },
        source: { const: "attribute" },
        attribute: { type: "string", enum: ["src", "content", "data-src", "href"] }
      }
    },
    fallback: { type: "string", enum: ["share_image", "none"] }
  }
} as const;

const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(SPORTS_PHOTO_RULE_SCHEMA);

/**
 * A pseudo-element would select something that has no attributes at all, so it can never name a
 * photo; rejecting it outright keeps a proposal from wasting a verification pass on nothing.
 */
function hasPseudoElement(selector: string): boolean {
  return selector.includes("::");
}

/**
 * Every check that must pass before a rule is stored or run. The hosts must all belong to the same
 * publisher as the source, so a rule can never widen where photos are fetched from.
 */
export function validateSportsPhotoRule(
  value: unknown,
  options: { readonly allowedHosts?: readonly string[] } = {}
): { readonly ok: true; readonly rule: SportsPhotoRule } | { readonly ok: false } {
  if (!validateSchema(value)) return { ok: false };
  const rule = value as SportsPhotoRule;
  if (hasPseudoElement(rule.photo.selector)) return { ok: false };
  const hosts = rule.fetchHosts.map((host) => host.toLowerCase());
  if (new Set(hosts).size !== hosts.length) return { ok: false };
  const identities = hosts.map((host) => publisherIdentity(host));
  if (identities.some((identity) => identity === null)) return { ok: false };
  if (new Set(identities).size !== 1) return { ok: false };
  if (options.allowedHosts) {
    const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    if (hosts.some((host) => !allowed.has(host))) return { ok: false };
  }
  try {
    compile(rule.photo.selector);
  } catch {
    return { ok: false };
  }
  return { ok: true, rule: { ...rule, fetchHosts: hosts } };
}

/**
 * Runs a saved rule against one article page and returns the absolute candidate URL it names, or
 * null. The result is only a candidate: the caller still puts it through the same checks and the
 * same download every other photo goes through.
 */
/** css-select throws on a selector it cannot parse; a rule that cannot run just finds nothing. */
function selectOneOrNull(selector: string, html: string) {
  try {
    return selectOne(selector, parseDocument(html));
  } catch {
    return null;
  }
}

export function applySportsPhotoRule(
  html: string,
  pageUrl: string,
  rule: SportsPhotoRule
): string | null {
  const element = selectOneOrNull(rule.photo.selector, html);
  if (!element || !DomUtils.isTag(element)) return null;
  const raw = DomUtils.getAttributeValue(element, rule.photo.attribute)?.trim();
  if (!raw) return null;
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return null;
  }
}
