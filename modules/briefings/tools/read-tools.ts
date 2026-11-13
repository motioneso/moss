// Prints the read-risk assistant tool names the old Briefings routes accept.
import { listAssistantToolsFromManifests } from "../../../packages/ai/src/assistant-tools.js";
import { getBuiltInModuleManifests } from "../../../packages/module-registry/src/index.js";

const names = listAssistantToolsFromManifests(getBuiltInModuleManifests())
  .filter((tool) => tool.risk === "read")
  .map((tool) => tool.name)
  .sort();
console.log(JSON.stringify(names));
