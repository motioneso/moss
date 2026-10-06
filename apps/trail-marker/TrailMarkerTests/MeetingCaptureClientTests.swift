import Foundation
import XCTest
@testable import TrailMarker

/// Synthetic transport only: no credential issuance, CoreAudio input, or OS permission request.
final class MeetingCaptureClientTests: XCTestCase {
    func testThreeCoalescedChunksEncodeExactWireContractWithContiguousSequences() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MeetingCaptureFixtureProtocol.self]
        let client = MeetingCaptureClient(instance: try InstanceURL.parse("https://moss.example").get(), configuration: config)
        defer { client.close() }
        var sequencer = MeetingUploadSequencer()
        for (index, callback) in [UInt64(0), 469, 939].enumerated() {
            let identity = sequencer.identity(epoch: 1, source: "microphone", callbackSequence: callback)
            let body = MeetingCaptureAudioBody(meetingId: "5ec78d03-cd7b-43cc-bbf2-78e1f43c9785",
                grantId: "88663201-6da7-439e-8d07-20d325b5dc83", requestKey: identity.requestKey,
                generation: 1, epoch: 1, sourceId: "microphone", sequence: identity.sequence,
                startMs: UInt64(index * 5000), endMs: UInt64((index + 1) * 5000), sampleRateHz: 16000,
                pcmBase64: try MeetingPCMEncoder.encode([Float](repeating: 0.25, count: 80000)))
            let data = try JSONEncoder().encode(body)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(Set(json.keys), Set(["meetingId", "grantId", "requestKey", "generation", "epoch", "sourceId", "sequence", "startMs", "endMs", "sampleRateHz", "pcmBase64"]))
            XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(json["requestKey"] as? String)))
            XCTAssertEqual(json["sequence"] as? Int, index)
            XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(json["pcmBase64"] as? String))?.count, 160000)
            let receipt: MeetingCaptureReceipt = try await withCheckedThrowingContinuation { continuation in
                do {
                    _ = try client.beginAudio(body, credential: "mm1_synthetic-fixture") { result in continuation.resume(with: result) }
                } catch { continuation.resume(throwing: error) }
            }
            XCTAssertEqual(receipt.requestKey, identity.requestKey)
            XCTAssertEqual(receipt.status, "saved")
            sequencer.acknowledge(epoch: 1, source: "microphone", callbackSequence: callback)
        }
    }

    func testChunkedOversizedResponseCancelsBeforeBufferGrowsPastLimit() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MeetingCaptureFixtureProtocol.self]
        let client = MeetingCaptureClient(instance: try InstanceURL.parse("https://moss.example").get(), configuration: config)
        defer { client.close() }
        let body = MeetingCaptureAudioBody(meetingId: "m", grantId: "g", requestKey: UUID().uuidString,
            generation: 1, epoch: 1, sourceId: "oversized-fixture", sequence: 0,
            startMs: 0, endMs: 1, sampleRateHz: 16000, pcmBase64: "AAA=")
        do {
            let _: MeetingCaptureReceipt = try await withCheckedThrowingContinuation { continuation in
                do {
                    _ = try client.beginAudio(body, credential: "mm1_synthetic-fixture") { continuation.resume(with: $0) }
                } catch { continuation.resume(throwing: error) }
            }
            XCTFail("Oversized response was accepted")
        } catch {
            XCTAssertEqual(error as? MeetingHostError, .invalidResponse)
        }
        XCTAssertLessThanOrEqual(client.largestBufferedResponseBytes, MeetingCaptureClient.maximumResponseBytes)
    }

    func testConnectionBootstrapRequiresIndependentProofBeforeAnyRequest() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MeetingCaptureFixtureProtocol.self]
        let client = MeetingCaptureClient(instance: try InstanceURL.parse("https://moss.example").get(), configuration: config)
        defer { client.close() }
        let inventory = MeetingCaptureInventory(microphones: [], applications: [],
            computerAudio: .init(available: false, excludedProcessTreeIds: []), microphonePermission: .unknown, systemAudioPermission: .unknown)
        do {
            _ = try await client.register(.init(connectionId: UUID().uuidString,
                verifierHash: String(repeating: "a", count: 64), inventory: inventory),
                companionCredential: "tm1_synthetic-fixture", recordingProof: "")
            XCTFail("A legacy credential alone must not reach recorder connection bootstrap")
        } catch { XCTAssertEqual(error as? MeetingHostError, .authorizationExpired) }
    }

    func testRetryAfterSupportsSecondsAndHTTPDateWithoutEarlyRetry() throws {
        let url = try XCTUnwrap(URL(string: "https://moss.example/api/meetings/capture/status"))
        let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil, headerFields: ["Retry-After": "120"]))
        XCTAssertEqual(MeetingCaptureClient.retryDelay(response), 120000)
        let dated = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 503, httpVersion: nil,
            headerFields: ["Retry-After": "Tue, 06 Oct 2026 04:02:00 GMT"]))
        XCTAssertEqual(MeetingCaptureClient.retryDelay(dated, now: try XCTUnwrap(ServerTime.parse("2026-10-06T04:00:00Z"))), 120000)
    }

    func testConnectionAndClaimWireNeverEmbedProofOrBearerInJSON() throws {
        let claim = MeetingRecordingClaimBody(connectionId: "connection", verifier: String(repeating: "v", count: 43),
            grantId: "grant", credentialHash: MeetingCaptureClient.verifierHash("mm1_generated-only-locally"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(claim)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), Set(["connectionId", "verifier", "grantId", "credentialHash"]))
        XCTAssertNil(json["credential"])
        XCTAssertNil(json["recordingProof"])
        XCTAssertEqual((json["credentialHash"] as? String)?.count, 64)
    }

    func testCompanionCredentialCannotAuthorizeAudio() throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MeetingCaptureFixtureProtocol.self]
        let client = MeetingCaptureClient(instance: try InstanceURL.parse("https://moss.example").get(), configuration: config)
        defer { client.close() }
        let body = MeetingCaptureAudioBody(meetingId: "m", grantId: "g", requestKey: UUID().uuidString,
            generation: 1, epoch: 1, sourceId: "microphone", sequence: 0, startMs: 0, endMs: 1,
            sampleRateHz: 16000, pcmBase64: "AAA=")
        XCTAssertThrowsError(try client.beginAudio(body, credential: "tm1_synthetic-fixture") { _ in XCTFail("Unexpected send") })
    }
}

private final class MeetingCaptureFixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let data: Data
        if let body = request.httpBody { data = body }
        else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var result = Data()
            var bytes = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                result.append(contentsOf: bytes.prefix(count))
            }
            data = result
        } else { client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let key = json["requestKey"] as? String,
              let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return
        }
        if json["sourceId"] as? String == "oversized-fixture" {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(repeating: 32, count: 200000))
            client?.urlProtocol(self, didLoad: Data(repeating: 32, count: 200000))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let reply = Data("{\"status\":\"saved\",\"requestKey\":\"\(key)\"}".utf8)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
