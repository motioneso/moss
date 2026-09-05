import { assertDataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";

import { ScratchpadRepository, ScratchpadTooLargeError } from "./repository.js";

const repository = new ScratchpadRepository();

export const scratchpadReadExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const state = await repository.get(scopedDb);
  return {
    data: {
      body: state.body,
      // The approved spec promises the reader gets a character count alongside the text, so the
      // assistant can say how full the pad is without counting the characters itself.
      characterCount: state.body.length,
      revision: state.revision,
      updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null
    }
  };
};

export const scratchpadAppendExecute: ToolExecute = async (
  scopedDb,
  input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { text } = input as { text: string };
  const trimmed = typeof text === "string" ? text.trim() : "";

  if (trimmed.length === 0) {
    return { data: { error: "Cannot append empty text to the scratchpad" } };
  }
  if (trimmed.length > 2000) {
    return { data: { error: "Text is too long to append in one call (2000 character limit)" } };
  }

  let result;
  try {
    result = await repository.append(scopedDb, trimmed);
  } catch (error) {
    if (error instanceof ScratchpadTooLargeError) {
      return { data: { error: "Scratchpad is full" } };
    }
    throw error;
  }
  return {
    data: {
      revision: result.revision,
      updatedAt: result.updatedAt.toISOString(),
      appended: result.appended
    }
  };
};
