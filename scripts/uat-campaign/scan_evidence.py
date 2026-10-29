#!/usr/bin/env python3
"""Evidence-wide masked secret scan for an R19 campaign. Read-only; prints counts and paths, never matches."""
import json, os, re, stat, sys

# A real token has a long body after the prefix; the runner's own search constant does not.
TOKEN = re.compile(rb"sk-ant-[a-z]{2,6}\d{0,3}-[A-Za-z0-9_\-]{20,}")
SKIP = {"source", "source.tar"}  # pinned repo snapshot; holds documented patterns and synthetic test keys
REPORT = "evidence-scan.json"


def mask(rel):
    return TOKEN.sub(b"[MASKED]", rel.encode("utf-8", "surrogateescape")).decode("utf-8", "replace")


def identity(st):
    return (st.st_mode, st.st_ino, st.st_dev, st.st_size, st.st_mtime_ns)


def walk(campaign, r, read):
    """Lists every entry with lstat and never follows links. Returns {relpath: identity}."""
    seen = {}
    stack = [campaign]
    while stack:
        d = stack.pop()
        try:
            names = os.listdir(d)
        except OSError:
            r["unreadable"].add(mask(os.path.relpath(d, campaign)))
            continue
        for n in names:
            if d == campaign and (n in SKIP or n == REPORT):
                continue
            p = os.path.join(d, n)
            rel = os.path.relpath(p, campaign)
            try:
                st = os.lstat(p)
            except OSError:
                r["unreadable"].add(mask(rel))
                continue
            seen[rel] = identity(st)
            if stat.S_ISDIR(st.st_mode):
                stack.append(p)
            elif stat.S_ISLNK(st.st_mode):
                seen[rel] += (os.readlink(p),)
                if read:
                    check_link(campaign, p, r)
            elif not read:
                continue
            elif stat.S_ISREG(st.st_mode):
                scan_file(p, st, mask(rel), r)
            else:
                # Sockets and pipes hold no saved bytes; they are listed, not read.
                r["special"].add(mask(rel))
    return seen


def check_link(campaign, p, r):
    """A link must resolve to an existing path inside the campaign, outside the skipped source."""
    target = os.path.realpath(p)
    top = os.path.relpath(target, campaign).split(os.sep)[0]
    if (os.path.commonpath([target, campaign]) != campaign or not os.path.exists(target)
            or top in SKIP):
        r["links"].add(mask(os.path.relpath(p, campaign)))


def scan_file(p, st, rel, r):
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        r["unreadable"].add(rel)
        return
    with os.fdopen(fd, "rb") as f:
        # The opened file must be the one listed, unchanged, and read in full.
        if identity(os.fstat(f.fileno())) != identity(st):
            r["changed"].add(rel)
            return
        data = f.read()
        if len(data) != st.st_size or identity(os.fstat(f.fileno())) != identity(st):
            r["changed"].add(rel)
            return
    r["files"] += 1
    c = len(TOKEN.findall(data))
    if c:
        r["hits"].append({"path": rel, "count": c})


def main(campaign):
    # The report path must be empty, so the scan never skips or overwrites saved bytes there.
    if os.path.lexists(os.path.join(campaign, REPORT)):
        print(json.dumps({"passed": False, "error": "report path already occupied"}))
        return 1
    r = {"files": 0, "hits": [], "unreadable": set(), "links": set(), "special": set(),
         "changed": set()}
    first = walk(campaign, r, read=True)

    # A second listing must match the first exactly, so nothing appeared, vanished or changed mid-scan.
    second = walk(campaign, r, read=False)
    differ = set(first) ^ set(second)
    differ |= {k for k in first.keys() & second.keys() if first[k] != second[k]}
    r["changed"] |= {mask(k) for k in differ}

    out = {"filesScanned": r["files"], "tokenHits": r["hits"],
           "unreadable": sorted(r["unreadable"]), "linksLeavingCampaign": sorted(r["links"]),
           "changedDuringScan": sorted(r["changed"]), "specialEntries": sorted(r["special"])}
    out["passed"] = not (r["hits"] or r["unreadable"] or r["links"] or r["changed"])
    fd = os.open(os.path.join(campaign, REPORT), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    with os.fdopen(fd, "w") as f:
        json.dump(out, f, indent=2)
    print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in out.items()}))
    return 0 if out["passed"] else 1


if __name__ == "__main__":
    sys.exit(main(os.path.abspath(sys.argv[1])))
