export const aiActionPresentationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "outsideContentNotice"],
  properties: {
    nativePermission: { type: "boolean", const: true },
    externalTool: { type: "boolean", const: true },
    exactArguments: { type: "string" },
    summary: { type: "string" },
    outcomeTitle: { type: "string" },
    outsideContentNotice: { type: "boolean" },
    details: {
      type: "object",
      additionalProperties: false,
      required: ["target", "fields"],
      properties: {
        presentation: { type: "string", enum: ["human"] },
        approvalKind: { type: "string", enum: ["memory_delete", "note_delete"] },
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
