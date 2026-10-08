import AudioToolbox
import CoreAudio
import Foundation

/// VPIO configuration isolated from device acquisition so XCTest can check the actual
/// property writes without opening a microphone. Both buses must remain enabled.
enum MeetingVoiceProcessing {
    typealias WriteProperty = (AudioUnitPropertyID, AudioUnitScope, AudioUnitElement, UnsafeRawPointer, UInt32) throws -> Void

    static func componentDescription(voiceProcessing: Bool) -> AudioComponentDescription {
        AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: voiceProcessing ? kAudioUnitSubType_VoiceProcessingIO : kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0
        )
    }

    static func configureDevices(microphone: AudioDeviceID, output: AudioDeviceID?, write: WriteProperty) throws {
        if var output {
            try write(kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                      &output, UInt32(MemoryLayout<AudioDeviceID>.size))
        }
        var microphone = microphone
        try write(kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, output == nil ? 0 : 1,
                  &microphone, UInt32(MemoryLayout<AudioDeviceID>.size))
    }

    static func configureFormats(format: AudioStreamBasicDescription, voiceProcessing: Bool,
                                 write: WriteProperty) throws {
        var format = format
        try write(kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1,
                  &format, UInt32(MemoryLayout<AudioStreamBasicDescription>.size))
        if voiceProcessing {
            // Both client sides use the same mono format. Only silence reaches output.
            try write(kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0,
                      &format, UInt32(MemoryLayout<AudioStreamBasicDescription>.size))
        }
        // Select the processed first channel explicitly rather than allowing a downmix.
        // A VPIO unit that rejects this map must use the ordinary startup fallback.
        var channel: Int32 = 0
        try write(kAudioOutputUnitProperty_ChannelMap, kAudioUnitScope_Output, 1,
                  &channel, UInt32(MemoryLayout<Int32>.size))
    }

    /// Fixed public labels only: errors never include device names or property payloads.
    static func propertyOperation(_ property: AudioUnitPropertyID) -> String {
        switch property {
        case kAudioOutputUnitProperty_EnableIO: return "enable voice reference output"
        case kAUVoiceIOProperty_BypassVoiceProcessing: return "enable microphone voice processing"
        case kAUVoiceIOProperty_VoiceProcessingEnableAGC: return "disable microphone voice gain control"
        case kAUVoiceIOProperty_OtherAudioDuckingConfiguration: return "configure minimum voice ducking"
        case kAudioUnitProperty_SetRenderCallback: return "install silent voice reference callback"
        default: return "configure voice processing property"
        }
    }

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
        guard alive, current == expected else { context.referenceDidDisappear(); return }
    }
}
