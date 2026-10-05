#ifndef MeetingAudioAtomic_h
#define MeetingAudioAtomic_h

#include <stdbool.h>
#include <stdint.h>

// Opaque storage keeps C11 atomics out of Swift's imported value representation.
typedef struct MeetingAudioAtomicWord MeetingAudioAtomicWord;
MeetingAudioAtomicWord *MeetingAudioAtomicCreate(uint32_t initialValue);
void MeetingAudioAtomicDestroy(MeetingAudioAtomicWord *word);
uint32_t MeetingAudioAtomicLoad(MeetingAudioAtomicWord *word);
uint32_t MeetingAudioAtomicOr(MeetingAudioAtomicWord *word, uint32_t bits);
uint32_t MeetingAudioAtomicExchange(MeetingAudioAtomicWord *word, uint32_t value);
bool MeetingAudioAtomicCompareExchange(MeetingAudioAtomicWord *word, uint32_t expected, uint32_t desired);

#endif
