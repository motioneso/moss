/*
 * moss_nodump: loaded through shared_preload_libraries, so it runs once in the postmaster
 * before any other server process exists. Every server process is forked from the
 * postmaster and inherits the setting.
 *
 * Linux: marks the server non-dumpable. The kernel then writes no core dump and calls no
 * crash handler for it, even when kernel.core_pattern pipes dumps to a program (apport,
 * systemd-coredump), which ignores the zero RLIMIT_CORE the supervisor also sets. It also
 * stops other processes of the same user from reading server memory through /proc.
 *
 * Other systems: nothing to do. The kernel honours the zero core limit.
 */
#include "postgres.h"

#include "fmgr.h"

#ifdef __linux__
#include <sys/prctl.h>
#endif

PG_MODULE_MAGIC;

void		_PG_init(void);

void
_PG_init(void)
{
#ifdef __linux__
	if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0)
		ereport(FATAL,
				(errmsg("moss_nodump: could not turn off crash dumps: %m")));
#endif
}
