import XCTest
@testable import TrailMarker

final class InstanceURLTests: XCTestCase {
    private func parsed(_ text: String) -> Result<InstanceURL, InstanceURLError> {
        InstanceURL.parse(text)
    }

    func testPlainHTTPSOrigin() {
        switch parsed("https://moss.example.com") {
        case .success(let instance):
            XCTAssertEqual(instance.origin.absoluteString, "https://moss.example.com")
            XCTAssertEqual(instance.basePath, "")
        case .failure(let error):
            XCTFail("expected success, got \(error)")
        }
    }

    func testPortAndBasePathWithTrailingSlash() {
        switch parsed("https://moss.example.com:8443/moss/") {
        case .success(let instance):
            XCTAssertEqual(instance.origin.absoluteString, "https://moss.example.com:8443")
            XCTAssertEqual(instance.basePath, "/moss")
        case .failure(let error):
            XCTFail("expected success, got \(error)")
        }
    }

    func testLocalHTTPAddressesAreAllowed() {
        for text in ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"] {
            switch parsed(text) {
            case .success:
                break
            case .failure(let error):
                XCTFail("expected \(text) to succeed, got \(error)")
            }
        }
    }

    func testRemoteIPOverHTTPIsInsecure() {
        XCTAssertEqual(parsed("http://192.168.1.10:3000"), .failure(.insecureRemote))
    }

    func testLookalikeLocalhostSubdomainIsInsecure() {
        XCTAssertEqual(parsed("http://localhost.evil.com"), .failure(.insecureRemote))
    }

    func testCredentialsInURLAreRejected() {
        XCTAssertEqual(parsed("https://u:p@x.com"), .failure(.credentialsInURL))
    }

    func testQueryIsRejected() {
        XCTAssertEqual(parsed("https://x.com/?a=1"), .failure(.queryOrFragment))
    }

    func testMissingSchemeIsInvalid() {
        XCTAssertEqual(parsed("moss"), .failure(.invalid))
    }

    func testBrowserURLPreservesTheFragmentVerbatim() {
        guard case .success(let instance) = parsed("https://moss.example.com") else {
            return XCTFail("expected a parsed instance")
        }
        let url = instance.browserURL("/link/trail-marker#code=AbC123_-xyz")
        XCTAssertEqual(url.absoluteString, "https://moss.example.com/link/trail-marker#code=AbC123_-xyz")
        // The fragment must never become part of what a server sees in the request line.
        XCTAssertFalse(url.path.contains("code="))
    }

    func testBrowserURLWithBasePath() {
        guard case .success(let instance) = parsed("https://moss.example.com:8443/moss/") else {
            return XCTFail("expected a parsed instance")
        }
        let url = instance.browserURL("/link/trail-marker#code=xyz")
        XCTAssertEqual(url.absoluteString, "https://moss.example.com:8443/moss/link/trail-marker#code=xyz")
    }

    func testEndpointCombinesBasePathAndOrigin() {
        guard case .success(let instance) = parsed("https://moss.example.com:8443/moss/") else {
            return XCTFail("expected a parsed instance")
        }
        XCTAssertEqual(
            instance.endpoint("/api/companion/protocol").absoluteString,
            "https://moss.example.com:8443/moss/api/companion/protocol"
        )
    }
}
