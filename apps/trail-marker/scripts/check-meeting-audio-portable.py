#!/usr/bin/env python3
"""Exercise the real C audio atomics/mailbox, including concurrent producers.

This is portable synthetic evidence only. It does not run Swift or Core Audio.
Mutation probes compile temporary copies and require assertion failure, never a
compiler error, timeout, crash or a mutation of the shared checkout.
"""

import os
from pathlib import Path
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parents[1] / "TrailMarker/Meetings/MeetingAudioAtomic.c"
HARNESS = r'''
#include "MeetingAudioAtomic.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sched.h>
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "ASSERTION: %s:%d: %s\n", __FILE__, __LINE__, #c); exit(23); } } while (0)
#define PRODUCERS 4
#define RECORDS 5000
static MeetingAudioDropMailbox *shared;
static bool accepted[PRODUCERS * RECORDS];
static bool seen[PRODUCERS * RECORDS];
static atomic_uint finished;
static MeetingAudioDropRecord record(unsigned i) {
    return (MeetingAudioDropRecord){ .sampleTime = (double)i, .hostTimeNanoseconds = (uint64_t)i * 1000000,
        .sampleRate = 44100, .frameCount = i % 8192 + 1 };
}
static void *produce(void *argument) {
    unsigned producer = *(unsigned *)argument;
    for (unsigned n = 0; n < RECORDS; ++n) {
        unsigned i = producer * RECORDS + n;
        accepted[i] = MeetingAudioDropMailboxPush(shared, record(i));
    }
    atomic_fetch_add_explicit(&finished, 1, memory_order_release);
    return NULL;
}
static void validate(MeetingAudioDropRecord value) {
    unsigned i = (unsigned)value.sampleTime;
    CHECK(i < PRODUCERS * RECORDS);
    CHECK(value.sampleTime == (double)i);
    CHECK(value.hostTimeNanoseconds == (uint64_t)i * 1000000);
    CHECK(value.sampleRate == 44100);
    CHECK(value.frameCount == i % 8192 + 1);
    CHECK(!seen[i]);
    seen[i] = true;
}
int main(void) {
    MeetingAudioAtomicDeadline *deadline = MeetingAudioDeadlineCreate(UINT64_MAX);
    CHECK(deadline != NULL);
    CHECK(MeetingAudioDeadlineLoad(deadline) == UINT64_MAX);
    MeetingAudioDeadlineStore(deadline, UINT64_C(30000000000));
    CHECK(MeetingAudioDeadlineLoad(deadline) == UINT64_C(30000000000));
    MeetingAudioDeadlineDestroy(deadline);
    MeetingAudioAtomicWord *word = MeetingAudioAtomicCreate(0);
    CHECK(word != NULL);
    CHECK(MeetingAudioAtomicOr(word, 2) == 0);
    CHECK(MeetingAudioAtomicOr(word, 1) == 2);
    CHECK(MeetingAudioAtomicLoad(word) == 3);
    CHECK(!MeetingAudioAtomicCompareExchange(word, 0, 5));
    CHECK(MeetingAudioAtomicCompareExchange(word, 3, 5));
    CHECK(MeetingAudioAtomicExchange(word, 0) == 5);
    MeetingAudioAtomicDestroy(word);

    shared = MeetingAudioDropMailboxCreate();
    CHECK(shared != NULL);
    MeetingAudioDropRecord output;
    CHECK(!MeetingAudioDropMailboxPop(shared, &output));
    for (unsigned i = 64; i > 0; --i) { CHECK(MeetingAudioDropMailboxPush(shared, record(i - 1))); }
    CHECK(!MeetingAudioDropMailboxPush(shared, record(64)));
    CHECK(MeetingAudioDropMailboxReadCounts(shared).accepted == 64);
    CHECK(MeetingAudioDropMailboxReadCounts(shared).rejected == 1);
    for (unsigned i = 0; i < 64; ++i) {
        CHECK(MeetingAudioDropMailboxPop(shared, &output));
        CHECK(output.sampleTime == (double)i);
    }
    CHECK(!MeetingAudioDropMailboxPop(shared, &output));

    atomic_init(&finished, 0);
    pthread_t threads[PRODUCERS];
    unsigned ids[PRODUCERS];
    for (unsigned i = 0; i < PRODUCERS; ++i) {
        ids[i] = i;
        CHECK(pthread_create(&threads[i], NULL, produce, &ids[i]) == 0);
    }
    while (atomic_load_explicit(&finished, memory_order_acquire) != PRODUCERS) {
        if (MeetingAudioDropMailboxPop(shared, &output)) { validate(output); }
        else { sched_yield(); }
    }
    for (unsigned i = 0; i < PRODUCERS; ++i) { CHECK(pthread_join(threads[i], NULL) == 0); }
    while (MeetingAudioDropMailboxPop(shared, &output)) { validate(output); }
    unsigned delivered = 0;
    for (unsigned i = 0; i < PRODUCERS * RECORDS; ++i) {
        CHECK(accepted[i] == seen[i]);
        if (seen[i]) { ++delivered; }
    }
    CHECK(delivered > 0);
    CHECK(MeetingAudioDropMailboxReadCounts(shared).accepted == 64 + delivered);
    CHECK(MeetingAudioDropMailboxReadCounts(shared).rejected == 1 + PRODUCERS * RECORDS - delivered);
    // Reusable after simultaneous producers, consumer and full-mailbox failures.
    CHECK(MeetingAudioDropMailboxPush(shared, record(7)));
    CHECK(MeetingAudioDropMailboxPop(shared, &output));
    CHECK(output.sampleTime == 7);
    CHECK(!MeetingAudioDropMailboxPop(shared, &output));
    MeetingAudioDropMailboxDestroy(shared);
    printf("C audio checks passed; %u concurrent records preserved, all rejected writes explicit.\n", delivered);
    return 0;
}
'''


def run(folder, name, source, negative=False):
    c_file = folder / f"{name}.c"
    binary = folder / name
    c_file.write_text(source)
    compiled = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-pedantic", "-pthread", "-fsanitize=undefined", "-I", str(SOURCE.parent),
        str(c_file), str(folder / "harness.c"), "-o", str(binary)], capture_output=True, text=True, timeout=30)
    if compiled.returncode:
        raise RuntimeError(f"{name}: compilation is not behavioral proof: {compiled.stderr[:2000]}")
    result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30)
    if negative:
        if result.returncode != 23 or "ASSERTION:" not in result.stderr:
            raise RuntimeError(f"{name}: mutation did not fail a harness assertion: {result.returncode} {result.stderr[:2000]}")
        print(f"NEGATIVE VERIFIED: {name}: {result.stderr.strip()}")
    elif result.returncode != 0 or result.stderr:
        raise RuntimeError(f"{name}: C checks failed: {result.returncode} {result.stderr[:2000]}")
    else:
        print(result.stdout.strip())


def main():
    original = SOURCE.read_text()
    mutations = [
        ("unpublished-drop", "atomic_store_explicit(&mailbox->slots[i].state, 2, memory_order_release);",
         "atomic_store_explicit(&mailbox->slots[i].state, 0, memory_order_release);"),
        ("silent-capacity-overflow", "    return false;\n}\nbool MeetingAudioDropMailboxPop",
         "    return true;\n}\nbool MeetingAudioDropMailboxPop"),
        ("reversed-sample-order", "mailbox->slots[i].record.sampleTime < mailbox->slots[selected].record.sampleTime",
         "mailbox->slots[i].record.sampleTime > mailbox->slots[selected].record.sampleTime"),
    ]
    with tempfile.TemporaryDirectory(prefix="meeting-audio-c-") as directory:
        folder = Path(directory)
        (folder / "harness.c").write_text(HARNESS)
        run(folder, "positive", original)
        for name, before, after in mutations:
            if original.count(before) != 1:
                raise RuntimeError(f"{name}: mutation anchor changed")
            run(folder, name, original.replace(before, after, 1), negative=True)
        run(folder, "restored", original)
    print("Portable C checks complete. Swift/XCTest, Apple SDK and hardware remain separate gates.")


if __name__ == "__main__":
    main()
