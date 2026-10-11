import { createHash } from "node:crypto";
import { assertDataContextDb } from "@moss/db";
import {
  approvalText,
  presentApprovalFields,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import {
  newsApprovalPreview,
  newsApprovalSources,
  newsApprovalSnapshot,
  newsApprovalTopics
} from "./chat-tools.js";
import { currentImageArticle } from "./image-route.js";
import { NEWS_FAVICON_HOSTNAME_PATTERN, isStaticApprovedNewsFaviconHost } from "./favicon-route.js";
import { normalizePublisherDomain } from "./personalization-domain.js";

const version = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const newsRefreshPresentation: ToolApprovalPresentation = async (_db, input) =>
  presentApprovalFields(input, {}) ? { target: "Your news feed", fields: [] } : null;

export const newsConfirmPresentation: ToolApprovalPresentation = async (_db, input, ctx) => {
  const { confirmationId, candidateId, ...changes } = input;
  const fields = presentApprovalFields(
    changes,
    {
      label: { label: "Publisher", present: approvalText },
      domain: { label: "Domain", present: approvalText }
    },
    ["label", "domain"]
  );
  if (
    !fields ||
    typeof confirmationId !== "string" ||
    (candidateId !== undefined && typeof candidateId !== "string")
  )
    return null;
  const preview = newsApprovalPreview(ctx.actorUserId, confirmationId);
  if (
    !preview ||
    preview.replaceSourceId !== null ||
    (preview.candidates.length > 1 && !candidateId)
  )
    return null;
  const matches = candidateId
    ? preview.candidates.filter((entry) => entry.candidateId === candidateId)
    : preview.candidates;
  const candidate = matches.length === 1 ? matches[0] : null;
  if (
    !candidate ||
    candidate.label !== changes.label ||
    candidate.canonicalDomain !== changes.domain
  )
    return null;
  return { target: candidate.label, fields, version: version([confirmationId, preview]) };
};

export const newsRemoveSourcePresentation: ToolApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  const { sourceId, ...changes } = input;
  if (typeof sourceId !== "string" || !presentApprovalFields(changes, {})) return null;
  const source = (await newsApprovalSources(db)).find((row) => row.id === sourceId.trim());
  return source
    ? {
        target: source.label,
        fields: [
          { label: "Domain", value: source.canonicalDomain },
          { label: "Saved credentials", value: "Delete any saved credentials for this publisher" },
          {
            label: "Saved briefings",
            value: "Remove articles from this publisher and its subdomains"
          }
        ],
        version: version(source)
      }
    : null;
};
export const newsRemoveTopicPresentation: ToolApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  const { topicId, ...changes } = input;
  if (typeof topicId !== "string" || !presentApprovalFields(changes, {})) return null;
  const topic = (await newsApprovalTopics(db)).find((row) => row.id === topicId.trim());
  return topic ? { target: topic.label, fields: [], version: version(topic) } : null;
};
export const newsAddTopicPresentation: ToolApprovalPresentation = async (_db, input) => {
  const fields = presentApprovalFields(
    input,
    { label: { label: "Topic", present: approvalText } },
    ["label"]
  );
  return fields && typeof input.label === "string" && input.label.trim()
    ? { target: input.label.trim(), fields }
    : null;
};
export const newsExclusionPresentation: ToolApprovalPresentation = async (_db, input) => {
  const fields = presentApprovalFields(
    input,
    { domain: { label: "Publisher", present: approvalText } },
    ["domain"]
  );
  if (!fields || typeof input.domain !== "string") return null;
  const domain = normalizePublisherDomain(input.domain.trim());
  return domain.ok
    ? {
        target: domain.domain,
        fields: [...fields, { label: "Subdomains", value: "Also excluded" }]
      }
    : null;
};

export const newsImagePresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  if (
    !presentApprovalFields(input.query, {}) ||
    !presentApprovalFields(input.body, {}) ||
    Object.keys(input.params).some((key) => key !== "articleId") ||
    !input.params.articleId
  )
    return null;
  const article = currentImageArticle(
    await newsApprovalSnapshot(db),
    input.params.articleId,
    new Date()
  );
  if (!article?.imageUrl) return null;
  return {
    target: article.headline,
    fields: [
      { label: "Publisher", value: article.publisher },
      { label: "Image host", value: new URL(article.imageUrl).hostname }
    ],
    version: version(article)
  };
};
export const newsFaviconPresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  if (
    !presentApprovalFields(input.query, {}) ||
    !presentApprovalFields(input.body, {}) ||
    Object.keys(input.params).some((key) => key !== "domain")
  )
    return null;
  const domain = input.params.domain;
  if (!domain || !NEWS_FAVICON_HOSTNAME_PATTERN.test(domain)) return null;
  const fixed = isStaticApprovedNewsFaviconHost(domain);
  const source = fixed
    ? null
    : (await newsApprovalSources(db)).find(
        (entry) => entry.canonicalDomain.toLowerCase() === domain.toLowerCase()
      );
  if (!fixed && !source) return null;
  return {
    target: source?.label ?? domain,
    fields: [{ label: "Publisher domain", value: domain }],
    version: version([domain, source])
  };
};
