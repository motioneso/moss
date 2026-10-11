#!/usr/bin/env python3
"""Exercise the real process-path C helper against synthetic libproc responses.

No live processes, audio hardware, Swift, or Apple SDK are inspected. The negative
control restores the unnecessary BSD-info prerequisite in a temporary copy and
must fail the named regression assertion, not compilation or process startup.
"""

import os
from pathlib import Path
import re
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parents[1] / "TrailMarker/Meetings/MeetingProcessInventory.c"
SWIFT_SOURCE = SOURCE.with_name("CoreAudioMeetingOutput.swift")
LIBPROC = r'''
#ifndef TEST_LIBPROC_H
#define TEST_LIBPROC_H
#include <stdint.h>
#define PROC_PIDPATHINFO_MAXSIZE 4096
int proc_listallpids(void *buffer, int buffersize);
int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize);
int proc_pidpath(int pid, void *buffer, uint32_t buffersize);
#endif
'''
PROC_INFO = r'''
#ifndef TEST_PROC_INFO_H
#define TEST_PROC_INFO_H
#include <stdint.h>
#define PROC_PIDTBSDINFO 3
struct proc_bsdinfo {
    uint32_t pbi_ppid;
    uint64_t pbi_start_tvsec;
    uint64_t pbi_start_tvusec;
};
#endif
'''
HARNESS = r'''
#include "MeetingProcessInventory.h"
#include <libproc.h>
#include <sys/proc_info.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(condition, name) do { if (!(condition)) { fprintf(stderr, "ASSERTION: %s\n", name); exit(23); } } while (0)
enum { NORMAL, UNREADABLE, EMPTY, RELATIVE, UNTERMINATED, TRUNCATED };
static int mode, bsd_reads, path_reads;
static const char *system_path = "/usr/sbin/coreaudiod";
int proc_listallpids(void *buffer, int buffersize) {
    CHECK(buffersize >= (int)(2 * sizeof(int32_t)), "fixture_pid_capacity");
    int32_t pids[] = { 101, 202 };
    memcpy(buffer, pids, sizeof(pids));
    return 2;
}
int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize) {
    ++bsd_reads;
    CHECK(flavor == PROC_PIDTBSDINFO && arg == 0, "fixture_bsd_request");
    if (pid == 202) { errno = EPERM; return 0; } /* A system process with denied BSD metadata. */
    CHECK(pid == 101 && buffersize == sizeof(struct proc_bsdinfo), "fixture_bsd_capacity");
    struct proc_bsdinfo info = { .pbi_ppid = 1, .pbi_start_tvsec = 123, .pbi_start_tvusec = 456 };
    memcpy(buffer, &info, sizeof(info));
    return sizeof(info);
}
int proc_pidpath(int pid, void *buffer, uint32_t buffersize) {
    ++path_reads;
    CHECK(pid == 101 || pid == 202, "fixture_path_pid");
    CHECK(buffersize == PROC_PIDPATHINFO_MAXSIZE, "fixture_path_capacity");
    if (mode == UNREADABLE) return 0;
    if (mode == UNTERMINATED) {
        memset(buffer, 'x', buffersize);
        ((char *)buffer)[0] = '/';
        return (int)buffersize - 1;
    }
    const char *path = pid == 101 ? "/Applications/Trail Marker.app/Contents/MacOS/Trail Marker" : system_path;
    if (mode == EMPTY) path = "";
    if (mode == RELATIVE) path = "usr/sbin/coreaudiod";
    memcpy(buffer, path, strlen(path) + 1);
    if (mode == TRUNCATED) return buffersize;
    return mode == EMPTY ? 1 : (int)strlen(path);
}
int main(void) {
    int32_t listed[4] = {0};
    CHECK(MMListProcesses(listed, 4) == 2 && listed[1] == 202, "system_process_is_listed");
    MMProcessIdentity identity;
    CHECK(MMReadProcess(101, &identity) == 1, "full_identity_still_reads_bsd_metadata");
    CHECK(identity.pid == 101 && identity.parent_pid == 1 && identity.start_seconds == 123 &&
          identity.start_microseconds == 456, "full_identity_retains_metadata");
    bsd_reads = path_reads = 0;
    CHECK(MMReadProcess(202, &identity) == 0, "legacy_identity_rejects_denied_bsd_metadata");
    CHECK(errno == EPERM, "legacy_identity_reports_permission_denial");
    CHECK(bsd_reads == 1 && path_reads == 0, "legacy_failure_precedes_readable_path");
    bsd_reads = path_reads = 0;
    char path[PROC_PIDPATHINFO_MAXSIZE];
    CHECK(MMReadProcessPath(listed[1], path, sizeof(path)) == 1, "readable_path_does_not_require_bsd");
    CHECK(strcmp(path, system_path) == 0, "path_matches_libproc");
    CHECK(bsd_reads == 0 && path_reads == 1, "path_only_query_never_reads_bsd");
    for (mode = UNREADABLE; mode <= TRUNCATED; ++mode) {
        memset(path, 'x', sizeof(path));
        CHECK(MMReadProcessPath(202, path, sizeof(path)) == 0, "unreadable_or_malformed_path_rejected");
    }
    mode = NORMAL;
    path_reads = 0;
    CHECK(MMReadProcessPath(0, path, sizeof(path)) == 0, "zero_pid_rejected");
    CHECK(MMReadProcessPath(-1, path, sizeof(path)) == 0, "negative_pid_rejected");
    CHECK(MMReadProcessPath(202, NULL, sizeof(path)) == 0, "null_buffer_rejected");
    CHECK(MMReadProcessPath(202, path, 0) == 0, "zero_capacity_rejected");
    CHECK(MMReadProcessPath(202, path, sizeof(path) - 1) == 0, "short_capacity_rejected");
    CHECK(MMReadProcessPath(202, path, SIZE_MAX) == 0, "oversized_capacity_rejected");
    CHECK(bsd_reads == 0 && path_reads == 0, "invalid_arguments_do_not_query_libproc");
    CHECK(MMReadProcessPath(202, path, sizeof(path)) == 1, "valid_read_after_failures");
    puts("Process-path checks passed; BSD-denied readable path accepted, uncertain paths rejected.");
    return 0;
}
'''


def check_swift_wiring():
    source = SWIFT_SOURCE.read_text()
    reader = re.search(r"static func executablePath\(_ pid: Int32\) throws -> String \{(.*?)\n    \}", source, re.S)
    if reader is None or re.search(r"\bMMReadProcessPath\s*\(", reader[1]) is None or re.search(r"\bMMReadProcess\s*\(", reader[1]):
        raise RuntimeError("Swift executablePath must use the path-only helper, not full BSD identity")
    scanner = re.search(r"static func mossAudioProcesses\(original: \[UInt32: Int32\],(.*?)\{\n        var bundles", source, re.S)
    if scanner is None or re.search(r"readPath:\s*\(Int32\) throws -> String = executablePath\s*,", scanner[1]) is None:
        raise RuntimeError("The real exclusion scanner must default to executablePath")
    print("STATIC WIRING VERIFIED: Swift scanner defaults to the path-only reader. This is not Swift execution.")


def run(folder, name, source, negative=False):
    c_file, binary = folder / f"{name}.c", folder / name
    c_file.write_text(source)
    compiled = subprocess.run([
        os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic",
        "-fsanitize=undefined", "-I", str(folder), "-I", str(SOURCE.parent),
        str(c_file), str(folder / "harness.c"), "-o", str(binary)
    ], capture_output=True, text=True, timeout=30)
    if compiled.returncode:
        raise RuntimeError(f"{name}: compilation is not behavioral proof: {compiled.stderr[:2000]}")
    result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30)
    if negative:
        expected = "ASSERTION: readable_path_does_not_require_bsd"
        if result.returncode != 23 or result.stderr.strip() != expected:
            raise RuntimeError(f"{name}: did not fail the regression assertion: {result.returncode} {result.stderr[:2000]}")
        print(f"NEGATIVE VERIFIED: {name}: {result.stderr.strip()}")
    elif result.returncode != 0 or result.stderr:
        raise RuntimeError(f"{name}: process-path checks failed: {result.returncode} {result.stderr[:2000]}")
    else:
        print(result.stdout.strip())


def main():
    check_swift_wiring()
    original = SOURCE.read_text()
    anchor = "int MMReadProcessPath(int32_t pid, char *path, size_t capacity) {"
    if original.count(anchor) != 1:
        raise RuntimeError("Process-path helper mutation anchor changed")
    mutation = anchor + """
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
"""
    with tempfile.TemporaryDirectory(prefix="meeting-process-path-c-") as directory:
        folder = Path(directory)
        (folder / "sys").mkdir()
        (folder / "libproc.h").write_text(LIBPROC)
        (folder / "sys/proc_info.h").write_text(PROC_INFO)
        (folder / "harness.c").write_text(HARNESS)
        run(folder, "positive", original)
        run(folder, "bsd-prerequisite", original.replace(anchor, mutation, 1), negative=True)
        run(folder, "restored", original)
    print("Portable C evidence only. Swift scanner, Apple SDK, and live Start remain separate gates.")


if __name__ == "__main__":
    main()
