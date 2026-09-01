import { describe, expect, it } from "vitest";
import { convertOpenApiSpec, IntegrationUserError } from "@moss/integrations";

const spec = {
  openapi: "3.0.0",
  components: {
    schemas: { Movie: { type: "object", properties: { title: { type: "string" } } } }
  },
  paths: {
    "/api/v3/movie/{id}": {
      get: {
        operationId: "getMovieById",
        summary: "Get one movie",
        tags: ["Movie"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }]
      }
    },
    "/api/v3/movie": {
      post: {
        operationId: "createMovie",
        tags: ["Movie"],
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Movie" } } }
        }
      }
    },
    "/api/v3/queue": {
      get: {
        summary: "Queue",
        parameters: [{ name: "page", in: "query", schema: { type: "integer" } }]
      }
    }
  }
};

describe("convertOpenApiSpec", () => {
  it("converts operations to tools with tag groups and object-root schemas", () => {
    const tools = convertOpenApiSpec(spec);
    expect(tools).toHaveLength(3);
    const get = tools.find((t) => t.name === "getMovieById")!;
    expect(get.group).toBe("Movie");
    expect(get.description).toBe("Get one movie");
    expect(get.inputSchema).toMatchObject({ type: "object", required: ["id"] });
    expect(get.invoke).toEqual({
      method: "GET",
      path: "/api/v3/movie/{id}",
      params: [{ name: "id", in: "path" }],
      hasBody: false
    });
  });

  it("resolves local $refs into the body schema and names untagged ops into a default group", () => {
    const tools = convertOpenApiSpec(spec);
    const post = tools.find((t) => t.name === "createMovie")!;
    const props = post.inputSchema!.properties as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    expect(props.body!.properties.title).toEqual({ type: "string" });
    expect(post.invoke!.hasBody).toBe(true);
    const queue = tools.find((t) => t.name === "get_api_v3_queue")!;
    expect(queue.group).toBe("Other");
  });

  it("never emits a top-level combinator", () => {
    for (const t of convertOpenApiSpec(spec)) {
      for (const k of ["anyOf", "oneOf", "allOf", "not"])
        expect(k in (t.inputSchema ?? {})).toBe(false);
    }
  });

  it("rejects a non-OpenAPI document with a plain message", () => {
    expect(() => convertOpenApiSpec({ hello: 1 })).toThrow(IntegrationUserError);
  });
});
