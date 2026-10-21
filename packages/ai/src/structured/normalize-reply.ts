import { Ajv, type ValidateFunction } from "ajv";

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Repair only invalid values with a unique schema-valid interpretation; never mutate the reply. */
export function createReplyNormalizer(schema: Schema): (value: unknown) => unknown {
  const ajv = new Ajv({ strict: false, validateFormats: false, addUsedSchema: false });
  const validators = new WeakMap<Schema, ValidateFunction>();
  const accepts = (node: Schema, value: unknown): boolean => {
    let validate = validators.get(node);
    if (!validate) {
      validate = ajv.compile(node);
      validators.set(node, validate);
    }
    return Boolean(validate(value));
  };
  const normalize = (node: Schema, value: unknown): unknown => {
    if (accepts(node, value)) return value;
    // Combining or conditional constraints need joint reasoning; leave them to full validation.
    if (["oneOf", "allOf", "not", "if", "then", "else", "$ref"].some((key) => key in node))
      return value;
    if (Array.isArray(node.anyOf)) {
      const candidates = new Map<string, unknown>();
      for (const branch of node.anyOf) {
        if (!isSchema(branch)) continue;
        const candidate = normalize(branch, value);
        if (accepts(node, candidate)) candidates.set(JSON.stringify(candidate), candidate);
      }
      return candidates.size === 1 ? candidates.values().next().value : value;
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    let candidate = value;
    if (typeof value === "string") {
      if (value === "null" && types.includes("null")) candidate = null;
      else if (types.includes("integer") && /^-?(?:0|[1-9]\d*)$/.test(value)) {
        const integer = Number(value);
        if (Number.isSafeInteger(integer)) candidate = integer;
      } else if (types.includes("object") && value.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (isSchema(parsed)) candidate = parsed;
        } catch {
          return value;
        }
      }
    }
    if (isSchema(candidate) && types.includes("object") && isSchema(node.properties)) {
      const object = { ...candidate };
      for (const [key, property] of Object.entries(node.properties)) {
        if (!isSchema(property)) continue;
        if (Object.hasOwn(object, key)) {
          Object.defineProperty(object, key, {
            value: normalize(property, object[key]),
            enumerable: true,
            configurable: true,
            writable: true
          });
        } else if (
          Array.isArray(node.required) &&
          node.required.includes(key) &&
          accepts(property, null)
        ) {
          Object.defineProperty(object, key, {
            value: null,
            enumerable: true,
            configurable: true,
            writable: true
          });
        }
      }
      candidate = object;
    }
    return accepts(node, candidate) ? candidate : value;
  };
  return (value) => normalize(schema, value);
}
