import tempfile
import threading
import unittest
import uuid
from pathlib import Path

from lifecycle import Inventory, Unavailable, validate_reference


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='moss-inventory-test-')
        self.inventory = Inventory(self.directory.name)
        self.runtime = str(uuid.uuid4())
        self.effects = []

    def tearDown(self):
        self.directory.cleanup()

    def test_removed_runtime_cannot_be_recreated_after_restart(self):
        self.inventory.allocate(self.runtime, 1, lambda key: self.effects.append(key))
        self.inventory.remove(self.runtime, 2, lambda _: None)
        restarted = Inventory(self.directory.name)
        for generation in (1, 2, 3):
            with self.subTest(generation=generation), self.assertRaises(Unavailable):
                restarted.allocate(self.runtime, generation, lambda key: self.effects.append(key))
        self.assertEqual(self.effects, [self.runtime])
        self.assertEqual(restarted.get(self.runtime), (2, 'removed'))

    def test_remove_before_allocate_persists_tombstone(self):
        self.inventory.remove(self.runtime, 2, lambda _: None)
        with self.assertRaises(Unavailable):
            self.inventory.allocate(self.runtime, 1, lambda key: self.effects.append(key))
        self.assertEqual(self.effects, [])

    def test_failed_cleanup_blocks_allocation_and_can_be_retried(self):
        def broken(_):
            raise OSError('synthetic cleanup failure')
        with self.assertRaises(OSError):
            self.inventory.remove(self.runtime, 2, broken)
        self.assertEqual(self.inventory.get(self.runtime), (2, 'removing'))
        with self.assertRaises(Unavailable):
            self.inventory.allocate(self.runtime, 3, lambda _: None)
        self.inventory.remove(self.runtime, 2, lambda _: None)
        self.assertEqual(self.inventory.get(self.runtime), (2, 'removed'))

    def test_failed_allocation_retries_idempotently(self):
        def interrupted(_):
            raise OSError('synthetic allocation failure')
        with self.assertRaises(OSError):
            self.inventory.allocate(self.runtime, 1, interrupted)
        self.assertEqual(self.inventory.get(self.runtime), (1, 'allocating'))
        self.inventory.allocate(self.runtime, 1, lambda _: None)
        self.assertEqual(self.inventory.get(self.runtime), (1, 'ready'))
        with self.assertRaises(ValueError):
            self.inventory.remove(self.runtime, 0, lambda _: None)

    def test_stale_generation_cannot_remove_live_runtime(self):
        self.inventory.allocate(self.runtime, 3, lambda _: None)
        with self.assertRaises(Unavailable):
            self.inventory.remove(self.runtime, 2, lambda key: self.effects.append(key))
        self.assertEqual(self.effects, [])
        self.assertEqual(self.inventory.get(self.runtime), (3, 'ready'))

    def test_same_runtime_serializes_without_blocking_other_runtime(self):
        started, release = threading.Event(), threading.Event()
        errors = []
        def create(_):
            started.set()
            if not release.wait(5):
                raise TimeoutError()
        def allocate():
            try:
                self.inventory.allocate(self.runtime, 1, create)
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=allocate)
        thread.start()
        try:
            self.assertTrue(started.wait(5))
            with self.assertRaises(Unavailable):
                Inventory(self.directory.name).remove(self.runtime, 2, lambda _: None)
            other = str(uuid.uuid4())
            self.inventory.allocate(other, 1, lambda _: None)
            self.assertEqual(self.inventory.get(other), (1, 'ready'))
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.inventory.remove(self.runtime, 2, lambda _: None)
        with self.assertRaises(Unavailable):
            self.inventory.allocate(self.runtime, 1, lambda _: None)

    def test_paths_and_permissions(self):
        for key, generation in (('../outside', 1), (self.runtime.upper(), 1),
                                (self.runtime, True), (self.runtime, -1)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_reference(key, generation)
        unsafe = Path(self.directory.name) / 'unsafe'
        unsafe.mkdir(mode=0o755)
        with self.assertRaises(Unavailable):
            Inventory(unsafe)
        link = Path(self.directory.name) / 'linked'
        link.symlink_to(unsafe)
        with self.assertRaises(Unavailable):
            Inventory(link)


if __name__ == '__main__':
    unittest.main()
