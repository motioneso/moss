import signal
import subprocess
import unittest
from unittest.mock import Mock, call, patch

from engine_command import run


class EngineTimeout(unittest.TestCase):
    def test_timeout_stops_broker_and_drains_engine_before_releasing_lock(self):
        process = Mock()
        process.wait.side_effect = [subprocess.TimeoutExpired('fixture', 30), 0]
        with (patch('engine_command.os.fstat'),
              patch('engine_command.os.getppid', return_value=123),
              patch('engine_command.os.pidfd_open', return_value=42),
              patch('engine_command.os.close') as close,
              patch('engine_command.signal.pidfd_send_signal') as stop,
              patch('engine_command.subprocess.Popen', return_value=process) as start):
            self.assertEqual(run(123, 7, ['info']), 70)
            stop.assert_called_once_with(42, signal.SIGTERM)
            self.assertEqual(process.wait.call_args_list, [call(timeout=30), call()])
            process.kill.assert_not_called()
            close.assert_called_once_with(42)
            self.assertTrue(start.call_args.kwargs['close_fds'])

    def test_orphan_timeout_cannot_signal_reaper_or_reused_parent_pid(self):
        process = Mock()
        process.wait.side_effect = [subprocess.TimeoutExpired('fixture', 30), 0]
        with (patch('engine_command.os.fstat'),
              patch('engine_command.os.getppid', return_value=1),
              patch('engine_command.os.pidfd_open') as bind,
              patch('engine_command.signal.pidfd_send_signal') as stop,
              patch('engine_command.subprocess.Popen', return_value=process)):
            self.assertEqual(run(123, 7, ['info']), 70)
            bind.assert_not_called()
            stop.assert_not_called()
            self.assertEqual(process.wait.call_args_list, [call(timeout=30), call()])

    def test_parent_dying_during_pidfd_open_cannot_bind_reused_pid(self):
        process = Mock()
        process.wait.side_effect = [subprocess.TimeoutExpired('fixture', 30), 0]
        with (patch('engine_command.os.fstat'),
              patch('engine_command.os.getppid', side_effect=[123, 1]),
              patch('engine_command.os.pidfd_open', return_value=42),
              patch('engine_command.os.close') as close,
              patch('engine_command.signal.pidfd_send_signal') as stop,
              patch('engine_command.subprocess.Popen', return_value=process)):
            self.assertEqual(run(123, 7, ['info']), 70)
            stop.assert_not_called()
            close.assert_called_once_with(42)


if __name__ == '__main__':
    unittest.main()
