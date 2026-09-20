import Foundation

/// A validated Moss instance address: origin (scheme + host + port) and an optional base path,
/// with no user info, query, or fragment. Local addresses may use HTTP; every remote address must
/// use HTTPS.
struct InstanceURL: Equatable, Codable {
    let origin: URL
    let basePath: String

    private static let localHosts: Set<String> = ["localhost", "127.0.0.1", "::1"]

    static func parse(_ text: String) -> Result<InstanceURL, InstanceURLError> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        guard
            let components = URLComponents(string: trimmed),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = components.host, !host.isEmpty
        else {
            return .failure(.invalid)
        }

        if components.user != nil || components.password != nil {
            return .failure(.credentialsInURL)
        }

        if let query = components.query, !query.isEmpty {
            return .failure(.queryOrFragment)
        }
        if let fragment = components.fragment, !fragment.isEmpty {
            return .failure(.queryOrFragment)
        }

        // URLComponents.host keeps the brackets on an IPv6 literal ("[::1]"); strip them only
        // for the local-address comparison, since URLComponents needs them back to build a URL.
        let unbracketedHost = host.hasPrefix("[") && host.hasSuffix("]")
            ? String(host.dropFirst().dropLast())
            : host

        if scheme == "http", !localHosts.contains(unbracketedHost.lowercased()) {
            return .failure(.insecureRemote)
        }

        var originComponents = URLComponents()
        originComponents.scheme = scheme
        originComponents.host = host
        originComponents.port = components.port
        guard let origin = originComponents.url else {
            return .failure(.invalid)
        }

        var basePath = components.path
        if basePath == "/" {
            basePath = ""
        } else if basePath.hasSuffix("/") {
            basePath.removeLast()
        }

        return .success(InstanceURL(origin: origin, basePath: basePath))
    }

    func endpoint(_ path: String) -> URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        let suffix = path.hasPrefix("/") ? path : "/\(path)"
        components.path = basePath + suffix
        return components.url!
    }

    /// For a server-supplied browser page path that may carry a `#fragment` — the pairing
    /// approval link, whose code lives after the `#` on purpose: a fragment is the one part of
    /// an address a browser never sends to a server, so a query parameter there would write a
    /// live secret into the server's own request log. Appends the string exactly as given
    /// instead of decomposing and reassembling it through `URLComponents`, so nothing here can
    /// re-encode or otherwise alter what follows the `#`.
    func browserURL(_ pathWithFragment: String) -> URL {
        let suffix = pathWithFragment.hasPrefix("/") ? pathWithFragment : "/\(pathWithFragment)"
        guard let url = URL(string: origin.absoluteString + basePath + suffix) else {
            preconditionFailure("server-supplied approval path was not a valid URL: \(pathWithFragment)")
        }
        return url
    }
}

enum InstanceURLError: Error, Equatable {
    case invalid
    case insecureRemote
    case credentialsInURL
    case queryOrFragment
}
