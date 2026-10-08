#include "MeetingProcessInventory.h"
#include <libproc.h>
#include <sys/proc_info.h>
#include <string.h>
#include <limits.h>

int MMListProcesses(int32_t *pids, size_t capacity) {
    if (!pids || capacity > INT_MAX / sizeof(int32_t)) return -1;
    int count = proc_listallpids(pids, (int)(capacity * sizeof(int32_t)));
    return count > 0 && (size_t)count < capacity ? count : -1;
}

int MMReadProcess(int32_t pid, MMProcessIdentity *result) {
    if (pid <= 0 || !result) return 0;
    struct proc_bsdinfo info;
    memset(&info, 0, sizeof(info));
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
    memset(result, 0, sizeof(*result));
    if (proc_pidpath(pid, result->executable, sizeof(result->executable)) <= 0) return 0;
    result->pid = pid;
    result->parent_pid = (int32_t)info.pbi_ppid;
    result->start_seconds = info.pbi_start_tvsec;
    result->start_microseconds = info.pbi_start_tvusec;
    return 1;
}

int MMReadProcessPath(int32_t pid, char *path, size_t capacity) {
    if (pid <= 0 || !path || capacity < PROC_PIDPATHINFO_MAXSIZE || capacity > INT_MAX) return 0;
    memset(path, 0, capacity);
    int length = proc_pidpath(pid, path, (uint32_t)capacity);
    return length > 0 && (size_t)length < capacity && path[0] == '/' &&
        memchr(path, '\0', capacity) != NULL;
}
