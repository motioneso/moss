"""Cleanup policy tests; native runner runs the actual OS commands separately."""
import subprocess
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import phase7_sharing_firewall as gate


class CleanupOwnership(unittest.TestCase):
    def test_ufw_never_deletes_a_foreign_comment_or_an_unreadable_listing(self):
        for text in [
            "lookup failed",
            "Added user rules\nufw allow 5198/tcp comment 'mine-foreign'\n",
            "Added user rules\nufw allow 5198/tcp comment 'mine'\nufw allow 5198/tcp comment 'foreign'\n",
        ]:
            with self.subTest(text=text), patch.object(gate, 'sudo') as command:
                command.return_value = subprocess.CompletedProcess([], 0, text, '')
                with self.assertRaises(AssertionError):
                    gate.remove_ufw_plant(5198, 'mine')
                self.assertEqual(command.call_count, 1)

    def test_ufw_deletes_only_after_an_exact_marker_and_port(self):
        with patch.object(gate, 'sudo') as command:
            command.return_value = subprocess.CompletedProcess(
                [], 0, "Added user rules\nufw allow 5198/tcp comment 'mine'\n", '')
            gate.remove_ufw_plant(5198, 'mine')
            self.assertEqual(command.call_count, 2)
            self.assertEqual(command.call_args.args[0][-1], '5198')

    def test_windows_errors_duplicates_and_wrong_fields_never_delete(self):
        good = 'Rule Name: moss-test\nDescription: marker\nLocalPort: 5198\nProgram: C:\\moss-server.exe\n'
        cases = [(2, good), (1, 'lookup failed'), (0, good + good),
                 (0, good.replace('5198', '15198')), (0, good.replace('marker', 'marker-foreign'))]
        for code, text in cases:
            with self.subTest(code=code, text=text), patch.object(gate, 'run') as command:
                command.return_value = subprocess.CompletedProcess([], code, text, '')
                with self.assertRaises(AssertionError):
                    gate.remove_windows_plant('moss-test', 'marker', 5198, r'C:\moss-server.exe')
                self.assertEqual(command.call_count, 1)

    def test_windows_scopes_its_verified_delete(self):
        good = 'Rule Name: moss-test\nDescription: marker\nLocalPort: 5198\nProgram: C:\\moss-server.exe\n'
        with patch.object(gate, 'run') as command:
            command.return_value = subprocess.CompletedProcess([], 0, good, '')
            gate.remove_windows_plant('moss-test', 'marker', 5198, r'C:\moss-server.exe')
            args = command.call_args.args[0]
            self.assertIn('name=moss-test', args)
            self.assertIn('localport=5198', args)
            self.assertIn(r'program=C:\moss-server.exe', args)

    def test_bad_record_is_an_error_and_saved_record_can_clean_the_negative_control(self):
        with tempfile.TemporaryDirectory() as scratch:
            folder = Path(scratch)
            world = gate.World(folder, folder / 'sharing_probe.exe', 5198)
            path = folder / 'firewall.json'
            path.write_text('broken')
            with self.assertRaises(json.JSONDecodeError):
                world.moss_record()
            path.unlink()
            self.assertIsNone(world.moss_record())
            world.cleanup_record = {'rule': {'name': 'moss-test', 'token': 'token',
                                            'port': 5198, 'program': 'probe.exe'}}
            with patch.object(gate, 'SYSTEM', 'Windows'), patch.object(gate, 'remove_windows_plant') as remove:
                world.cleanup_moss_rule()
                remove.assert_called_once_with('moss-test', 'token', 5198, 'probe.exe')

    def test_mac_listing_is_exact_and_failed_output_is_not_absence(self):
        with patch.object(gate, 'sudo') as command:
            command.return_value = subprocess.CompletedProcess([], 0, 'failed', '')
            with self.assertRaises(AssertionError):
                gate.mac_apps()
            command.return_value = subprocess.CompletedProcess(
                [], 0, 'ALF: total number of apps = 1\n1 : /moss-server.foreign\n', '')
            self.assertNotIn('/moss-server', gate.mac_apps())


if __name__ == '__main__':
    unittest.main()
