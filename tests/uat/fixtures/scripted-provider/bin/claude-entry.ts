// tests/uat/fixtures/scripted-provider/bin/claude-entry.ts
//
// #1659: real `.ts` entry so tsx parses it as TypeScript. Its sibling `claude` is extensionless
// (it has to be — it stands in for the `claude` binary on PATH) and tsx cannot parse an
// extensionless file, so the logic cannot live there.
import { main } from "../claude-main.js";

main();
