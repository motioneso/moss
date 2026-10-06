#include "MeetingAudioAtomic.h"
#include <stdatomic.h>
#include <stdlib.h>

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
struct MeetingAudioDropSlot {
    // 0 = available, 1 = being written, 2 = published. Only the consumer releases a slot.
    atomic_uint state;
    MeetingAudioDropRecord record;
};
struct MeetingAudioDropMailbox {
    struct MeetingAudioDropSlot slots[MEETING_AUDIO_DROP_CAPACITY];
    atomic_uint accepted;
    atomic_uint rejected;
};

MeetingAudioDropMailbox *MeetingAudioDropMailboxCreate(void) {
    MeetingAudioDropMailbox *mailbox = calloc(1, sizeof(*mailbox));
    if (mailbox) {
        atomic_init(&mailbox->accepted, 0);
        atomic_init(&mailbox->rejected, 0);
        for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
            atomic_init(&mailbox->slots[i].state, 0);
        }
    }
    return mailbox;
}
void MeetingAudioDropMailboxDestroy(MeetingAudioDropMailbox *mailbox) { free(mailbox); }
bool MeetingAudioDropMailboxPush(MeetingAudioDropMailbox *mailbox, MeetingAudioDropRecord record) {
    for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
        unsigned expected = 0;
        if (atomic_compare_exchange_strong_explicit(&mailbox->slots[i].state, &expected, 1,
                memory_order_acquire, memory_order_relaxed)) {
            mailbox->slots[i].record = record;
            atomic_store_explicit(&mailbox->slots[i].state, 2, memory_order_release);
            atomic_fetch_add_explicit(&mailbox->accepted, 1, memory_order_relaxed);
            return true;
        }
    }
    atomic_fetch_add_explicit(&mailbox->rejected, 1, memory_order_relaxed);
    return false;
}
bool MeetingAudioDropMailboxPop(MeetingAudioDropMailbox *mailbox, MeetingAudioDropRecord *record) {
    // A single consumer selects sample order, independent of which producer reserved first.
    unsigned selected = MEETING_AUDIO_DROP_CAPACITY;
    for (unsigned i = 0; i < MEETING_AUDIO_DROP_CAPACITY; ++i) {
        if (atomic_load_explicit(&mailbox->slots[i].state, memory_order_acquire) == 2 &&
            (selected == MEETING_AUDIO_DROP_CAPACITY ||
             mailbox->slots[i].record.sampleTime < mailbox->slots[selected].record.sampleTime)) {
            selected = i;
        }
    }
    if (selected == MEETING_AUDIO_DROP_CAPACITY) { return false; }
    *record = mailbox->slots[selected].record;
    atomic_store_explicit(&mailbox->slots[selected].state, 0, memory_order_release);
    return true;
}

MeetingAudioDropCounts MeetingAudioDropMailboxReadCounts(MeetingAudioDropMailbox *mailbox) {
    // Diagnostic counters only, never admission authority. The two-hour session bound
    // keeps callback counts far below uint32_t; snapshots may race an active producer.
    return (MeetingAudioDropCounts) {
        .accepted = atomic_load_explicit(&mailbox->accepted, memory_order_relaxed),
        .rejected = atomic_load_explicit(&mailbox->rejected, memory_order_relaxed)
    };
}
