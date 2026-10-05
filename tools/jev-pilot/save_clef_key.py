#!/usr/bin/env python3
"""Save a Cloudflare Workers AI token and account ID for the Clef probe. Stdlib only.

The token is read without echo and written to ~/.config/jev-pilot/cloudflare-token (mode 0600,
directory 0700), next to the pilot's other saved keys. It is never printed or logged.
"""

import getpass
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.request

CONFIG = Path.home() / ".config/jev-pilot"
TOKEN_FILE = "cloudflare-token"
ACCOUNT_FILE = "cloudflare-account-id"
API = "https://api.cloudflare.com/client/v4"


def write_private(path, value):
    """Atomically write `value` to `path` as a 0600 file."""
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as out:
            out.write(value + "\n")
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def verify(token, account_id):
    """Ask Cloudflare whether the token is active; user tokens and account tokens verify differently."""
    for url in (f"{API}/user/tokens/verify", f"{API}/accounts/{account_id}/tokens/verify"):
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                status = json.loads(response.read(65536)).get("result", {}).get("status")
                if status == "active":
                    return "active"
        except (urllib.error.URLError, ValueError):
            continue
    return "not verified"


def main():
    print("Clef probe setup. Paste values when prompted; the token will not be shown.")
    account_id = input("Cloudflare account ID: ").strip()
    if not re.fullmatch(r"[0-9a-f]{32}", account_id):
        sys.exit("That doesn't look like an account ID (32 hex characters). Nothing saved.")
    token = getpass.getpass("Workers AI API token (hidden): ").strip()
    if not token or len(token) > 4096 or not token.isascii() or any(c.isspace() for c in token):
        sys.exit("That doesn't look like a token. Nothing saved.")

    CONFIG.mkdir(parents=True, exist_ok=True, mode=0o700)
    CONFIG.chmod(0o700)
    write_private(CONFIG / ACCOUNT_FILE, account_id)
    write_private(CONFIG / TOKEN_FILE, token)
    print(f"Saved to {CONFIG}/ ({TOKEN_FILE}, {ACCOUNT_FILE}), owner-only.")

    status = verify(token, account_id)
    print(f"Token check: {status}.")
    if status != "active":
        print("Cloudflare didn't confirm the token. It's saved anyway; re-run this to replace it.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCancelled.")
