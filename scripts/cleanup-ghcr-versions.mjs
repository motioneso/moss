import assert from "node:assert/strict";

const packageName = "moss";
const retentionMs = 14 * 24 * 60 * 60 * 1000;

function selectExpiredUntagged(versions, cutoff, protectedDigests) {
  return versions
    .filter(
      (version) =>
        version.metadata.container.tags.length === 0 &&
        version.created_at < cutoff &&
        !protectedDigests.has(version.name)
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

if (process.argv.includes("--self-check")) {
  const versions = [
    {
      id: 1,
      name: "sha256:tagged",
      created_at: "2026-01-01T00:00:00Z",
      metadata: { container: { tags: ["edge"] } }
    },
    {
      id: 2,
      name: "sha256:child",
      created_at: "2026-01-01T00:00:00Z",
      metadata: { container: { tags: [] } }
    },
    {
      id: 3,
      name: "sha256:recent",
      created_at: "2026-02-01T00:00:00Z",
      metadata: { container: { tags: [] } }
    },
    {
      id: 4,
      name: "sha256:expired",
      created_at: "2026-01-01T00:00:00Z",
      metadata: { container: { tags: [] } }
    }
  ];
  assert.deepEqual(
    selectExpiredUntagged(
      versions,
      "2026-01-15T00:00:00Z",
      new Set(["sha256:tagged", "sha256:child"])
    ).map(({ id }) => id),
    [4]
  );
  console.log("GHCR retention self-check passed");
  process.exit(0);
}

const owner = process.env.GITHUB_REPOSITORY_OWNER;
const githubToken = process.env.GITHUB_TOKEN;
const dryRun = process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");

if (!owner || !githubToken) {
  throw new Error("GITHUB_REPOSITORY_OWNER and GITHUB_TOKEN are required");
}

const githubHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${githubToken}`,
  "User-Agent": "moss-ghcr-retention",
  "X-GitHub-Api-Version": "2022-11-28"
};

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: githubHeaders
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path} failed: ${response.status}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function listVersions() {
  const versions = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(
      `/users/${encodeURIComponent(owner)}/packages/container/${packageName}/versions?per_page=100&page=${page}`
    );
    versions.push(...batch);
    if (batch.length < 100) return versions;
  }
}

async function registryToken() {
  const response = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${encodeURIComponent(`${owner}/${packageName}`)}:pull`
  );
  if (!response.ok) throw new Error(`GHCR token request failed: ${response.status}`);
  return (await response.json()).token;
}

async function taggedImageDigests(versions) {
  const token = await registryToken();
  const protectedDigests = new Set();
  for (const version of versions.filter(({ metadata }) => metadata.container.tags.length > 0)) {
    protectedDigests.add(version.name);
    const response = await fetch(
      `https://ghcr.io/v2/${owner}/${packageName}/manifests/${version.name}`,
      {
        headers: {
          Accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json",
          Authorization: `Bearer ${token}`
        }
      }
    );
    if (!response.ok) throw new Error(`GHCR manifest lookup failed closed: ${response.status}`);
    const manifest = await response.json();
    for (const child of manifest.manifests ?? []) protectedDigests.add(child.digest);
  }
  return protectedDigests;
}

const versions = await listVersions();
const protectedDigests = await taggedImageDigests(versions);
const cutoff = new Date(Date.now() - retentionMs).toISOString();
const expired = selectExpiredUntagged(versions, cutoff, protectedDigests);

console.log(
  `${dryRun ? "Would delete" : "Deleting"} ${expired.length} untagged GHCR records older than ${cutoff}; ` +
    `protecting ${protectedDigests.size} tagged image records and children.`
);

if (dryRun) {
  for (const version of expired.slice(0, 20)) {
    console.log(`  ${version.id}\t${version.created_at}\t${version.name}`);
  }
  if (expired.length > 20) console.log(`  ...and ${expired.length - 20} more`);
} else {
  let deleted = 0;
  for (const version of expired) {
    await github(
      `/users/${encodeURIComponent(owner)}/packages/container/${packageName}/versions/${version.id}`,
      { method: "DELETE" }
    );
    deleted += 1;
    if (deleted % 25 === 0) console.log(`Deleted ${deleted}/${expired.length}`);
  }
  console.log(`Deleted ${deleted} expired GHCR records.`);
}
