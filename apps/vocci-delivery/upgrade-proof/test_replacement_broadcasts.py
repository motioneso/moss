"""Regression fixtures model dumpsys structure, without private device data."""
import unittest

from replacement_broadcasts import replacement_records, receiver_delivered

PACKAGE = "example.proof"
RECEIVER = "example.Recovery"
ACTION = "android.intent.action.MY_PACKAGE_REPLACED"


def record(token="target", status="DELIVERED", package=PACKAGE, receiver=RECEIVER, action=ACTION):
    return f"""    BroadcastRecord{{{token} {action}/u0/0x2081}} to user 0
      Intent {{ act={action} flg=0x4000010 pkg={package} (has extras) }}
      {status} scheduled 0 terminal +2ms (-1) #0: / (manifest)
        ActivityInfo:
          name={receiver}
          packageName={package}
          enabled=true exported=false
"""


SUMMARY = f"""    Historical broadcasts summary:
    #0: act={ACTION} pkg={PACKAGE} (has extras)
"""


class ReplacementBroadcastTests(unittest.TestCase):
    def delivered(self, dump):
        return any(receiver_delivered(block, PACKAGE, RECEIVER)
                   for block in replacement_records(dump, PACKAGE).values())

    def test_exact_delivered_receiver(self):
        self.assertTrue(self.delivered(record()))

    def test_summary_is_not_a_target_record(self):
        other = record("other", package="other.app", receiver="other.Receiver", action="other.ACTION")
        self.assertEqual(replacement_records(other + SUMMARY, PACKAGE), {})

    def test_unrelated_delivery_cannot_satisfy_pending_or_skipped_target(self):
        for state in ["PENDING", "SKIPPED"]:
            with self.subTest(state=state):
                other = record("other", package="other.app", receiver="other.Receiver", action="other.ACTION")
                dump = record(status=state) + other + SUMMARY
                self.assertFalse(self.delivered(dump))

    def test_another_receiver_in_target_record_is_not_delivery(self):
        dump = record(receiver="example.Other") + f"""      PENDING (-1) #1: / (manifest)
        ActivityInfo:
          name={RECEIVER}
          packageName={PACKAGE}
"""
        self.assertFalse(self.delivered(dump))

    def test_action_and_package_are_exact(self):
        for dump in [record(package=PACKAGE + ".other"), record(action="other.ACTION")]:
            with self.subTest(dump=dump):
                self.assertEqual(replacement_records(dump, PACKAGE), {})

    def test_receiver_name_is_exact(self):
        self.assertFalse(self.delivered(record(receiver=RECEIVER + "Other")))

    def test_pending_then_delivered_same_token_keeps_current_record(self):
        before = replacement_records(record(status="PENDING"), PACKAGE)
        after = replacement_records(record(), PACKAGE)
        self.assertEqual(set(before), set(after))
        self.assertTrue(receiver_delivered(after["target"], PACKAGE, RECEIVER))


if __name__ == "__main__":
    unittest.main()
