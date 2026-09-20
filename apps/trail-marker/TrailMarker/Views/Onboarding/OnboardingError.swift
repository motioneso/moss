import Foundation

/// The four error categories from spec §3.2, worded per the design guide (§13). Every
/// `InstanceURLError` and `CompanionError` that onboarding can hit collapses into one of these.
enum OnboardingError: Equatable {
    case invalidURL
    case remoteHTTPRequiresHTTPS
    case unreachable
    case incompatibleVersion

    var message: String {
        switch self {
        case .invalidURL:
            return "Enter a valid Moss instance URL."
        case .remoteHTTPRequiresHTTPS:
            return "Use HTTPS for remote Moss instances."
        case .unreachable:
            return "Can't reach this Moss instance. Check the URL and network connection."
        case .incompatibleVersion:
            return "This Moss version isn't compatible with Trail Marker."
        }
    }

    static func from(_ error: InstanceURLError) -> OnboardingError {
        switch error {
        case .insecureRemote:
            return .remoteHTTPRequiresHTTPS
        case .invalid, .credentialsInURL, .queryOrFragment:
            return .invalidURL
        }
    }

    static func from(_ error: CompanionError) -> OnboardingError {
        switch error {
        case .incompatible:
            return .incompatibleVersion
        default:
            return .unreachable
        }
    }
}
