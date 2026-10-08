#ifndef MeetingProcessInventory_h
#define MeetingProcessInventory_h
#include <stdint.h>
#include <stddef.h>

typedef struct {
    int32_t pid;
    int32_t parent_pid;
    uint64_t start_seconds;
    uint64_t start_microseconds;
    char executable[4096];
} MMProcessIdentity;

/* Read-only process metadata. No audio resources, permissions, or process mutation. */
int MMListProcesses(int32_t *pids, size_t capacity);
int MMReadProcess(int32_t pid, MMProcessIdentity *result);
#endif
