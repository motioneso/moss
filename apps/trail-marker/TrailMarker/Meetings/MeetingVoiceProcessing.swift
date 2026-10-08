import AudioToolbox
import CoreAudio
import Foundation

/// VPIO configuration isolated from device acquisition so XCTest can check the actual
/// property writes without opening a microphone. Both buses must remain enabled.
enum MeetingVoiceProcessing {
    typealias WriteProperty = (AudioUnitPropertyID, AudioUnitScope, AudioUnitElement, UnsafeRawPointer, UInt32) throws -> Void

    static func configureOutput(write: WriteProperty) throws {
        var enabled: UInt32 = 1
        try write(kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0,
                  &enabled, UInt32(MemoryLayout<UInt32>.size))
        var disabled: UInt32 = 0
        try write(kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0,
                  &disabled, UInt32(MemoryLayout<UInt32>.size))
        // Avoid an additional automatic gain change on the local speaker's recording.
        try write(kAUVoiceIOProperty_VoiceProcessingEnableAGC, kAudioUnitScope_Global, 0,
                  &disabled, UInt32(MemoryLayout<UInt32>.size))
        // Minimum is Apple's least attenuation, not a promise of zero ducking.
        var ducking = AUVoiceIOOtherAudioDuckingConfiguration(
            mEnableAdvancedDucking: true, mDuckingLevel: .min)
        try write(kAUVoiceIOProperty_OtherAudioDuckingConfiguration, kAudioUnitScope_Global, 0,
                  &ducking, UInt32(MemoryLayout<AUVoiceIOOtherAudioDuckingConfiguration>.size))
        var callback = AURenderCallbackStruct(inputProc: { _, flags, _, _, frames, buffers in
            MeetingVoiceProcessing.renderSilence(flags: flags, frames: frames, buffers: buffers)
        }, inputProcRefCon: nil)
        try write(kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0,
                  &callback, UInt32(MemoryLayout<AURenderCallbackStruct>.size))
    }

    /// No captured data, allocation, dispatch, retained context, or lock on this callback.
    /// Both VPIO client sides are configured as mono Float32.
    static func renderSilence(flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
                              frames: UInt32, buffers: UnsafeMutablePointer<AudioBufferList>?) -> OSStatus {
        flags.pointee.insert(.unitRenderAction_OutputIsSilence)
        guard frames <= MeetingMicrophoneCapture.maximumBufferedFrames,
              let buffers, buffers.pointee.mNumberBuffers == 1,
              buffers.pointee.mBuffers.mNumberChannels == 1,
              buffers.pointee.mBuffers.mDataByteSize == frames * 4,
              let data = buffers.pointee.mBuffers.mData else { return kAudio_ParamError }
        memset(data, 0, Int(frames) * MemoryLayout<Float>.size)
        return noErr
    }

    /// Route notices run on the serialized property queue, not the render callback.
    static func verifyReference(expected: AudioDeviceID, current: AudioDeviceID?, alive: Bool,
                                context: MeetingMicrophoneRenderContext) {
        guard alive, current == expected else { context.deviceDidDisappear(); return }
    }
}
