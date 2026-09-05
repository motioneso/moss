import assert from "node:assert/strict";

// Independent validation at the container boundary, matching R1a's host file envelope.
// Neither this path allowlist nor a successful compile permits execution on the host.
const pathPattern =
  /^(?:jarvis\.module\.json|SPEC\.md|README\.md|(?:src\/(?:worker|web)|tests)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:ts|tsx|css))$/;

export function validateSource(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value), ["files"]);
  assert.ok(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 32);
  const paths = new Set();
  let bytes = 0;
  const files = Array.from(value.files, (file) => {
    assert.ok(file && typeof file === "object" && !Array.isArray(file));
    assert.deepEqual(Object.keys(file).sort(), ["content", "path"]);
    assert.ok(
      typeof file.path === "string" && file.path.length <= 200 && pathPattern.test(file.path)
    );
    assert.ok(typeof file.content === "string" && !file.content.includes("\0"));
    assert.ok(Buffer.byteLength(file.content) <= 32768);
    const key = file.path.toLowerCase();
    assert.ok(!paths.has(key));
    paths.add(key);
    bytes += Buffer.byteLength(file.path) + Buffer.byteLength(file.content);
    assert.ok(bytes <= 65536);
    return { path: file.path, content: file.content };
  });
  return { files };
}

export async function readSource(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    assert.ok(bytes <= 131072, "source input exceeds byte limit");
    chunks.push(Buffer.from(chunk));
  }
  return validateSource(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
