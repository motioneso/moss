import CoreAudio

/// Read-only default-device lookup and pure identity mapping. Ordering is only for display.
enum MeetingMicrophoneInventory {
    static func defaultInputDevice(
        read: (AudioObjectID, AudioObjectPropertySelector) throws -> UInt32
    ) -> AudioObjectID? {
        guard let device = try? read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice),
              device != kAudioObjectUnknown else { return nil }
        return device
    }

    static func defaultMicrophoneId(device: AudioObjectID?, devices: [String: AudioObjectID],
                                    microphones: [MeetingCaptureInventory.Microphone]) -> String? {
        guard let device, device != kAudioObjectUnknown else { return nil }
        let matchingIDs = devices.filter { $0.value == device }.map(\.key)
        guard matchingIDs.count == 1, let id = matchingIDs.first,
              microphones.filter({ $0.deviceId == id }).count == 1 else { return nil }
        return id
    }

    static func ordered(_ microphones: [MeetingCaptureInventory.Microphone]) -> [MeetingCaptureInventory.Microphone] {
        microphones.sorted {
            $0.label == $1.label ? $0.deviceId < $1.deviceId : $0.label < $1.label
        }
    }
}
