export const aiActionPresentationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "outsideContentNotice"],
  properties: {
    summary: { type: "string" },
    outcomeTitle: { type: "string" },
    outsideContentNotice: { type: "boolean" },
    details: {
      type: "object",
      additionalProperties: false,
      required: ["target", "fields"],
      properties: {
        target: { type: ["string", "null"] },
        fields: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "value"],
            properties: { label: { type: "string" }, value: { type: "string" } }
          }
        }
      }
    },
    preview: {
      type: "object",
      additionalProperties: false,
      required: ["to", "subject", "body"],
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" }
      }
    }
  }
} as const;
