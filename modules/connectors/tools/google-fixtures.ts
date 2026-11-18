/** Writes (or with --check, verifies) host/tests/google-fixtures.json from the old Google
 *  helpers: the consent address and the redirect parsing. Run through pnpm exec tsx. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  GoogleOAuthClient,
  GOOGLE_LOOPBACK_REDIRECT,
  GOOGLE_SCOPES,
  parseRedirectUrl
} from "../../../packages/connectors/src/oauth.js";

const inputs = [
  "http://localhost:1/?code=abc&state=xyz",
  "  http://localhost:1/?state=xyz&code=a%2Fb+c  ",
  "http://localhost:1/?error=access_denied&state=xyz",
  "http://localhost:1/?code=abc",
  "http://localhost:1/?state=xyz",
  "http://localhost:1/?code=&state=xyz",
  "http://localhost:1/",
  "not a url",
  ""
];
const redirects = inputs.map((input) => {
  try {
    const { code, state } = parseRedirectUrl(input);
    return { input, code, state };
  } catch (error) {
    return { input, error: (error as Error).message };
  }
});
const authUrl = new GoogleOAuthClient().buildAuthUrl({
  clientId: "cid.apps.example.com",
  scopes: GOOGLE_SCOPES,
  redirectUri: GOOGLE_LOOPBACK_REDIRECT,
  state: "state-1"
});
const text = JSON.stringify({ authUrl, redirects }, null, 2) + "\n";
const file = new URL("../host/tests/google-fixtures.json", import.meta.url);
if (process.argv.includes("--check")) {
  assert.equal(readFileSync(file, "utf8"), text, "google-fixtures.json is stale");
  console.log("PASS google fixtures match the old helpers");
} else writeFileSync(file, text);
