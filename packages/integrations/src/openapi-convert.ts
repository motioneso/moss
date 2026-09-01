import type { IntegrationToolDescriptor } from "@moss/shared";

import { IntegrationUserError } from "./errors.js";

export interface OpenApiInvocation {
  readonly method: string;
  readonly path: string;
  readonly params: readonly { name: string; in: "path" | "query" | "header" }[];
  readonly hasBody: boolean;
}

export interface DiscoveredTool extends IntegrationToolDescriptor {
  readonly invoke?: OpenApiInvocation;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function sanitizeToolName(raw: string): string {
  return (
    raw
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "op"
  );
}

function resolveRefs(node: unknown, doc: Record<string, unknown>, depth: number): unknown {
  if (depth > 12 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, doc, depth + 1));
  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let target: unknown = doc;
    for (const part of ref.slice(2).split("/")) {
      target = (target as Record<string, unknown> | undefined)?.[
        part.replace(/~1/g, "/").replace(/~0/g, "~")
      ];
    }
    return resolveRefs(target ?? {}, doc, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolveRefs(v, doc, depth + 1);
  return out;
}

export function convertOpenApiSpec(spec: unknown): DiscoveredTool[] {
  const doc = spec as Record<string, unknown> | null;
  const paths = doc?.paths;
  if (!doc || typeof doc !== "object" || !paths || typeof paths !== "object") {
    throw new IntegrationUserError("That URL did not return an OpenAPI document.");
  }
  const tools: DiscoveredTool[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(paths as Record<string, Record<string, unknown>>)) {
    if (!item || typeof item !== "object") continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op || typeof op !== "object") continue;
      const rawName =
        typeof op.operationId === "string" && op.operationId ? op.operationId : `${method}${path}`;
      let name = sanitizeToolName(rawName);
      for (let i = 2; seen.has(name); i += 1) name = `${sanitizeToolName(rawName)}_${i}`;
      seen.add(name);

      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => resolveRefs(p, doc, 0) as Record<string, unknown>)
        .filter(
          (p) => typeof p?.name === "string" && ["path", "query", "header"].includes(p.in as string)
        );

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name as string] = resolveRefs(p.schema ?? { type: "string" }, doc, 0);
        if (p.required === true) required.push(p.name as string);
      }
      const requestBody = op.requestBody as
        | { content?: Record<string, { schema?: unknown }> }
        | undefined;
      const bodySchema = requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) properties.body = resolveRefs(bodySchema, doc, 0);

      const tags = Array.isArray(op.tags) ? op.tags : [];
      tools.push({
        name,
        description: String(
          op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`
        ).slice(0, 500),
        group: typeof tags[0] === "string" && tags[0] ? tags[0] : "Other",
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
        readOnly: method === "get" || method === "head" ? true : undefined,
        idempotent: ["get", "head", "put", "delete"].includes(method) ? true : undefined,
        invoke: {
          method: method.toUpperCase(),
          path,
          params: params.map((p) => ({
            name: p.name as string,
            in: p.in as "path" | "query" | "header"
          })),
          hasBody: Boolean(bodySchema)
        }
      });
    }
  }
  if (tools.length === 0)
    throw new IntegrationUserError("The spec has no operations Moss can turn into tools.");
  return tools;
}
