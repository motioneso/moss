//! Fixed cases for the sign-in code rule, taken from the old app's tests.
use moss_email::understand::otp::{looks_like_one_time_code as hides, sign_in_code_decision, SignInCode};

#[test]
fn keeps_mail_that_mentions_a_stay() {
    assert!(!hides("Your one-time passcode", "Your one-time passcode is 581496. Enjoy your stay with us this weekend"));
}

#[test]
fn keeps_a_policy_notice_with_only_a_phone_number() {
    let body = "We are changing how security codes are delivered. Please review the new policy. For help, call 0800 123 4567.";
    assert!(!hides("Security code policy update", body));
    assert!(!hides("Your verification code", "If you did not ask for this, call us on 0800 123 4567."));
}

#[test]
fn hides_real_codes_from_ordinary_senders() {
    assert!(hides("Here's your MyGreenhouse security code", "Your security code is 481920. It expires in 10 minutes."));
    assert!(hides("220250 is your verification code", "220250 is your verification code. Do not share it with anyone."));
    assert!(hides("Your Pumpkin verification code", "Your verification code is 730915. Enter it to finish signing in."));
}

#[test]
fn keeps_ordinary_talk_about_a_code() {
    assert!(!hides("Fwd: Your Google verification code", "Can you help me sign in? The website rejects 482910 and I need access before Monday."));
    assert!(!hides("Re: Your verification code", "We have resolved case 583921. Please try signing in again and reply if you still need help."));
    assert!(!hides("About your security code", "Please call me on (415) 555-4829 so I can help you regain access."));
}

#[test]
fn phone_shapes_are_not_codes() {
    for body in [
        "Please call me on (415) 555-4829 if you need a hand.",
        "Please call me on (415) 555 4829 if you need a hand.",
        "Please call me on 415.555.4829 if you need a hand.",
        "Please call me on 415-555-4829 if you need a hand.",
        "Please call me on (+44) 20 7946 0958 if you need a hand.",
    ] {
        assert!(!hides("Your verification code", body), "{body}");
    }
}

#[test]
fn numbers_that_belong_elsewhere_are_not_codes() {
    for body in [
        "We have resolved case 583921 and closed it.",
        "Your ticket 583921 is now with the sign-in team.",
        "Quote reference 583921 when you write back to us.",
        "The website rejects 482910 every time I try.",
        "I never received it. My colleague on desk 482910 said the same thing happened.",
    ] {
        assert!(!hides("Your verification code", body), "{body}");
    }
}

#[test]
fn conversation_subjects_are_kept() {
    for subject in [
        "Re: Your verification code", "RE: your sign-in code", "Fwd: Your Google verification code",
        "FW: your login code", "Fw: your one-time passcode", "About your security code",
        "Regarding your verification code", "Question about your sign-in code",
        "Help with your verification code", "Problem with your login code",
        "Issue with your one-time passcode",
    ] {
        assert!(!hides(subject, "Your verification code is 482910. Enter it to finish signing in."), "{subject}");
    }
}

#[test]
fn a_code_alone_under_a_naming_line_is_hidden() {
    assert!(hides("Your verification code", "Here is your verification code\n\n482910\n\nIt expires in ten minutes."));
}

#[test]
fn unsure_cases_go_to_the_model() {
    for (subject, body) in [
        ("Your verification code doesn't work", "When I enter 482910, the website says it has expired. Can you help me sign in before Monday?"),
        ("Your verification code", "The error code is 482910. Please send us a screenshot so we can restore your access."),
        ("Your verification code", "I cannot sign in with this code:\n\n482910\n\nCan you help me regain access before Monday?"),
    ] {
        assert_eq!(sign_in_code_decision(subject, body), SignInCode::Unclear, "{body}");
    }
    assert_eq!(
        sign_in_code_decision("Your Pumpkin verification code", "Your verification code is 730915. Enter it to finish signing in."),
        SignInCode::HandsOver
    );
    assert_eq!(
        sign_in_code_decision("Dinner Saturday", "The door code is 482910. Please bring dessert and come round about seven."),
        SignInCode::Ordinary
    );
}
