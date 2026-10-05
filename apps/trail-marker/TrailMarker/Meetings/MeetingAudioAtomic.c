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
