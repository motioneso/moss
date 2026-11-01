"""Records Chromium's own sandbox diagnostics from inside the container."""
import asyncio
import re

from common import Cdp, record


async def main():
    cdp = Cdp()
    await cdp.open()
    created = await cdp.call('Target.createTarget', {'url': 'chrome://sandbox'})
    attached = await cdp.call('Target.attachToTarget',
                              {'targetId': created['targetId'], 'flatten': True})
    session = attached['sessionId']
    await asyncio.sleep(2)
    text = (await cdp.call('Runtime.evaluate', {
        'expression': 'document.body.innerText', 'returnByValue': True},
        session=session))['result']['value']
    await cdp.call('Target.closeTarget', {'targetId': created['targetId']})
    keep = [l.strip() for l in text.splitlines() if re.search(
        r'sandbox|namespace|seccomp|suid|Yes|No', l, re.I)]
    print('\n'.join(keep[:40]))
    record('sandbox diagnostics read ok' if 'sandbox' in text.lower() else 'sandbox diagnostics unreadable')
    cdp.close()


asyncio.run(main())
