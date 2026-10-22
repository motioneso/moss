import json
import os
import tempfile
import unittest
from pathlib import Path

from lifecycle import Unavailable
from service import configuration


class TrustedConfiguration(unittest.TestCase):
    def test_config_requires_trusted_file_absolute_paths_and_network_policy(self):
        with tempfile.TemporaryDirectory(prefix='moss-config-test-') as directory:
            root = Path(directory)
            config = {'state': str(root / 'state'), 'transport': str(root / 'transport'),
                      'socket': str(root / 'socket'), 'seccomp': str(root / 'seccomp'),
                      'allowed_uid': os.getuid(), 'socket_gid': os.getgid(),
                      'image': 'sha256:' + 'a' * 64, 'denied_networks': ['192.0.2.0/24']}
            path = root / 'config.json'
            path.write_text(json.dumps(config))
            path.chmod(0o600)
            self.assertEqual(configuration(path), config)
            path.chmod(0o666)
            with self.assertRaises(Unavailable):
                configuration(path)
            path.chmod(0o600)
            for change in ({'socket': 'relative'}, {'denied_networks': []},
                           {'denied_networks': ['invalid']}, {'allowed_uid': True},
                           {'arbitrary': 'command'}):
                path.write_text(json.dumps({**config, **change}))
                with self.assertRaises(ValueError):
                    configuration(path)
            link = root / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                configuration(link)


if __name__ == '__main__':
    unittest.main()
