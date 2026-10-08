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
#include <math.h>
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
    CHECK(value.maximumFrameCount == value.frameCount);
    CHECK(value.firstFrameCount == value.frameCount);
    CHECK(value.cause == 0);
    CHECK(!seen[i]);
    seen[i] = true;
}
static MeetingAudioDropRecord callback(unsigned i, unsigned frames, unsigned cause) {
    return (MeetingAudioDropRecord){ .sampleTime = (double)i * frames,
        .hostTimeNanoseconds = UINT64_C(1000000000) + (uint64_t)i * frames * 1000000000 / 48000,
        .sampleRate = 48000, .frameCount = frames, .cause = cause };
}
static MeetingAudioDropMailbox *mailbox(void) {
    MeetingAudioDropMailbox *value = MeetingAudioDropMailboxCreate();
    CHECK(value != NULL);
    return value;
}
static void coalescingChecks(void) {
    // More callbacks than a 500 ms 128-frame/48 kHz source recheck can produce.
    for (int skew = -1; skew <= 1; ++skew) {
        MeetingAudioDropMailbox *queue = mailbox();
        for (unsigned i = 0; i < 256; ++i) {
            MeetingAudioDropRecord value = callback(i, 128, 1);
            uint64_t drift = (value.hostTimeNanoseconds - UINT64_C(1000000000)) / 50000;
            if (skew < 0) { value.hostTimeNanoseconds -= drift; }
            if (skew > 0) { value.hostTimeNanoseconds += drift; }
            CHECK(MeetingAudioDropMailboxPush(queue, value));
        }
        MeetingAudioDropRecord output;
        CHECK(MeetingAudioDropMailboxReadCounts(queue).accepted == 256);
        CHECK(MeetingAudioDropMailboxReadCounts(queue).rejected == 0);
        CHECK(MeetingAudioDropMailboxPop(queue, &output));
        CHECK(output.sampleTime == 0 && output.hostTimeNanoseconds == UINT64_C(1000000000));
        CHECK(output.frameCount == 256 * 128 && output.maximumFrameCount == 128 && output.firstFrameCount == 128 && output.cause == 1);
        MeetingAudioDropRecord last = callback(255, 128, 1);
        uint64_t lastDrift = (last.hostTimeNanoseconds - UINT64_C(1000000000)) / 50000;
        if (skew < 0) { last.hostTimeNanoseconds -= lastDrift; }
        if (skew > 0) { last.hostTimeNanoseconds += lastDrift; }
        CHECK(output.observedEndNanoseconds == last.hostTimeNanoseconds + UINT64_C(2666667));
        CHECK(!MeetingAudioDropMailboxPop(queue, &output));
        MeetingAudioDropMailboxDestroy(queue);
    }

    MeetingAudioDropMailbox *queue = mailbox();
    MeetingAudioDropRecord output;
    unsigned sizes[] = {128, 512, 256};
    unsigned offset = 0;
    for (unsigned i = 0; i < 3; ++i) {
        MeetingAudioDropRecord value = callback(offset, 1, 0);
        value.frameCount = sizes[i];
        CHECK(MeetingAudioDropMailboxPush(queue, value));
        offset += sizes[i];
    }
    CHECK(MeetingAudioDropMailboxPop(queue, &output));
    CHECK(output.frameCount == 896 && output.maximumFrameCount == 512 && output.firstFrameCount == 128);
    CHECK(!MeetingAudioDropMailboxPop(queue, &output));
    MeetingAudioDropMailboxDestroy(queue);

    // Host jitter can reverse adjacent starts without resetting the sample clock.
    queue = mailbox();
    MeetingAudioDropRecord successor = callback(1, 8, 0);
    successor.hostTimeNanoseconds = UINT64_C(1000000);
    MeetingAudioDropRecord jittered = callback(2, 8, 0);
    jittered.hostTimeNanoseconds = UINT64_C(999999);
    CHECK(MeetingAudioDropMailboxPush(queue, successor));
    CHECK(MeetingAudioDropMailboxPush(queue, jittered));
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 8, true, &output) == 1 && output.sampleTime == 8);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 16, true, &output) == 1 && output.sampleTime == 16);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 24, true, &output) == 0);
    MeetingAudioDropMailboxDestroy(queue);

    // An apparent successor after a reset must not jump ahead of the reset frontier.
    queue = mailbox();
    MeetingAudioDropRecord reset = callback(0, 8, 1);
    reset.hostTimeNanoseconds = UINT64_C(2000000);
    successor.hostTimeNanoseconds = UINT64_C(3000000);
    CHECK(MeetingAudioDropMailboxPush(queue, reset));
    CHECK(MeetingAudioDropMailboxPush(queue, successor));
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 8, true, &output) == 1 && output.sampleTime == 0);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 8, true, &output) == 1 && output.sampleTime == 8);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 16, true, &output) == 0);
    MeetingAudioDropMailboxDestroy(queue);

    // Reservation order disambiguates a reset whose measured start has negative jitter.
    queue = mailbox();
    successor.sampleRate = reset.sampleRate = 8000;
    successor.hostTimeNanoseconds = UINT64_C(1000000);
    reset.hostTimeNanoseconds = UINT64_C(999999);
    reset.frameCount = 16;
    CHECK(MeetingAudioDropMailboxPush(queue, successor));
    CHECK(MeetingAudioDropMailboxPush(queue, reset));
    successor.sampleTime = 16;
    successor.hostTimeNanoseconds = UINT64_C(2999999);
    CHECK(MeetingAudioDropMailboxPush(queue, successor));
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 8, true, &output) == 1);
    CHECK(output.sampleTime == 8 && output.frameCount == 8);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 16, true, &output) == 1);
    CHECK(output.sampleTime == 0 && output.frameCount == 16);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 16, true, &output) == 1);
    CHECK(output.sampleTime == 16 && output.frameCount == 8);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 24, true, &output) == 0);
    MeetingAudioDropMailboxDestroy(queue);

    queue = mailbox();
    for (unsigned i = 0; i < 300; ++i) {
        CHECK(MeetingAudioDropMailboxPush(queue, callback(i, 128, (i / 100) % 2)));
    }
    for (unsigned i = 0; i < 3; ++i) {
        CHECK(MeetingAudioDropMailboxPop(queue, &output));
        CHECK(output.sampleTime == (double)i * 12800 && output.frameCount == 12800);
        CHECK(output.cause == i % 2 && output.maximumFrameCount == 128);
    }
    CHECK(!MeetingAudioDropMailboxPop(queue, &output));
    MeetingAudioDropMailboxDestroy(queue);

    // A reset stays a separate chronological segment, even when publication is reversed.
    for (unsigned reversed = 0; reversed < 2; ++reversed) {
        queue = mailbox();
        MeetingAudioDropRecord before = callback(0, 128, 1);
        before.sampleTime = 4096;
        MeetingAudioDropRecord after = callback(1, 128, 1);
        after.sampleTime = 0;
        CHECK(MeetingAudioDropMailboxPush(queue, reversed ? after : before));
        CHECK(MeetingAudioDropMailboxPush(queue, reversed ? before : after));
        CHECK(MeetingAudioDropMailboxPop(queue, &output));
        CHECK(output.sampleTime == 4096 && output.frameCount == 128);
        CHECK(output.hostTimeNanoseconds == before.hostTimeNanoseconds);
        CHECK(MeetingAudioDropMailboxPop(queue, &output));
        CHECK(output.sampleTime == 0 && output.frameCount == 128);
        CHECK(!MeetingAudioDropMailboxPop(queue, &output));
        MeetingAudioDropMailboxDestroy(queue);
    }

    // Equal host timestamps use stable reservation order, not counter magnitude or slot reuse.
    queue = mailbox();
    MeetingAudioDropRecord tie = callback(0, 128, 0);
    tie.sampleTime = 4096;
    CHECK(MeetingAudioDropMailboxPush(queue, tie));
    tie.sampleTime = 2048;
    CHECK(MeetingAudioDropMailboxPush(queue, tie));
    CHECK(MeetingAudioDropMailboxPop(queue, &output) && output.sampleTime == 4096);
    tie.sampleTime = 0;
    CHECK(MeetingAudioDropMailboxPush(queue, tie));
    CHECK(MeetingAudioDropMailboxPop(queue, &output) && output.sampleTime == 2048);
    CHECK(MeetingAudioDropMailboxPop(queue, &output) && output.sampleTime == 0);
    CHECK(!MeetingAudioDropMailboxPop(queue, &output));
    MeetingAudioDropMailboxDestroy(queue);

    // Rate changes, discontinuous samples, nonadvancing hosts and excessive jitter never merge.
    for (unsigned boundary = 0; boundary < 5; ++boundary) {
        queue = mailbox();
        MeetingAudioDropRecord first = callback(0, 128, 0);
        MeetingAudioDropRecord next = callback(1, 128, 0);
        if (boundary == 0) { next.sampleRate = 44100; }
        if (boundary == 1) { next.sampleTime += 128; }
        if (boundary == 2) { next.hostTimeNanoseconds = first.hostTimeNanoseconds; }
        if (boundary == 3) { next.hostTimeNanoseconds += UINT64_C(2666667); }
        if (boundary == 4) {
            first.hostTimeNanoseconds = UINT64_MAX - UINT64_C(5333332) + 200;
            next.hostTimeNanoseconds = first.hostTimeNanoseconds + UINT64_C(2666666) - 500;
        }
        CHECK(MeetingAudioDropMailboxPush(queue, first));
        CHECK(MeetingAudioDropMailboxPush(queue, next));
        CHECK(MeetingAudioDropMailboxPop(queue, &output) && output.frameCount == 128);
        CHECK(MeetingAudioDropMailboxPop(queue, &output) && output.frameCount == 128);
        CHECK(!MeetingAudioDropMailboxPop(queue, &output));
        MeetingAudioDropMailboxDestroy(queue);
    }

    queue = mailbox();
    for (unsigned bad = 0; bad < 14; ++bad) {
        MeetingAudioDropRecord value = callback(0, 128, 0);
        switch (bad) {
            case 0: value.sampleTime = NAN; break;
            case 1: value.sampleTime = INFINITY; break;
            case 2: value.sampleTime = 0.5; break;
            case 3: value.sampleRate = NAN; break;
            case 4: value.sampleRate = 0; break;
            case 5: value.sampleRate = 48000.5; break;
            case 6: value.sampleRate = 192001; break;
            case 7: value.frameCount = 0; break;
            case 8: value.frameCount = 8193; break;
            case 9: value.frameCount = UINT32_MAX; break;
            case 10: value.maximumFrameCount = 127; break;
            case 11: value.cause = 2; break;
            case 12: value.hostTimeNanoseconds = UINT64_MAX; break;
            case 13: value.firstFrameCount = 127; break;
        }
        CHECK(!MeetingAudioDropMailboxPush(queue, value));
    }
    CHECK(MeetingAudioDropMailboxReadCounts(queue).accepted == 0);
    CHECK(MeetingAudioDropMailboxReadCounts(queue).rejected == 14);
    CHECK(!MeetingAudioDropMailboxPop(queue, &output));
    MeetingAudioDropMailboxDestroy(queue);

    // Coalescing is bounded too: split before exceeding the downstream frame limit.
    queue = mailbox();
    for (unsigned i = 0; i < 1407; ++i) {
        CHECK(MeetingAudioDropMailboxPush(queue, callback(i, 8192, 0)));
    }
    CHECK(MeetingAudioDropMailboxPop(queue, &output));
    CHECK(output.frameCount == 1406 * 8192 && output.maximumFrameCount == 8192);
    CHECK(MeetingAudioDropMailboxPop(queue, &output));
    CHECK(output.frameCount == 8192 && output.sampleTime == (double)1406 * 8192);
    CHECK(!MeetingAudioDropMailboxPop(queue, &output));
    MeetingAudioDropMailboxDestroy(queue);
}
static void *produceCoalesced(void *argument) {
    unsigned producer = *(unsigned *)argument;
    for (unsigned n = 0; n < RECORDS; ++n) {
        unsigned i = producer * RECORDS + n;
        accepted[i] = MeetingAudioDropMailboxPush(shared, callback(i, 128, producer % 2));
        if (n % 8 == 0) { sched_yield(); }
    }
    atomic_fetch_add_explicit(&finished, 1, memory_order_release);
    return NULL;
}
static void validateCoalesced(MeetingAudioDropRecord value) {
    unsigned first = (unsigned)(value.sampleTime / 128);
    CHECK(first < PRODUCERS * RECORDS && value.sampleTime == (double)first * 128);
    CHECK(value.hostTimeNanoseconds == callback(first, 128, 0).hostTimeNanoseconds);
    CHECK(value.sampleRate == 48000 && value.maximumFrameCount == 128 && value.firstFrameCount == 128);
    CHECK(value.frameCount > 0 && value.frameCount % 128 == 0 && value.frameCount <= 11520000);
    unsigned count = value.frameCount / 128;
    CHECK(count <= PRODUCERS * RECORDS - first);
    CHECK(value.observedEndNanoseconds == callback(first + count - 1, 128, 0).hostTimeNanoseconds + UINT64_C(2666667));
    for (unsigned i = first; i < first + count; ++i) {
        CHECK(value.cause == (i / RECORDS) % 2);
        CHECK(!seen[i]);
        seen[i] = true;
    }
}
int main(void) {
    MeetingAudioLevel *level = MeetingAudioLevelCreate();
    CHECK(level != NULL);
    CHECK(MeetingAudioLevelRead(level, 0) == 0);
    MeetingAudioLevelStore(level, 0.5f, UINT64_C(1000000000));
    CHECK(MeetingAudioLevelRead(level, UINT64_C(1100000000)) > 0.4999f);
    CHECK(MeetingAudioLevelRead(level, UINT64_C(1100000000)) <= 0.5f);
    CHECK(MeetingAudioLevelRead(level, UINT64_C(1499999999)) > 0);
    CHECK(MeetingAudioLevelRead(level, UINT64_C(1500000000)) == 0);
    CHECK(MeetingAudioLevelRead(level, UINT64_C(999999999)) == 0);
    MeetingAudioLevelStore(level, 0.75f, UINT64_C(2000000000));
    CHECK(MeetingAudioLevelRead(level, UINT64_C(2000000000)) > 0.74f);
    MeetingAudioLevelStore(level, 0, UINT64_C(2100000000));
    CHECK(MeetingAudioLevelRead(level, UINT64_C(2200000000)) == 0);
    MeetingAudioLevelStore(level, NAN, UINT64_C(2000000000));
    CHECK(MeetingAudioLevelRead(level, UINT64_C(2100000000)) == 0);
    MeetingAudioLevelStore(level, INFINITY, UINT64_C(2000000000));
    CHECK(MeetingAudioLevelRead(level, UINT64_C(2100000000)) == 0);
    MeetingAudioLevelStore(level, -1, UINT64_C(2000000000));
    CHECK(MeetingAudioLevelRead(level, UINT64_C(2100000000)) == 0);
    MeetingAudioLevelStore(level, 2, UINT64_MAX);
    CHECK(MeetingAudioLevelRead(level, UINT64_MAX) == 1);
    CHECK(MeetingAudioLevelRead(level, 0) == 0);
    MeetingAudioLevelDestroy(level);
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

    coalescingChecks();

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

    shared = mailbox();
    atomic_store_explicit(&finished, 0, memory_order_relaxed);
    for (unsigned i = 0; i < PRODUCERS * RECORDS; ++i) { accepted[i] = seen[i] = false; }
    for (unsigned i = 0; i < PRODUCERS; ++i) {
        CHECK(pthread_create(&threads[i], NULL, produceCoalesced, &ids[i]) == 0);
    }
    while (atomic_load_explicit(&finished, memory_order_acquire) != PRODUCERS) {
        if (MeetingAudioDropMailboxPop(shared, &output)) { validateCoalesced(output); }
        else { sched_yield(); }
    }
    for (unsigned i = 0; i < PRODUCERS; ++i) { CHECK(pthread_join(threads[i], NULL) == 0); }
    while (MeetingAudioDropMailboxPop(shared, &output)) { validateCoalesced(output); }
    delivered = 0;
    for (unsigned i = 0; i < PRODUCERS * RECORDS; ++i) {
        CHECK(accepted[i] == seen[i]);
        if (seen[i]) { ++delivered; }
    }
    CHECK(delivered > 0);
    CHECK(MeetingAudioDropMailboxReadCounts(shared).accepted == delivered);
    CHECK(MeetingAudioDropMailboxReadCounts(shared).rejected == PRODUCERS * RECORDS - delivered);
    MeetingAudioDropMailboxDestroy(shared);
    printf("Coalesced concurrent checks passed; %u accepted callbacks preserved without loss or duplication.\n", delivered);
    return 0;
}
'''

OWNERSHIP_HARNESS = r'''
#include "MeetingAudioAtomic.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sched.h>
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "ASSERTION: %s:%d: %s\n", __FILE__, __LINE__, #c); exit(23); } } while (0)
static atomic_uint stage;
static atomic_uint mode;
static MeetingAudioDropMailbox *queue;
static MeetingAudioDropRecord output;
static int status;
void MeetingAudioTestPause(unsigned kind) {
    if (atomic_load_explicit(&mode, memory_order_acquire) != kind) { return; }
    unsigned expected = 0;
    if (!atomic_compare_exchange_strong_explicit(&stage, &expected, 1, memory_order_release, memory_order_relaxed)) { return; }
    while (atomic_load_explicit(&stage, memory_order_acquire) == 1) { sched_yield(); }
}
static MeetingAudioDropRecord callback(unsigned i) {
    return (MeetingAudioDropRecord){ .sampleTime = (double)i * 128,
        .hostTimeNanoseconds = UINT64_C(1000000000) + (uint64_t)i * 128 * 1000000000 / 48000,
        .sampleRate = 48000, .frameCount = 128 };
}
static void *consume(void *ignored) {
    (void)ignored;
    status = MeetingAudioDropMailboxPopForClock(queue, 0, false, &output);
    return NULL;
}
static void *produce(void *ignored) {
    (void)ignored;
    CHECK(MeetingAudioDropMailboxPush(queue, callback(0)));
    return NULL;
}
int main(void) {
    atomic_init(&stage, 0);
    atomic_init(&mode, 0);
    queue = MeetingAudioDropMailboxCreate();
    CHECK(queue != NULL);
    CHECK(MeetingAudioDropMailboxPush(queue, callback(0)));
    atomic_store_explicit(&mode, 1, memory_order_release);
    pthread_t thread;
    CHECK(pthread_create(&thread, NULL, consume, NULL) == 0);
    while (atomic_load_explicit(&stage, memory_order_acquire) != 1) { sched_yield(); }
    CHECK(MeetingAudioDropMailboxPush(queue, callback(1)));
    atomic_store_explicit(&stage, 2, memory_order_release);
    CHECK(pthread_join(thread, NULL) == 0);
    CHECK(status == 2); // Even a completed overlapping producer invalidates the snapshot.
    atomic_store_explicit(&mode, 0, memory_order_release);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 0, false, &output) == 1);
    CHECK(output.sampleTime == 0 && output.frameCount == 128);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 128, true, &output) == 1);
    CHECK(output.sampleTime == 128 && output.frameCount == 128);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 256, true, &output) == 0);
    MeetingAudioDropMailboxDestroy(queue);

    queue = MeetingAudioDropMailboxCreate();
    CHECK(queue != NULL);
    atomic_store_explicit(&stage, 0, memory_order_release);
    atomic_store_explicit(&mode, 2, memory_order_release);
    CHECK(pthread_create(&thread, NULL, produce, NULL) == 0);
    while (atomic_load_explicit(&stage, memory_order_acquire) != 1) { sched_yield(); }
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 0, false, &output) == 2);
    atomic_store_explicit(&stage, 2, memory_order_release);
    CHECK(pthread_join(thread, NULL) == 0);
    atomic_store_explicit(&mode, 0, memory_order_release);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 0, false, &output) == 1);
    CHECK(output.sampleTime == 0 && output.frameCount == 128);
    CHECK(MeetingAudioDropMailboxPopForClock(queue, 128, true, &output) == 0);
    MeetingAudioDropMailboxDestroy(queue);
    puts("Deterministic consumer ownership and in-flight producer checks passed.");
    return 0;
}
'''


def run(folder, name, source, negative=False, harness=HARNESS):
    c_file = folder / f"{name}.c"
    binary = folder / name
    c_file.write_text(source)
    (folder / "harness.c").write_text(harness)
    compiled = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-pedantic", "-pthread", "-fsanitize=undefined", "-I", str(SOURCE.parent),
        str(c_file), str(folder / "harness.c"), "-lm", "-o", str(binary)], capture_output=True, text=True, timeout=30)
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
        ("level-silence-publication", "    uint64_t milliseconds = hostNanoseconds / UINT64_C(1000000);",
         "    if (peak == 0) { return; }\n    uint64_t milliseconds = hostNanoseconds / UINT64_C(1000000);"),
        ("level-staleness", "if (now < captured || now - captured >= 500) { return 0; }",
         "if (now < captured) { return 0; }"),
        ("level-clock-rollback", "if (now < captured || now - captured >= 500) { return 0; }",
         "if (now >= captured && now - captured >= 500) { return 0; }"),
        ("level-captured-amplitude", "(milliseconds << 16) | magnitude",
         "(milliseconds << 16) | (magnitude > 0 ? UINT64_C(65535) : 0)"),
        ("unpublished-drop", "            atomic_store_explicit(&mailbox->slots[i].state, 2, memory_order_release);",
         "            atomic_store_explicit(&mailbox->slots[i].state, 0, memory_order_release);"),
        ("silent-capacity-overflow", "    return MeetingAudioDropFinishPush(mailbox, false);\n}\nbool MeetingAudioDropMailboxPop",
         "    return MeetingAudioDropFinishPush(mailbox, true);\n}\nbool MeetingAudioDropMailboxPop"),
        ("reversed-host-order", "left->record.hostTimeNanoseconds < right->record.hostTimeNanoseconds",
         "left->record.hostTimeNanoseconds > right->record.hostTimeNanoseconds"),
        ("sample-order-across-reset", "left->record.hostTimeNanoseconds < right->record.hostTimeNanoseconds",
         "left->record.sampleTime < right->record.sampleTime"),
        ("unstable-host-ties", "left->order < right->order", "left->order > right->order"),
        ("disabled-coalescing", "if (complete && latest != MEETING_AUDIO_DROP_CAPACITY &&",
         "if (!complete && latest != MEETING_AUDIO_DROP_CAPACITY &&"),
        ("coalesced-frame-loss", "slot->record.frameCount += record.frameCount;", "slot->record.frameCount = record.frameCount;"),
        ("mixed-drop-causes", "previous.cause != next.cause || previous.sampleRate != next.sampleRate ||",
         "previous.sampleRate != next.sampleRate ||"),
        ("mixed-sample-rates", "previous.cause != next.cause || previous.sampleRate != next.sampleRate ||",
         "previous.cause != next.cause ||"),
        ("merged-counter-reset", "previous.sampleTime + (double)previous.frameCount != next.sampleTime ||", ""),
        ("unbounded-host-jitter", "return difference <= tolerance;", "return difference <= tolerance || next.frameCount > 0;"),
        ("lost-largest-callback", "slot->record.maximumFrameCount = record.maximumFrameCount;",
         "slot->record.maximumFrameCount = slot->record.maximumFrameCount;"),
        ("widened-first-callback", "slot->record.maximumFrameCount = record.maximumFrameCount;",
         "slot->record.maximumFrameCount = record.maximumFrameCount; slot->record.firstFrameCount = record.maximumFrameCount;"),
        ("lost-measured-end", "slot->record.observedEndNanoseconds = record.observedEndNanoseconds;",
         "slot->record.observedEndNanoseconds = slot->record.observedEndNanoseconds;"),
        ("unbounded-coalesced-total", "#define MEETING_AUDIO_DROP_MAXIMUM_COALESCED_FRAMES 11520000",
         "#define MEETING_AUDIO_DROP_MAXIMUM_COALESCED_FRAMES UINT32_MAX"),
        ("unchecked-nominal-end", "previous.hostTimeNanoseconds > UINT64_MAX -\n            MeetingAudioDropDuration(previous.frameCount + next.frameCount, previous.sampleRate) - 1 ||", ""),
        ("accepted-malformed-record", "if (!MeetingAudioDropIsValid(record)) {",
         "if (!MeetingAudioDropIsValid(record) && record.frameCount == 0) {"),
        ("ignored-clock-successor", "if (!resetBeforeSuccessor) { selected = successor; }",
         "if (!resetBeforeSuccessor && !hasExpectedSampleTime) { selected = successor; }"),
        ("jumped-reset-frontier", "if (!resetBeforeSuccessor) { selected = successor; }",
         "if (!resetBeforeSuccessor || hasExpectedSampleTime) { selected = successor; }"),
        ("host-ordered-reset-frontier", "mailbox->slots[i].order < mailbox->slots[successor].order",
         "mailbox->slots[i].record.hostTimeNanoseconds < mailbox->slots[successor].record.hostTimeNanoseconds"),
    ]
    with tempfile.TemporaryDirectory(prefix="meeting-audio-c-") as directory:
        folder = Path(directory)
        run(folder, "positive", original)
        for name, before, after in mutations:
            if original.count(before) != 1:
                raise RuntimeError(f"{name}: mutation anchor changed")
            run(folder, name, original.replace(before, after, 1), negative=True)
        # Hooks exist only in a temporary compilation, never in the production callback.
        instrumented = "extern void MeetingAudioTestPause(unsigned kind);\n" + original
        instrumented = instrumented.replace("    record.observedEndNanoseconds = MeetingAudioDropEnd(record);",
            "    record.observedEndNanoseconds = MeetingAudioDropEnd(record);\n    MeetingAudioTestPause(2);", 1)
        prefix, consumer = instrumented.split("int MeetingAudioDropMailboxPopForClock(", 1)
        consumer = consumer.replace("            owned[i] = true;",
            "            owned[i] = true;\n            MeetingAudioTestPause(1);", 1)
        instrumented = prefix + "int MeetingAudioDropMailboxPopForClock(" + consumer
        run(folder, "exclusive-ownership", instrumented, harness=OWNERSHIP_HARNESS)
        ownership_mutations = [
            ("unowned-consumer-read",
             "atomic_compare_exchange_strong_explicit(&mailbox->slots[i].state, &expected, 3,\n                memory_order_acquire, memory_order_relaxed)",
             "(expected = atomic_load_explicit(&mailbox->slots[i].state, memory_order_acquire)) == 2"),
            ("completed-producer-overlap", "atomic_load_explicit(&mailbox->revision, memory_order_acquire) != revision",
             "atomic_load_explicit(&mailbox->revision, memory_order_acquire) < revision"),
            ("busy-is-not-empty", "if (atomic_load_explicit(&mailbox->producers, memory_order_acquire) != 0) { return 2; }",
             "if (atomic_load_explicit(&mailbox->producers, memory_order_acquire) != 0) { return 0; }"),
        ]
        for name, before, after in ownership_mutations:
            if instrumented.count(before) != 1:
                raise RuntimeError(f"{name}: mutation anchor changed")
            run(folder, name, instrumented.replace(before, after, 1), negative=True, harness=OWNERSHIP_HARNESS)
        run(folder, "restored", original)
    print("Portable C checks complete. Swift/XCTest, Apple SDK and hardware remain separate gates.")


if __name__ == "__main__":
    main()
