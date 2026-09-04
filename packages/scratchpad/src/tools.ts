import { assertDataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import { SCRATCHPAD_MAX_CHARS } from "@moss/shared";

import { ScratchpadRepository } from "./repository.js";

const repository = new ScratchpadRepository();

export const scratchpadReadExecute: ToolExecute = async (scopedDb, _input, _ctx): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const state = await repository.get(scopedDb);
  return {
    data: {
      body: state.body,
      revision: state.revision,
      updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null
    }
  };
};

export const scratchpadAppendExecute: ToolExecute = async (scopedDb, input, _ctx): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const { text } = input as { text: string };
  const trimmed = typeof text === "string" ? text.trim() : "";

  if (trimmed.length === 0) {
    return { data: { error: "Cannot append empty text to the scratchpad" } };
  }
  if (trimmed.length > 2000) {
    return { data: { error: "Text is too long to append in one call (2000 character limit)" } };
  }
  if (trimmed.length > SCRATCHPAD_MAX_CHARS) {
    return { data: { error: "Scratchpad is full" } };
  }

  const result = await repository.append(scopedDb, trimmed);
  return {
    data: {
      revision: result.revision,
      updatedAt: result.updatedAt.toISOString(),
      appended: result.appended
    }
  };
};
