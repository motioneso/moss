// external-modules/meals/src/ai/port.ts
//
// The one AI capability Meals uses, as a narrow port over ctx.ai.

export type AiFailure =
  | "needs_config"
  | "validation_failed"
  | "provider_error"
  | "usage_limited"
  | "aborted";

export interface MealsAi {
  generateStructured(input: {
    schema: Record<string, unknown>;
    prompt: string;
    maxOutputTokens?: number;
    tierHint?: "reasoning" | "interactive" | "economy";
  }): Promise<
    | { readonly ok: true; readonly object: unknown }
    | { readonly ok: false; readonly error: AiFailure }
  >;
}
