# Replace the catalog signing key (#2829)

Plan only. No code or repository settings change in this PR. Facts below were read from `main` at
`faddc8e42` and from the CLI tools manifest branch (PR 2827, `scripts/cli-tools-manifest/`).

## Summary

- The production key id is `moss-catalog-2026-a`. Its private half sits only in two repository-wide
  secrets whose values nobody can read back.
- Those secrets still work in CI today. Nothing is broken now. The problem is that a repository-wide
  secret reaches every workflow on every branch, so the protected environment cannot guard it.
- Plan: generate `moss-catalog-2026-b` offline, ship its public half next to the old one, wait for
  instances to update, then (and only then) store the new key in two protected environments, then
  delete the repository-wide secrets last. Storing the key early makes the next automatic publish
  sign with it before instances trust it.
- Deleting the repository-wide secrets cannot be undone, so it is the final step.

## 1. How the key works today

| Fact           | Value                                                                                                   | Source                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Algorithm      | Ed25519, signature over the raw file bytes                                                              | `packages/module-registry/src/distribution/catalog-signing.ts` |
| Private format | PEM, loaded with `createPrivateKey` (PKCS#8 `BEGIN PRIVATE KEY` works)                                  | same file, `signCatalogBytes`                                  |
| Public format  | SPKI PEM, pinned in `MODULE_CATALOG_PUBLIC_KEYS`                                                        | same file                                                      |
| Key id         | Free-text label chosen by the owner. Current: `moss-catalog-2026-a`                                     | same file; lookup is by exact id (`keys.find`)                 |
| Signature file | `index.json.sig` holding `formatVersion`, `algorithm`, `keyId`, `signatureBase64`                       | `verifyCatalogBytes`                                           |
| Secret names   | `MOSS_MODULE_CATALOG_SIGNING_KEY_ID`, `MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY` (both or none)          | `resolveCatalogSigningKey`                                     |
| Reused by      | The CLI tools manifest signs with the same functions and the same two secret names                      | `scripts/cli-tools-manifest/sign-assemble.ts` on PR 2827       |
| Self-check     | Both publishers verify the fresh signature against the shipped keyring and fail if the id is not pinned | `scripts/publish-module-registry.ts`, `signManifest`           |

The repo has no key generation script. The first key was made by hand (plan 1319, decision D8).

### Command for the owner (own machine, not a shared box)

The private half goes to a file with owner-only permissions. Nothing below prints it. Only the
public half is shown, and that is safe to paste anywhere.

```bash
umask 077
KEYDIR="$(mktemp -d)"
openssl genpkey -algorithm ed25519 -out "$KEYDIR/moss-catalog-2026-b.pem"
openssl pkey -in "$KEYDIR/moss-catalog-2026-b.pem" -pubout     # prints the PUBLIC half only
```

Check that Node can use it before storing it (prints only `true`):

```bash
node -e 'const c=require("node:crypto"),fs=require("fs");const k=c.createPrivateKey(fs.readFileSync(process.argv[1]));console.log(c.verify(null,Buffer.from("x"),c.createPublicKey(k),c.sign(null,Buffer.from("x"),k)))' "$KEYDIR/moss-catalog-2026-b.pem"
```

Keep `$KEYDIR` until section 6 step 5 is done, then delete it. Deletion on a modern disk is not a
guarantee, so the real protection is that the file never left this machine.
On macOS the system `openssl` may be LibreSSL and lack Ed25519. Use Homebrew `openssl`, or generate
with `node -e` and `generateKeyPairSync("ed25519")` writing the files with mode 0600.
Keep one offline backup (password manager attachment or encrypted drive), because losing the value
is what caused this issue. Never paste the file into chat, an issue, a PR or a terminal that is
logged.

## 2. Where the public half is pinned

One place: the array `MODULE_CATALOG_PUBLIC_KEYS` in `catalog-signing.ts`. Both the module index
check on instances and the CLI manifest signer read it. Change:

- Append `{ keyId: "moss-catalog-2026-b", publicKeyPem: "<owner's public PEM>" }`. Keep `-a`.
- Add a unit test in `tests/unit/catalog-signing.test.ts` that the pinned ring contains both ids and
  that each id is unique (a duplicate id would shadow, because lookup returns the first match).
- No other file changes. Tests that name `-a` use it as a plain string.

## 3. What happens to running instances

An instance only trusts keys in the image it is running. The array already supports several keys
(`verifyCatalogBytes` picks by id, and `catalog-signing.test.ts` covers a two-key ring).

### Module index (live today)

| Registry signed with | Instance image has | Result                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a                    | a only             | Verified. This is the state today and stays valid after the change, because the old index and its signature remain on the release.                                                                                                                                                  |
| a                    | a and b            | Verified.                                                                                                                                                                                                                                                                           |
| b                    | a and b            | Verified.                                                                                                                                                                                                                                                                           |
| b                    | a only             | `unknown-key`, shown as unverified. Modules still list. Install and update stop with "Moss could not confirm this module list came from us", unless an admin accepts that exact catalog (`pipeline.ts`, `index-unverified`). Fails closed and self-heals once the instance updates. |

So the safe order is: image with both keys first, signing with b second.

### CLI tools manifest (not live yet)

- No instance reads this manifest yet. The reader is slice 4 of #2689 and is not built. No manifest
  is published on `main` (the proof release was deleted). So no running instance is affected.
- The signer refuses a key that is not pinned (`signManifest`), so the first manifest on `main` must
  use the new key only after section 2 is merged. Slice 4 must ship with `b` pinned.
- A branch (proof) run of the honest workflow refuses to sign with any pinned key. That does not stop
  an edited branch copy of the workflow from reading a repository-wide secret, so the real key is only
  kept off branches once the repository-wide secrets are deleted (slice D).
- Once PR 2827 merges, each 6-hour run on `main` waits for the owner's approval. Until the new key is
  stored, approving one would sign with `a`, which still works while the repository-wide copy exists.

### Old key afterwards

If `-a` was only lost (not leaked), keep its public half pinned indefinitely. Removing it protects
nothing and strands any instance that has not updated and any catalog still signed by it. If `-a` may
have leaked, remove it in a later release and accept that instances on older images stay trusting it.
There is no way to revoke a key on an instance that has not updated.

## 4. The module registry workflow

File: `.github/workflows/modules-registry.yml`, one job named `publish`.

- It has no `environment:` today, so it gets the repository-wide secrets.
- Only one step reads the key: "Build registry artifacts" (`env:` at step level). The checkout and
  `pnpm install --frozen-lockfile` steps run before it in the same job but do not receive the key.
- The key is not used by `modules-registry-check.yml`, `ci.yml` or `release-image.yml` (searched).
  Running the build script on pull requests uses `--check` and signs nothing.
- It runs on pushes to `main` that touch module sources, and on manual dispatch (from any branch).

Change (slice B, 2 lines):

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: module-registry
```

Once the repository-wide secrets are deleted (slice D) and the environment is limited to `main`, a
manual run from a branch cannot read the key. Until then a branch copy of the workflow can drop the
`environment:` line and still read the old repository-wide key. Add a
workflow test next to `tests/unit/publish-module-registry.test.ts` asserting that the job declares
`environment: module-registry`, and observe it fail with the line removed.

Secrets inside an environment shadow same-named repository secrets only when that job names the
environment. An environment with no secret silently falls back to the repository-wide one. That is
why `cli-tools-signing` being empty today means a `main` run would still use the old repository-wide
key. Fill the environments before deleting anything.

The `previousVersions` merge reads the current `index.json` without verifying it. That is unchanged by
this plan and unrelated to the key swap.

## 5. Rollback

| Point                                         | Rollback                                                                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyring release (slice A)                     | Revert the PR. An extra pinned key is harmless, so rolling back is optional.                                                                                                                       |
| Workflow change (slice B)                     | Revert the 2 lines. Works only while the repository-wide secrets still exist.                                                                                                                      |
| First publish with `b` (slice C)              | Delete the `b` secrets from `module-registry`. The job then falls back to the repository-wide `a` key with no code revert, while those secrets still exist. Instances with `b` pinned accept both. |
| After the repository-wide secrets are deleted | `a` is gone for good. Recovery is a new key `c` through this same plan. A bad index leaves instances on the last verified one and shows "unverified". Nothing private is exposed.                  |
| `b` leaked                                    | Generate `c`, pin it, release, sign with `c`, remove `b` from the ring in the following release. Instances that never update keep trusting `b`.                                                    |

## 6. Owner steps, in order

Repository name below is read from the current checkout by the commands. Substitute your own if you
type them by hand. Nothing here needs the repository-wide secrets to be read.

1. **Generate the pair** with the commands in section 1. Paste only the public half into the issue
   or hand it to the agent doing slice A.
2. **Create or open the second environment, before slice B merges.** Settings, Environments. GitHub
   creates any environment a workflow names, with no protection, the first time the job runs, and
   also when a secret is first added. If `module-registry` already exists, open it. Otherwise
   choose New environment, name `module-registry`. Either way, check the rules now and before
   adding any secret. Under Deployment branches and tags choose "Selected branches and tags" and
   confirm the only rule is `main`.
   Tick "Required reviewers" only if you want to approve every registry publish (it publishes on
   every module merge, so most people leave it off). Save.
3. **Confirm the first environment.** Settings, Environments, `cli-tools-signing`. Today it has the
   reviewer (you) and a branch rule, and it is empty. Re-check both rules before adding any secret.
4. **Store the key in both environments.** From the machine that holds the file:

   ```bash
   REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
   for ENV in cli-tools-signing module-registry; do
     printf '%s' 'moss-catalog-2026-b' | gh secret set MOSS_MODULE_CATALOG_SIGNING_KEY_ID --env "$ENV" --repo "$REPO"
     gh secret set MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY --env "$ENV" --repo "$REPO" < "$KEYDIR/moss-catalog-2026-b.pem"
   done
   ```

   Or in the web page: Environment, Add environment secret, name as above, paste the file contents.
   **Gate: do this only after the rollout in section 7 is finished.** Once slice B is merged the
   registry publishes by itself on every module merge, and once PR 2827 is merged the CLI manifest
   workflow runs every 6 hours. As soon as the key is stored, the next run signs with `b`. If any
   instance has not yet updated to the slice A image, it then marks the catalog unverified and
   stops installing and updating modules. Before storing the key, check that both environments
   show the `main`-only rule (and the reviewer on `cli-tools-signing`).

5. **Delete the repository-wide secrets, last.** First confirm both environments show the
   `main`-only rule and both hold both secrets. Settings, Secrets and variables, Actions,
   Repository secrets. Delete `MOSS_MODULE_CATALOG_SIGNING_KEY_ID` and
   `MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY`. Do this only after a `main` publish has succeeded with
   `b` (slice C). Then remove `$KEYDIR` and keep the offline backup.

## 7. Slices

Each slice is one session and one PR. Order matters.

| Slice   | Content                                                                                                                                                                                                                                                                                                          | Needs                                                    | Done when                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0       | Owner generates the pair (section 6 step 1) and sends the public half.                                                                                                                                                                                                                                           | Owner                                                    | Public PEM is in the issue.                                                                                   |
| A       | Pin `b` beside `a` (section 2) with the unit test. Security-tier review. Merge, then release an image.                                                                                                                                                                                                           | Slice 0                                                  | Test observed failing without the new entry. Image published.                                                 |
| B       | Add `environment: module-registry` to the module registry job, with a workflow test (section 4). Can run in parallel with A.                                                                                                                                                                                     | `module-registry` environment checked (section 6 step 2) | Test observed failing without the line.                                                                       |
| rollout | Owner updates instances (prod update command and the nightly updater). Owner stores the key in both environments (section 6 steps 2-4).                                                                                                                                                                          | A, B merged; `module-registry` checked (step 2)          | Every instance you care about runs the image from A. Only then may the key be stored.                         |
| C       | Run the module registry workflow by hand from `main`. Confirm `index.json.sig` names `moss-catalog-2026-b` and a dev instance on the A image shows the catalog as verified. Record the proof on the PR or issue. Then run the CLI tools manifest once from `main` (PR 2827 must be merged first) and approve it. | Rollout                                                  | Both publishes green, catalog verified on a live instance.                                                    |
| D       | Owner deletes the repository-wide secrets (section 6 step 5). A small PR updates the PR 2827 text and any doc that mentions repository-wide secrets. Decide whether to drop `a` from the ring (section 3).                                                                                                       | C                                                        | The two signing secrets are gone from repository secrets (others may remain). A fresh `main` run still signs. |

## Open points

- One key signs both the module index and the CLI manifest. They reject each other by shape, with no
  separate signing context (known limit from PR 2827). Splitting into two keys is possible later but
  doubles this plan, so it is out of scope here.
- Whether `module-registry` should require a reviewer is the owner's call (section 6 step 2).
- The module registry job runs `pnpm install` (dependency code) in the same job that holds the key,
  unlike the split CLI workflow. Existing state, not changed here.
- Before deciding to keep `a` pinned, look through past non-main runs of the module registry
  workflow. The old key sat in a repository-wide secret that any branch workflow could read.
