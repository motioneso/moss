#include "MeetingAudioAtomic.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <math.h>

_Static_assert(sizeof(unsigned int) == sizeof(uint32_t), "Meeting audio atomic words must be 32 bits");
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Meeting audio callbacks require lock-free atomic words");

struct MeetingAudioAtomicWord { atomic_uint value; };

MeetingAudioAtomicWord *MeetingAudioAtomicCreate(uint32_t initialValue) {
    MeetingAudioAtomicWord *word = malloc(sizeof(*word));
    if (word) { atomic_init(&word->value, initialValue); }
    return word;
}

void MeetingAudioAtomicDestroy(MeetingAudioAtomicWord *word) { free(word); }
uint32_t MeetingAudioAtomicLoad(MeetingAudioAtomicWord *word) {
    return atomic_load_explicit(&word->value, memory_order_seq_cst);
}
uint32_t MeetingAudioAtomicOr(MeetingAudioAtomicWord *word, uint32_t bits) {
    return atomic_fetch_or_explicit(&word->value, bits, memory_order_seq_cst);
}
uint32_t MeetingAudioAtomicExchange(MeetingAudioAtomicWord *word, uint32_t value) {
    return atomic_exchange_explicit(&word->value, value, memory_order_seq_cst);
}
bool MeetingAudioAtomicCompareExchange(MeetingAudioAtomicWord *word, uint32_t expected, uint32_t desired) {
    return atomic_compare_exchange_strong_explicit(&word->value, &expected, desired,
        memory_order_seq_cst, memory_order_seq_cst);
}

_Static_assert(sizeof(unsigned long long) == sizeof(uint64_t), "Meeting lease deadlines must be 64 bits");
_Static_assert(ATOMIC_LLONG_LOCK_FREE == 2, "Meeting audio callbacks require lock-free lease deadlines");
struct MeetingAudioAtomicDeadline { atomic_ullong value; };
MeetingAudioAtomicDeadline *MeetingAudioDeadlineCreate(uint64_t initialValue) {
    MeetingAudioAtomicDeadline *deadline = malloc(sizeof(*deadline));
    if (deadline) { atomic_init(&deadline->value, initialValue); }
    return deadline;
}
void MeetingAudioDeadlineDestroy(MeetingAudioAtomicDeadline *deadline) { free(deadline); }
uint64_t MeetingAudioDeadlineLoad(MeetingAudioAtomicDeadline *deadline) {
    return atomic_load_explicit(&deadline->value, memory_order_seq_cst);
}
void MeetingAudioDeadlineStore(MeetingAudioAtomicDeadline *deadline, uint64_t value) {
    atomic_store_explicit(&deadline->value, value, memory_order_seq_cst);
}

#define MEETING_AUDIO_DROP_CAPACITY 64
#define MEETING_AUDIO_DROP_MAXIMUM_CALLBACK_FRAMES 8192
#define MEETING_AUDIO_DROP_MAXIMUM_COALESCED_FRAMES 11520000
struct MeetingAudioDropSlot {
    // 0 = available, 1 = producer-owned, 2 = published, 3 = consumer-owned.
    // Every non-atomic payload access requires exclusive ownership, including reads.
    atomic_uint state;
    MeetingAudioDropRecord record;
    uint64_t lastHostTimeNanoseconds;
    uint32_t lastFrameCount;
    uint64_t order;
    uint64_t lastOrder;
};
struct MeetingAudioDropMailbox {
    struct MeetingAudioDropSlot slots[MEETING_AUDIO_DROP_CAPACITY];
    atomic_uint accepted;
    atomic_uint rejected;
    atomic_ullong nextOrder;
    atomic_uint producers;
    atomic_ullong revision;
};

MeetingAudioDropMailbox *MeetingAudioDropMailboxCreate(void) {
    MeetingAudioDropMailbox *mailbox = calloc(1, sizeof(*mailbox));
    if (mailbox) {
        atomic_init(&mailbox->accepted, 0);
        atomic_init(&mailbox->rejected, 0);
        atomic_init(&mailbox->nextOrder, 0);
        atomic_init(&mailbox->producers, 0);
        atomic_init(&mailbox->revision, 0);
        for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
            atomic_init(&mailbox->slots[i].state, 0);
        }
    }
    return mailbox;
}
void MeetingAudioDropMailboxDestroy(MeetingAudioDropMailbox *mailbox) { free(mailbox); }

static uint64_t MeetingAudioDropDuration(uint32_t frames, double sampleRate) {
    // Validated integral rates and UInt32 frames keep this multiplication representable.
    return (uint64_t)frames * UINT64_C(1000000000) / (uint64_t)sampleRate;
}

static uint64_t MeetingAudioDropEnd(MeetingAudioDropRecord record) {
    uint64_t rate = (uint64_t)record.sampleRate;
    return record.hostTimeNanoseconds + ((uint64_t)record.frameCount * UINT64_C(1000000000) + rate - 1) / rate;
}

static bool MeetingAudioDropIsValid(MeetingAudioDropRecord record) {
    return isfinite(record.sampleTime) && trunc(record.sampleTime) == record.sampleTime &&
        fabs(record.sampleTime) <= 9007199254732800.0 &&
        isfinite(record.sampleRate) && record.sampleRate >= 8000 && record.sampleRate <= 192000 &&
        trunc(record.sampleRate) == record.sampleRate &&
        record.frameCount > 0 && record.frameCount <= MEETING_AUDIO_DROP_MAXIMUM_CALLBACK_FRAMES &&
        record.maximumFrameCount == record.frameCount && record.firstFrameCount == record.frameCount && record.cause <= 1 &&
        record.hostTimeNanoseconds <= UINT64_MAX - MeetingAudioDropDuration(record.frameCount, record.sampleRate) - 1;
}

static bool MeetingAudioDropCanAppend(const struct MeetingAudioDropSlot *slot, MeetingAudioDropRecord next) {
    const MeetingAudioDropRecord previous = slot->record;
    if (previous.cause != next.cause || previous.sampleRate != next.sampleRate ||
        previous.sampleTime + (double)previous.frameCount != next.sampleTime ||
        previous.frameCount > UINT32_MAX - next.frameCount ||
        previous.frameCount + next.frameCount > MEETING_AUDIO_DROP_MAXIMUM_COALESCED_FRAMES ||
        previous.hostTimeNanoseconds > UINT64_MAX -
            MeetingAudioDropDuration(previous.frameCount + next.frameCount, previous.sampleRate) - 1 ||
        next.hostTimeNanoseconds <= slot->lastHostTimeNanoseconds) { return false; }

    uint64_t duration = MeetingAudioDropDuration(previous.frameCount, previous.sampleRate);
    uint64_t expected = previous.hostTimeNanoseconds + duration;
    uint64_t difference = next.hostTimeNanoseconds > expected ?
        next.hostTimeNanoseconds - expected : expected - next.hostTimeNanoseconds;
    // Bound cumulative jitter, rather than allowing per-callback drift to accumulate.
    // Hardware clock skew can move a measured start slightly before or after its
    // nominal end. Exact sample continuity keeps the represented intervals disjoint.
    uint64_t callbackDuration = MeetingAudioDropDuration(slot->lastFrameCount, previous.sampleRate);
    uint64_t tolerance = callbackDuration;
    if (tolerance > UINT64_C(20000000)) { tolerance = UINT64_C(20000000); }
    return difference <= tolerance;
}

static void MeetingAudioDropRelease(MeetingAudioDropMailbox *mailbox, const bool *owned) {
    for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
        if (owned[i]) { atomic_store_explicit(&mailbox->slots[i].state, 2, memory_order_release); }
    }
}

static bool MeetingAudioDropFinishPush(MeetingAudioDropMailbox *mailbox, bool accepted) {
    atomic_fetch_add_explicit(accepted ? &mailbox->accepted : &mailbox->rejected, 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&mailbox->revision, 1, memory_order_release);
    atomic_fetch_sub_explicit(&mailbox->producers, 1, memory_order_release);
    return accepted;
}

bool MeetingAudioDropMailboxPush(MeetingAudioDropMailbox *mailbox, MeetingAudioDropRecord record) {
    atomic_fetch_add_explicit(&mailbox->producers, 1, memory_order_acq_rel);
    atomic_fetch_add_explicit(&mailbox->revision, 1, memory_order_release);
    uint64_t order = atomic_fetch_add_explicit(&mailbox->nextOrder, 1, memory_order_relaxed);
    if (record.maximumFrameCount == 0) { record.maximumFrameCount = record.frameCount; }
    if (record.firstFrameCount == 0) { record.firstFrameCount = record.frameCount; }
    if (!MeetingAudioDropIsValid(record)) {
        return MeetingAudioDropFinishPush(mailbox, false);
    }
    record.observedEndNanoseconds = MeetingAudioDropEnd(record);

    // One bounded try per slot. An active producer/consumer prevents coalescing in
    // this pass; we can still publish separately into an available slot. Never wait.
    bool owned[MEETING_AUDIO_DROP_CAPACITY] = { false };
    bool complete = true;
    unsigned latest = MEETING_AUDIO_DROP_CAPACITY;
    for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
        unsigned expected = 2;
        if (atomic_compare_exchange_strong_explicit(&mailbox->slots[i].state, &expected, 1,
                memory_order_acquire, memory_order_relaxed)) {
            owned[i] = true;
            if (latest == MEETING_AUDIO_DROP_CAPACITY ||
                mailbox->slots[i].lastOrder > mailbox->slots[latest].lastOrder) { latest = i; }
        } else if (expected != 0) { complete = false; }
    }
    if (complete && latest != MEETING_AUDIO_DROP_CAPACITY &&
        mailbox->slots[latest].lastOrder == order - 1 &&
        MeetingAudioDropCanAppend(&mailbox->slots[latest], record)) {
        struct MeetingAudioDropSlot *slot = &mailbox->slots[latest];
        slot->record.frameCount += record.frameCount;
        if (record.maximumFrameCount > slot->record.maximumFrameCount) {
            slot->record.maximumFrameCount = record.maximumFrameCount;
        }
        slot->lastHostTimeNanoseconds = record.hostTimeNanoseconds;
        slot->lastFrameCount = record.frameCount;
        slot->lastOrder = order;
        if (record.observedEndNanoseconds > slot->record.observedEndNanoseconds) {
            slot->record.observedEndNanoseconds = record.observedEndNanoseconds;
        }
        MeetingAudioDropRelease(mailbox, owned);
        return MeetingAudioDropFinishPush(mailbox, true);
    }
    MeetingAudioDropRelease(mailbox, owned);
    for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
        unsigned expected = 0;
        if (atomic_compare_exchange_strong_explicit(&mailbox->slots[i].state, &expected, 1,
                memory_order_acquire, memory_order_relaxed)) {
            mailbox->slots[i].record = record;
            mailbox->slots[i].lastHostTimeNanoseconds = record.hostTimeNanoseconds;
            mailbox->slots[i].lastFrameCount = record.frameCount;
            mailbox->slots[i].order = order;
            mailbox->slots[i].lastOrder = order;
            atomic_store_explicit(&mailbox->slots[i].state, 2, memory_order_release);
            return MeetingAudioDropFinishPush(mailbox, true);
        }
    }
    return MeetingAudioDropFinishPush(mailbox, false);
}
bool MeetingAudioDropMailboxPop(MeetingAudioDropMailbox *mailbox, MeetingAudioDropRecord *record) {
    return MeetingAudioDropMailboxPopForClock(mailbox, 0, false, record) == 1;
}

static bool MeetingAudioDropBefore(const struct MeetingAudioDropSlot *left, const struct MeetingAudioDropSlot *right) {
    return left->record.hostTimeNanoseconds < right->record.hostTimeNanoseconds ||
        (left->record.hostTimeNanoseconds == right->record.hostTimeNanoseconds && left->order < right->order);
}

int MeetingAudioDropMailboxPopForClock(MeetingAudioDropMailbox *mailbox, double expectedSampleTime,
    bool hasExpectedSampleTime, MeetingAudioDropRecord *record) {
    // Sample counters may reset. Compare measured host times, with stable reservation
    // order for ties, and own every payload read so an append cannot race a snapshot.
    bool owned[MEETING_AUDIO_DROP_CAPACITY] = { false };
    bool complete = true;
    uint64_t revision = atomic_load_explicit(&mailbox->revision, memory_order_acquire);
    if (atomic_load_explicit(&mailbox->producers, memory_order_acquire) != 0) { return 2; }
    unsigned selected = MEETING_AUDIO_DROP_CAPACITY;
    unsigned successor = MEETING_AUDIO_DROP_CAPACITY;
    for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
        unsigned expected = 2;
        if (atomic_compare_exchange_strong_explicit(&mailbox->slots[i].state, &expected, 3,
                memory_order_acquire, memory_order_relaxed)) {
            owned[i] = true;
            if (selected == MEETING_AUDIO_DROP_CAPACITY ||
                MeetingAudioDropBefore(&mailbox->slots[i], &mailbox->slots[selected])) { selected = i; }
            if (hasExpectedSampleTime && mailbox->slots[i].record.sampleTime == expectedSampleTime &&
                (successor == MEETING_AUDIO_DROP_CAPACITY ||
                 MeetingAudioDropBefore(&mailbox->slots[i], &mailbox->slots[successor]))) { successor = i; }
        } else if (expected != 0) { complete = false; }
    }
    if (!complete || atomic_load_explicit(&mailbox->revision, memory_order_acquire) != revision ||
        atomic_load_explicit(&mailbox->producers, memory_order_acquire) != 0) {
        MeetingAudioDropRelease(mailbox, owned);
        return 2;
    }
    if (selected == MEETING_AUDIO_DROP_CAPACITY) { return 0; }
    if (successor != MEETING_AUDIO_DROP_CAPACITY) {
        // Host jitter may reverse adjacent callbacks in an established clock segment.
        // Never jump to an apparent successor across an earlier reset frontier.
        bool resetBeforeSuccessor = false;
        for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
            if (owned[i] && mailbox->slots[i].record.sampleTime < expectedSampleTime &&
                mailbox->slots[i].order < mailbox->slots[successor].order) {
                resetBeforeSuccessor = true;
            }
        }
        if (!resetBeforeSuccessor) { selected = successor; }
    }
    *record = mailbox->slots[selected].record;
    owned[selected] = false;
    atomic_store_explicit(&mailbox->slots[selected].state, 0, memory_order_release);
    MeetingAudioDropRelease(mailbox, owned);
    return 1;
}

MeetingAudioDropCounts MeetingAudioDropMailboxReadCounts(MeetingAudioDropMailbox *mailbox) {
    // Diagnostic counters only, never admission authority. The two-hour session bound
    // keeps callback counts far below uint32_t; snapshots may race an active producer.
    return (MeetingAudioDropCounts) {
        .accepted = atomic_load_explicit(&mailbox->accepted, memory_order_relaxed),
        .rejected = atomic_load_explicit(&mailbox->rejected, memory_order_relaxed)
    };
}

// The lock-free 64-bit width/ATOMIC_LLONG_LOCK_FREE assertions above apply here too.
struct MeetingAudioLevel { atomic_ullong packed; };
MeetingAudioLevel *MeetingAudioLevelCreate(void) {
    MeetingAudioLevel *level = malloc(sizeof(*level));
    if (level) { atomic_init(&level->packed, 0); }
    return level;
}
void MeetingAudioLevelDestroy(MeetingAudioLevel *level) { free(level); }
void MeetingAudioLevelStore(MeetingAudioLevel *level, float peak, uint64_t hostNanoseconds) {
    uint64_t milliseconds = hostNanoseconds / UINT64_C(1000000);
    // NaN/nonpositive inputs, over-range clocks and silence must never invent motion.
    uint64_t magnitude = isfinite(peak) && peak > 0 ? (uint64_t)((peak < 1 ? peak : 1) * 65535) : 0;
    uint64_t packed = milliseconds <= (UINT64_MAX >> 16) ? (milliseconds << 16) | magnitude : 0;
    atomic_store_explicit(&level->packed, packed, memory_order_release);
}
float MeetingAudioLevelRead(MeetingAudioLevel *level, uint64_t nowNanoseconds) {
    uint64_t packed = atomic_load_explicit(&level->packed, memory_order_acquire);
    uint64_t captured = packed >> 16;
    uint64_t now = nowNanoseconds / UINT64_C(1000000);
    if (now < captured || now - captured >= 500) { return 0; }
    return (float)(packed & UINT64_C(65535)) / 65535;
}
