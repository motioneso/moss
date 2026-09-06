import { defineModuleWorker, type ModuleWorkerContext } from "@moss/module-sdk/worker";

const NAMESPACE = "uat-workshop-word.saved";
const WORD_ID = "quasar";
const WORD_TEXT = "quasar";

function wordId(input: Record<string, unknown>): string {
  const params =
    input.params && typeof input.params === "object" && !Array.isArray(input.params)
      ? (input.params as Record<string, unknown>)
      : input;
  if (params.wordId !== WORD_ID) throw new Error("wordId is invalid");
  return WORD_ID;
}

async function list(ctx: ModuleWorkerContext): Promise<Record<string, unknown>> {
  const keys = await ctx.kv.list("user", NAMESPACE);
  const savedWords = [];
  for (const key of keys) {
    const record = await ctx.kv.get("user", NAMESPACE, key);
    if (record?.wordId === WORD_ID) savedWords.push({ wordId: WORD_ID, text: WORD_TEXT });
  }
  return { savedWords };
}

async function save(ctx: ModuleWorkerContext): Promise<Record<string, unknown>> {
  const id = wordId(ctx.input);
  await ctx.kv.set("user", NAMESPACE, id, { wordId: id, text: WORD_TEXT });
  return { wordId: id, saved: true };
}

async function remove(ctx: ModuleWorkerContext): Promise<Record<string, unknown>> {
  const id = wordId(ctx.input);
  await ctx.kv.delete("user", NAMESPACE, id);
  return { wordId: id, saved: false };
}

defineModuleWorker({ handlers: { "word.list": list, "word.save": save, "word.remove": remove } });
