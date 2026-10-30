import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
/** Only the disposable installed copy changes; production module metadata stays intact. */
export async function configureFinanceProofFixture(id: string, installed: string): Promise<void> {
  if (id !== "finance") return;
  const entry = process.env.MOSS_FINANCE_BILL_ENTRY_CONFIRM_NEGATIVE === "1";
  if (!entry && process.env.MOSS_FINANCE_REVERSE_CONFIRM_NEGATIVE !== "1") return;
  const path = join(installed, "jarvis.module.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    assistantTools: {
      name: string;
      confirmWhenKeys?: string[];
      executionPolicy?: string;
      actionFamilyId?: string;
    }[];
  };
  const tool = manifest.assistantTools.find(
    (t) => t.name === (entry ? "finance.bill.entry-record" : "finance.manual.transfer-reverse")
  );
  if (!tool?.confirmWhenKeys?.length)
    throw new Error("Missing correction confirmation fixture hook");
  if (entry) {
    tool.executionPolicy = "auto";
    tool.actionFamilyId = "drafting";
  }
  delete tool.confirmWhenKeys;
  await writeFile(path, JSON.stringify(manifest));
}
