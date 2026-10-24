"""API 37 structure with generated identities; altered states are synthetic controls."""
import unittest

from device_observations import bluetooth_state, live_foreground_service

PACKAGE = "example.companion"
SERVICE = PACKAGE + ".DeliveryService"


def adapter(state):
    return f"Bluetooth Status:\n  State:         {state}\n  Name:          Example\n\nEnable log:\n"


def service(component=".DeliveryService", pid="123", foreground="true", package=PACKAGE):
    process = f"ProcessRecord{{token {pid}:{package}/u0a123}}" if pid else "null"
    return f"""  * ServiceRecord{{token u0 {package}/{component} c:{package}}}
    packageName={package}
    app={process}
    isForeground={foreground} foregroundId=3550
"""


class AdapterTests(unittest.TestCase):
    def test_current_indented_state(self):
        self.assertEqual(bluetooth_state(adapter("ON")), "ON")

    def test_stable_and_transitional_states_remain_distinct(self):
        for state in ["OFF", "ON", "BLE_ON", "TURNING_ON", "TURNING_OFF",
                      "BLE_TURNING_ON", "BLE_TURNING_OFF"]:
            with self.subTest(state=state):
                self.assertEqual(bluetooth_state(adapter(state)), state)

    def test_history_and_other_state_machines_cannot_supply_current_state(self):
        history = "BluetoothAdapterState:\n  State: ON\n10-23 -- BluetoothManagerService -- BLE_ON\n"
        self.assertIsNone(bluetooth_state(history))
        self.assertIsNone(bluetooth_state(adapter("UNRECOGNIZED") + history))
        self.assertEqual(bluetooth_state(adapter("BLE_ON") + history), "BLE_ON")

    def test_missing_conflicting_or_duplicate_headers_fail_closed(self):
        for dump in ["", "State: ON\n", adapter("ON") + adapter("OFF"),
                     "Bluetooth Status:\n  State: ON\n  State: OFF\n", adapter("ON suffix")]:
            with self.subTest(dump=dump):
                self.assertIsNone(bluetooth_state(dump))


class ForegroundTests(unittest.TestCase):
    def live(self, dump, pids="123"):
        return live_foreground_service(dump, pids, PACKAGE, SERVICE)

    def test_exact_service_and_live_process(self):
        self.assertTrue(self.live(service()))
        self.assertTrue(self.live(service(component=SERVICE), "123 456\n"))

    def test_stale_absent_or_nonforeground_process(self):
        for dump, pids in [(service(), "1234"), (service(), ""), (service(pid=None), "123"),
                           (service(foreground="false"), "123")]:
            with self.subTest(dump=dump, pids=pids):
                self.assertFalse(self.live(dump, pids))

    def test_other_component_or_package_cannot_supply_evidence(self):
        self.assertFalse(self.live(service(component=".OtherService")))
        self.assertFalse(self.live(service(package=PACKAGE + ".other")))

    def test_process_and_foreground_flag_must_be_in_same_record(self):
        self.assertFalse(self.live(service(foreground="false") + service(component=".OtherService")))
        self.assertFalse(self.live(service(pid=None) + service(component=".OtherService")))

    def test_duplicate_target_records_are_ambiguous(self):
        self.assertFalse(self.live(service() + service(pid="456")))


if __name__ == "__main__":
    unittest.main()
