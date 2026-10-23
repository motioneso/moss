"""Synthetic reload/rearm checks. Uses local Chrome and intercepts all requests."""
from playwright.sync_api import sync_playwright
from recovery_probe import RecoveryProbe


def main():
    phrase = 'MOSS BODY TEST recovery-fixture'
    fixture = '<div role="listbox" aria-label="Messages"></div>'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
        page = browser.new_page()
        page.route('**/*', lambda route: route.fulfill(body=fixture, content_type='text/html'))
        page.goto('https://outlook.office.com/mail/inbox')
        probe = RecoveryProbe(page, phrase)
        assert probe.status()['running']
        page.reload()
        page.wait_for_timeout(1200)
        assert probe.status()['running'], 'Reload did not automatically rearm'
        assert probe.status()['scans'] == 0
        assert page.evaluate('typeof __mossAutoBodyProbe') == 'undefined', 'Probe leaked to main world'
        fixture = '<div role="listbox" aria-label="Messages"><div role="option">' + phrase + '</div></div>'
        page.reload()
        page.wait_for_timeout(1200)
        status = probe.status()
        assert not status['running'] and status['opened'] == 0
        assert 'existing matching row' in status['reason'], 'Duplicate guard missing'
        page.goto('https://example.invalid/mail/inbox')
        page.wait_for_timeout(1200)
        status = probe.status()
        assert not status['running'] and status['reason'] == 'Not started'
        probe.close()
        page.reload()
        assert page.evaluate('typeof __mossAutoBodyProbe') == 'undefined'
        # No new-document registration remains after close, even in its isolated world.
        session = page.context.new_cdp_session(page)
        frame = session.send('Page.getFrameTree')['frameTree']['frame']['id']
        context = session.send('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'moss-recovery-probe'})['executionContextId']
        result = session.send('Runtime.evaluate', {'contextId': context, 'expression': 'typeof __mossAutoBodyProbe', 'returnByValue': True})
        assert result['result']['value'] == 'undefined'
        browser.close()
    print('PASS: initial arm, reload rearm, isolated world, duplicate refusal, foreign-host refusal, registration cleanup')


if __name__ == '__main__':
    main()
