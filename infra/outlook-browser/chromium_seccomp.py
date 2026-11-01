"""Derive a Chromium-compatible policy without dropping unrelated syscall rules.

The trusted installer supplies the host's reviewed default policy. Chromium's
nested namespace sandbox needs chroot after gaining that capability in its own
namespace. No capability is added to the outer container. Native proof remains
required for every supported host/image architecture.
"""
import copy
import json
import sys


def chromium_policy(default):
    if default.get('defaultAction') != 'SCMP_ACT_ERRNO':
        raise ValueError('Expected a deny-by-default seccomp policy')
    policy = copy.deepcopy(default)
    rules = []
    for rule in policy['syscalls']:
        rule['names'] = [name for name in rule['names'] if name != 'chroot']
        if rule['names']:
            rules.append(rule)
    rules.append({'names': ['chroot'], 'action': 'SCMP_ACT_ALLOW', 'args': []})
    policy['syscalls'] = rules
    return policy


if __name__ == '__main__':
    json.dump(chromium_policy(json.load(sys.stdin)), sys.stdout)
