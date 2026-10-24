import { buildComputerGateway } from "./computer-gateway/build.js";

async function main() {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error("Expected one new output directory");
  await buildComputerGateway(directory);
  process.stdout.write("Computer gateway context built; image not qualified\n");
}
void main().catch(() => {
  process.stderr.write("Computer gateway build unavailable\n");
  process.exitCode = 1;
});
