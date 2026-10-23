import { z } from "zod/v4";

export const factProps = z.object({ field: z.enum(["hours", "projects", "budget"]) }).strict();
export const sectionProps = z
  .object({ title: z.string().min(1).max(100), children: z.array(z.unknown()).min(1).max(3) })
  .strict();
export const replyProps = z.object({ children: z.array(z.unknown()).min(1).max(3) }).strict();

export const catalogSchema = {
  $defs: {
    Reply: z.toJSONSchema(replyProps),
    Section: z.toJSONSchema(sectionProps),
    Fact: z.toJSONSchema(factProps)
  }
};
