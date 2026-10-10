// external-modules/finance/src/worker/handlers/setup.ts
//
// finance.setup.status: the read tool behind Getting started (#3178). Reports
// whether the instance has bank (Plaid) keys and whether this user has linked a
// bank. Pure read: never builds a Plaid client and never returns a key.
import type { WorkerPorts } from "../ports.js";
import type { ToolFactory } from "../registry.js";

export const setupStatusHandler: ToolFactory = (ports: WorkerPorts) => async () => {
  let keysConfigured = true;
  try {
    await ports.creds.get();
  } catch {
    keysConfigured = false;
  }
  const store = await ports.store();
  const items = await store.listItems();
  return { keysConfigured, hasBank: items.length > 0 };
};
