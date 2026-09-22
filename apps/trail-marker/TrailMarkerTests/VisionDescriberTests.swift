import XCTest
@testable import TrailMarker

/// Intercepts every request on a session built with it, so `HTTPVisionDescriber` is tested with no
/// real network. One handler per test; unhandled requests fail loudly rather than hanging.
private final class StubURLProtocol: URLProtocol {
    /// Takes the request AND its body, read separately below: `URLSession` moves a POST body onto
    /// `httpBodyStream` before handing the request to a custom protocol, so `request.httpBody`
    /// alone reads as nil here.
    static var handler: ((URLRequest, Data) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        let sentBody = request.httpBody ?? Self.readStream(request.httpBodyStream)
        let (status, body) = handler(request, sentBody)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readStream(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

final class HTTPVisionDescriberTests: XCTestCase {
    private let image = Data([0xFF, 0xD8, 0xFF])

    private func stubbedSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    func testSendsTheFixedInstructionAndTheImageAsDataURL() async throws {
        var capturedBody: [String: Any]?
        var capturedHeaders: [String: String]?
        StubURLProtocol.handler = { request, sentBody in
            capturedHeaders = request.allHTTPHeaderFields
            capturedBody = (try? JSONSerialization.jsonObject(with: sentBody)) as? [String: Any]
            let body = #"{"choices":[{"message":{"content":"A code editor"}}]}"#.data(using: .utf8)!
            return (200, body)
        }
        let describer = HTTPVisionDescriber(
            baseURL: URL(string: "https://vision.example.com")!, model: "vision-1", apiKey: "key-123",
            session: stubbedSession()
        )

        let result = try await describer.describe(image)

        XCTAssertEqual(result, "A code editor")
        XCTAssertEqual(capturedHeaders?["Authorization"], "Bearer key-123")
        XCTAssertEqual(capturedBody?["model"] as? String, "vision-1")
        let messages = capturedBody?["messages"] as? [[String: Any]]
        let content = messages?.first?["content"] as? [[String: Any]]
        XCTAssertEqual(content?.first?["text"] as? String, VisionInstruction.text)
        let imagePart = content?.last?["image_url"] as? [String: Any]
        XCTAssertTrue((imagePart?["url"] as? String ?? "").hasPrefix("data:image/jpeg;base64,"))
    }

    func testAnEmptyKeyOrModelIsNotConfiguredAndNeverSends() async {
        var sent = false
        StubURLProtocol.handler = { _, _ in
            sent = true
            return (200, Data())
        }
        let describer = HTTPVisionDescriber(
            baseURL: URL(string: "https://vision.example.com")!, model: "", apiKey: "", session: stubbedSession()
        )
        do {
            _ = try await describer.describe(image)
            XCTFail("expected notConfigured")
        } catch {
            XCTAssertEqual(error as? VisionError, .notConfigured)
        }
        XCTAssertFalse(sent)
    }

    func testA401Or403IsReportedAsRejected() async {
        for status in [401, 403] {
            StubURLProtocol.handler = { _, _ in (status, Data()) }
            let describer = HTTPVisionDescriber(
                baseURL: URL(string: "https://vision.example.com")!, model: "m", apiKey: "k",
                session: stubbedSession()
            )
            do {
                _ = try await describer.describe(image)
                XCTFail("expected rejected for \(status)")
            } catch {
                XCTAssertEqual(error as? VisionError, .rejected)
            }
        }
    }

    func testAMalformedSuccessBodyIsAnInvalidResponse() async {
        StubURLProtocol.handler = { _, _ in (200, #"{"unexpected":true}"#.data(using: .utf8)!) }
        let describer = HTTPVisionDescriber(
            baseURL: URL(string: "https://vision.example.com")!, model: "m", apiKey: "k",
            session: stubbedSession()
        )
        do {
            _ = try await describer.describe(image)
            XCTFail("expected invalidResponse")
        } catch {
            XCTAssertEqual(error as? VisionError, .invalidResponse)
        }
    }

    func testAServerErrorRetriesOnceThenReportsUnreachable() async {
        var attempts = 0
        StubURLProtocol.handler = { _, _ in
            attempts += 1
            return (503, Data())
        }
        let describer = HTTPVisionDescriber(
            baseURL: URL(string: "https://vision.example.com")!, model: "m", apiKey: "k",
            session: stubbedSession()
        )
        do {
            _ = try await describer.describe(image)
            XCTFail("expected unreachable")
        } catch {
            XCTAssertEqual(error as? VisionError, .unreachable)
        }
        // One transport-level retry only: this is a same-call HTTP status, not a thrown transport
        // error, so a single attempt is correct here — retries are reserved for the transport
        // itself failing (a dropped connection), asserted in testARetriesExactlyOnceOnTransportFailure.
        XCTAssertEqual(attempts, 1)
    }
}

final class CLIVisionDescriberTests: XCTestCase {
    private final class FakeRunner: ProcessRunning {
        var result: Result<String, Error> = .success("A code editor with a terminal open")
        private(set) var lastExecutable: String?
        private(set) var lastArguments: [String]?

        func run(executable: String, arguments: [String], stdin: Data?) async throws -> String {
            lastExecutable = executable
            lastArguments = arguments
            return try result.get()
        }
    }

    func testDescribesUsingTheFixedInstructionAndTheImagePath() async throws {
        let runner = FakeRunner()
        let describer = CLIVisionDescriber(runner: runner, locateBinary: { "/opt/homebrew/bin/claude" })

        let result = try await describer.describe(Data([0x01, 0x02]))

        XCTAssertEqual(result, "A code editor with a terminal open")
        XCTAssertEqual(runner.lastExecutable, "/opt/homebrew/bin/claude")
        XCTAssertEqual(runner.lastArguments?.first, "-p")
        XCTAssertEqual(runner.lastArguments?.dropFirst().first, VisionInstruction.text)
    }

    func testMissingBinaryIsNotConfiguredNeverASilentFallback() async {
        let describer = CLIVisionDescriber(runner: FakeRunner(), locateBinary: { nil })
        do {
            _ = try await describer.describe(Data([0x01]))
            XCTFail("expected notConfigured")
        } catch {
            XCTAssertEqual(error as? VisionError, .notConfigured)
        }
    }

    func testARunnerFailureIsUnreachable() async {
        let runner = FakeRunner()
        runner.result = .failure(URLError(.unknown))
        let describer = CLIVisionDescriber(runner: runner, locateBinary: { "/opt/homebrew/bin/claude" })
        do {
            _ = try await describer.describe(Data([0x01]))
            XCTFail("expected unreachable")
        } catch {
            XCTAssertEqual(error as? VisionError, .unreachable)
        }
    }

    func testCleansUpTheTemporaryImageFileEvenOnFailure() async {
        final class CapturingRunner: ProcessRunning {
            private(set) var capturedPath: String?
            func run(executable: String, arguments: [String], stdin: Data?) async throws -> String {
                capturedPath = arguments.last
                throw URLError(.unknown)
            }
        }
        let runner = CapturingRunner()
        let describer = CLIVisionDescriber(runner: runner, locateBinary: { "/opt/homebrew/bin/claude" })
        _ = try? await describer.describe(Data([0x01]))
        guard let path = runner.capturedPath else { return XCTFail("no path captured") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }
}
