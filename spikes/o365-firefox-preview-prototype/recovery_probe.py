"""Disposable external Chrome controller; no sending, credentials or body output.

Example: python3 recovery_probe.py --cdp http://127.0.0.1:PORT \
    --phrase 'MOSS BODY TEST fresh-suffix' --seconds 120
Requires existing Python Playwright. Keep the dedicated Outlook tab untouched.
"""
import argparse
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse

SOURCE = Path(__file__).resolve().parent
WORLD = 'moss-recovery-probe'


class RecoveryProbe:
    """Register a bounded one-shot bootstrap for current and reloaded documents."""

    def __init__(self, page, phrase):
        if len(phrase) > 80 or not re.fullmatch(r'MOSS BODY TEST\s+\S.*', phrase, re.I):
            raise ValueError('Use a fresh synthetic test phrase, at most 80 characters')
        self.session = page.context.new_cdp_session(page)
        self.session.send('Page.enable')
        code = '\n'.join((SOURCE / name).read_text() for name in
                         ['read-message.js', 'auto-body.js'])
        code += '''
(() => {
  if (globalThis.__mossRecoveryBootstrap) return;
  const state = globalThis.__mossRecoveryBootstrap = {attempts: 0, armed: false};
  const phrase = PHRASE;
  const tryStart = () => {
    state.attempts++;
    if (!['outlook.office.com', 'outlook.cloud.microsoft'].includes(location.hostname)
        || !/^\\/mail(?:\\/|$)/i.test(location.pathname)) {
      clearInterval(state.timer); return;
    }
    const list = [...document.querySelectorAll('[role="listbox"]')].some(e =>
      e.getClientRects().length && /message|conversation|inbox/i.test(e.getAttribute('aria-label') || ''));
    if (list) {
      clearInterval(state.timer);
      state.armed = __mossAutoBodyProbe.start(phrase).running;
    } else if (state.attempts >= 60) clearInterval(state.timer);
  };
  state.timer = setInterval(tryStart, 1000);
  tryStart();
})();
'''.replace('PHRASE', json.dumps(phrase))
        self.code = code + '\nvoid 0;'
        self.script_id = self.session.send('Page.addScriptToEvaluateOnNewDocument',
            {'source': self.code, 'worldName': WORLD})['identifier']
        self.evaluate(self.code)

    def evaluate(self, expression):
        frame = self.session.send('Page.getFrameTree')['frameTree']['frame']['id']
        context = self.session.send('Page.createIsolatedWorld',
            {'frameId': frame, 'worldName': WORLD})['executionContextId']
        result = self.session.send('Runtime.evaluate',
            {'contextId': context, 'expression': expression, 'returnByValue': True})
        if 'exceptionDetails' in result:
            raise RuntimeError('Probe evaluation failed; no page content returned')
        return result.get('result', {}).get('value')

    def status(self):
        return self.evaluate('''(() => {
          const s = globalThis.__mossAutoBodyProbe?.snapshot();
          return s ? {running:s.running, phase:s.phase, scans:s.scans,
            opened:s.opened, captured:!!s.capture, reason:s.reason,
            bootstrapAttempts:globalThis.__mossRecoveryBootstrap?.attempts} : {installed:false};
        })()''')

    def close(self):
        self.session.send('Page.removeScriptToEvaluateOnNewDocument',
                          {'identifier': self.script_id})
        self.evaluate('''clearInterval(globalThis.__mossRecoveryBootstrap?.timer);
          globalThis.__mossAutoBodyProbe?.stop();
          delete globalThis.__mossRecoveryBootstrap; void 0;''')
        self.session.detach()


def main():
    from playwright.sync_api import sync_playwright
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cdp', required=True)
    parser.add_argument('--phrase', required=True)
    parser.add_argument('--seconds', type=int, default=120)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 600:
        parser.error('--seconds must be between 1 and 600')
    if urlparse(args.cdp).hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('--cdp must be loopback')
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(args.cdp)
        pages = [t for c in browser.contexts for t in c.pages
                 if urlparse(t.url).hostname in ('outlook.office.com', 'outlook.cloud.microsoft')]
        if len(pages) != 1:
            raise RuntimeError('Need exactly one dedicated Outlook tab')
        probe = RecoveryProbe(pages[0], args.phrase)
        try:
            deadline = time.monotonic() + args.seconds
            while time.monotonic() < deadline:
                status = probe.status()
                print(json.dumps(status), flush=True)
                if status.get('captured'):
                    break
                time.sleep(min(10, max(0, deadline - time.monotonic())))
        finally:
            probe.close()


if __name__ == '__main__':
    main()
