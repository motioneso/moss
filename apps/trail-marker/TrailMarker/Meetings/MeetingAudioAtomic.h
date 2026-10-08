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

// A monotonic capture lease read by callbacks even when the control thread is delayed.
typedef struct MeetingAudioAtomicDeadline MeetingAudioAtomicDeadline;
MeetingAudioAtomicDeadline *MeetingAudioDeadlineCreate(uint64_t initialValue);
void MeetingAudioDeadlineDestroy(MeetingAudioAtomicDeadline *deadline);
uint64_t MeetingAudioDeadlineLoad(MeetingAudioAtomicDeadline *deadline);
void MeetingAudioDeadlineStore(MeetingAudioAtomicDeadline *deadline, uint64_t value);

// Fixed, bounded mailbox for dropped callbacks. Producers never allocate or wait.
// One serialized consumer may pop records; false on push means telemetry capacity is exhausted.
typedef struct MeetingAudioDropMailbox MeetingAudioDropMailbox;
typedef struct MeetingAudioDropRecord {
    double sampleTime;
    uint64_t hostTimeNanoseconds;
    double sampleRate;
    uint32_t frameCount;
} MeetingAudioDropRecord;
typedef struct MeetingAudioDropCounts {
    uint32_t accepted;
    uint32_t rejected;
} MeetingAudioDropCounts;
MeetingAudioDropMailbox *MeetingAudioDropMailboxCreate(void);
void MeetingAudioDropMailboxDestroy(MeetingAudioDropMailbox *mailbox);
bool MeetingAudioDropMailboxPush(MeetingAudioDropMailbox *mailbox, MeetingAudioDropRecord record);
bool MeetingAudioDropMailboxPop(MeetingAudioDropMailbox *mailbox, MeetingAudioDropRecord *record);
MeetingAudioDropCounts MeetingAudioDropMailboxReadCounts(MeetingAudioDropMailbox *mailbox);

// Local display telemetry only. A single packed atomic gives the UI a coherent timestamp
// and quantized captured peak without locks, allocations, sample retention or callback tasks.
// Never serialize this value or put it in diagnostics.
typedef struct MeetingAudioLevel MeetingAudioLevel;
MeetingAudioLevel *MeetingAudioLevelCreate(void);
void MeetingAudioLevelDestroy(MeetingAudioLevel *level);
void MeetingAudioLevelStore(MeetingAudioLevel *level, float peak, uint64_t hostNanoseconds);
float MeetingAudioLevelRead(MeetingAudioLevel *level, uint64_t nowNanoseconds);

#endif
