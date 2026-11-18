// Binary64 JSON inputs and String(Number) results from the legacy JS runtime.
// Regenerate with: node modules/people/tools/number-vectors.mjs
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const literals = new Set([
  "0",
  "-0",
  "5e-324",
  "2.2250738585072014e-308",
  "1.7976931348623157e308",
  "9007199254740993",
  "652282746268236.2",
  "-245777903432188.62",
  "2e-324",
  "3e-324",
  "1e-400",
  "1.00000000000000011102230246251565404236316680908203125"
]);
const bytes = new DataView(new ArrayBuffer(8));
let bits = 104n;
for (let index = 0; index < 256; index++) {
  bits = BigInt.asUintN(64, bits * 6364136223846793005n + 1442695040888963407n);
  bytes.setBigUint64(0, bits);
  const value = bytes.getFloat64(0);
  if (Number.isFinite(value)) literals.add(JSON.stringify(value));
}
for (const exponent of [-1074, -1022, -24, -20, 0, 20, 52, 100, 1023]) {
  for (const sign of [1, -1]) literals.add(JSON.stringify(sign * 2 ** exponent));
}
process.stdout.write(
  await format(JSON.stringify([...literals].map((input) => [input, String(JSON.parse(input))])), {
    ...(await resolveConfig(fileURLToPath(import.meta.url))),
    parser: "json"
  })
);
