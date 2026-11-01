import unittest

from chromium_seccomp import chromium_policy


class ChromiumSeccomp(unittest.TestCase):
    def test_only_chroot_changes_and_source_is_unchanged(self):
        source = {'defaultAction': 'SCMP_ACT_ERRNO', 'architectures': ['SCMP_ARCH_X86_64'],
                  'syscalls': [
                      {'names': ['read', 'chroot'], 'action': 'SCMP_ACT_ALLOW',
                       'includes': {'caps': ['CAP_SYS_CHROOT']}},
                      {'names': ['chroot'], 'action': 'SCMP_ACT_ERRNO', 'errnoRet': 1},
                      {'names': ['write'], 'action': 'SCMP_ACT_ALLOW'}]}
        result = chromium_policy(source)
        self.assertEqual(result['syscalls'], [
            {'names': ['read'], 'action': 'SCMP_ACT_ALLOW',
             'includes': {'caps': ['CAP_SYS_CHROOT']}},
            {'names': ['write'], 'action': 'SCMP_ACT_ALLOW'},
            {'names': ['chroot'], 'action': 'SCMP_ACT_ALLOW', 'args': []}])
        self.assertEqual(source['syscalls'][0]['names'], ['read', 'chroot'])
        self.assertEqual(result['architectures'], source['architectures'])

    def test_permissive_source_is_rejected(self):
        with self.assertRaises(ValueError):
            chromium_policy({'defaultAction': 'SCMP_ACT_ALLOW', 'syscalls': []})
