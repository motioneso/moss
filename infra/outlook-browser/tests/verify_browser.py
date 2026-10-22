"""Actual candidate Chromium through Runtime/Podman/Egress, no accounts or Moss UI.

The test-only helper receives CDP requests on exec stdin; it is never copied into
the image or exposed by the broker. Public Microsoft requests use normal TLS checks.
"""
import argparse
import asyncio
import json
import re
import tempfile
import uuid
from pathlib import Path

from chromium_seccomp import chromium_policy
from lifecycle import Inventory
from podman import Podman
from runtime import Runtime
from service_lock import ServiceLock
from verify_network import command


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = 'https://www.microsoft.com/robots.txt'
PROBE = r'''
import json, sys, time
from urllib.request import urlopen
import websocket
deadline = time.monotonic() + 15
while True:
    try:
        with urlopen('http://127.0.0.1:9222/json/list', timeout=2) as response:
            targets = json.load(response)
        target = next(t for t in targets if t['type'] == 'page')
        break
    except (OSError, StopIteration):
        if time.monotonic() >= deadline:
            raise RuntimeError('Synthetic browser readiness timed out') from None
        time.sleep(.2)
connection = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=20,
                                         suppress_origin=True)
try:
    connection.send(json.dumps({'id': 1, **json.load(sys.stdin)}))
    while True:
        message = json.loads(connection.recv())
        if message.get('id') == 1:
            assert 'error' not in message, 'CDP probe failed'
            print(json.dumps(message['result']))
            break
finally:
    connection.close()
'''


async def call(name, method, params=None):
    output = await command('exec', '-i', name, '/usr/bin/python3', '-B', '-c', PROBE,
                           data=json.dumps({'method': method, 'params': params or {}}).encode())
    return json.loads(output)


async def evaluate(name, expression):
    result = await call(name, 'Runtime.evaluate', {
        'expression': expression, 'returnByValue': True, 'awaitPromise': True})
    assert 'exceptionDetails' not in result, 'Synthetic expression failed'
    return result['result'].get('value')


async def navigate(name, url):
    result = await call(name, 'Page.navigate', {'url': url})
    # Await a settled document in the browser, bounded independently of the
    # engine's process timeout. A Chromium network-error page also settles.
    await evaluate(name, '''new Promise((resolve,reject)=>{
      const end=Date.now()+15000;
      const check=()=>{if(document.readyState==='complete')resolve(true);
        else if(Date.now()>end)reject(Error('load timeout'));else setTimeout(check,100)};
      setTimeout(check,200);
    })''')
    return result


def require_sandbox(status):
    for pattern in (r'Layer 1 Sandbox\s+Namespace', r'PID namespaces\s+Yes',
                    r'Network namespaces\s+Yes', r'Seccomp-BPF sandbox\s+Yes'):
        assert re.search(pattern, status), 'Chromium inner sandbox missing'
    assert 'You are adequately sandboxed.' in status


def require_no_cdp(body):
    assert 'webSocketDebuggerUrl' not in body, 'Page reached local CDP listener'


async def control_image(image, root, label, before, after):
    source = (ROOT / 'image/runner.py').read_text()
    assert source.count(before) == 1, 'Control patch is ambiguous'
    context = root / label
    context.mkdir()
    (context / 'runner.py').write_text(source.replace(before, after))
    tag = 'localhost/moss-browser-control:' + uuid.uuid4().hex
    await command('build', '--pull=never', '--tag', tag, '--file', '-', str(context),
                  data=(f'FROM {image}\nCOPY runner.py /opt/moss/runner.py\n').encode())
    installed = (await command('image', 'inspect', '--format', '{{.Id}}', tag)).decode().strip()
    return tag, 'sha256:' + installed.removeprefix('sha256:')


async def verify(image):
    # Keep AF_UNIX paths below Linux's 108-byte limit even if the build store
    # uses a long TMPDIR on a separate disk.
    with tempfile.TemporaryDirectory(prefix='moss-browser-', dir='/tmp') as directory:
        root = Path(directory)
        transport = root / 'transport'
        transport.mkdir(mode=0o700)
        policy = root / 'seccomp.json'
        policy.write_text(json.dumps(chromium_policy(json.loads(
            Path('/usr/share/containers/seccomp.json').read_text()))))
        inventory = Inventory(root / 'state')
        lock = ServiceLock(inventory.directory)
        engine = await asyncio.to_thread(Podman, image=image, seccomp=policy,
                                         transport_root=transport, service_lock=lock)
        runtime = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                          denied_networks=())
        ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        controls = []
        try:
            for runtime_id in ids:
                await runtime.allocate(runtime_id, 1)
            names = [engine.names(runtime_id)[0] for runtime_id in ids]
            for installed, source in (('/opt/moss/runner.py', 'image/runner.py'),
                                      ('/opt/moss/proxy.py', 'proxy.py'),
                                      ('/etc/chromium/policies/managed/moss.json', 'image/policy.json')):
                assert await command('exec', names[0], 'cat', installed) == (ROOT / source).read_bytes()
            for name in names:
                assert await evaluate(name, 'location.href') == 'about:blank'
                actual = json.loads(await command('inspect', name))[0]
                assert actual['HostConfig']['NetworkMode'] == 'none'
                assert actual['HostConfig']['ReadonlyRootfs']
                assert not actual['HostConfig']['PortBindings']
                assert not actual['EffectiveCaps']
                await navigate(name, 'chrome://sandbox')
                require_sandbox(await evaluate(name, 'document.body.innerText'))
            print('PASS: two real Chromium processes report namespace and seccomp sandboxes', flush=True)
            for index, name in enumerate(names):
                result = await navigate(name, PUBLIC)
                assert 'errorText' not in result, 'Public browser HTTPS failed: ' + str(result.get('errorText'))
                assert await evaluate(name, 'location.protocol') == 'https:'
                assert await evaluate(name, 'document.documentURI.startsWith("https://www.microsoft.com/")')
                assert await evaluate(name, 'localStorage.getItem("moss-synthetic-marker")') is None
                await evaluate(name, f'localStorage.setItem("moss-synthetic-marker","fixture-{index}")')
            for index, name in enumerate(names):
                assert await evaluate(name, 'localStorage.getItem("moss-synthetic-marker")') == f'fixture-{index}'
            print('PASS: public Microsoft HTTPS and separate fresh browser storage', flush=True)
            for url in ('https://127.0.0.1/', 'https://169.254.169.254/',
                        'https://10.0.0.1/', 'https://[::1]/', 'https://[fc00::1]/',
                        'http://127.0.0.1:9222/json/version'):
                result = await navigate(names[0], url)
                body = await evaluate(names[0], 'document.body.innerText')
                assert ('errorText' in result or
                        await evaluate(names[0], 'document.documentURI') == 'chrome-error://chromewebdata/' or
                        not body), 'Private browser navigation unexpectedly succeeded'
                require_no_cdp(body)
            print('PASS: actual browser denies tested private IPv4/IPv6 and local CDP navigation', flush=True)
            await command('stop', '--time', '10', names[0])
            await runtime.allocate(ids[0], 1)
            result = await navigate(names[0], PUBLIC)
            assert 'errorText' not in result, 'Restart HTTPS failed: ' + str(result.get('errorText'))
            assert await evaluate(names[0], 'document.documentURI.startsWith("https://www.microsoft.com/")')
            assert await evaluate(names[0], 'localStorage.getItem("moss-synthetic-marker")') == 'fixture-0'
            await runtime.remove(ids[0], 2)
            assert not engine.owned('volume', engine.names(ids[0])[1], ids[0])
            assert await evaluate(names[1], 'localStorage.getItem("moss-synthetic-marker")') == 'fixture-1'
            print('PASS: graceful browser restart persists profile; removal leaves second browser intact', flush=True)
            for label, before, after in (
                    ('sandbox', "'--headless',", "'--headless', '--no-sandbox',"),
                    ('loopback', "'--proxy-bypass-list=<-loopback>',", '')):
                tag, control = await control_image(image, root, label, before, after)
                controls.append(tag)
                runtime.engine = await asyncio.to_thread(
                    Podman, image=control, seccomp=policy, transport_root=transport, service_lock=lock)
                runtime_id = str(uuid.uuid4())
                ids.append(runtime_id)
                await runtime.allocate(runtime_id, 1)
                name = engine.names(runtime_id)[0]
                await navigate(name, 'chrome://sandbox' if label == 'sandbox' else
                               'http://127.0.0.1:9222/json/version')
                body = await evaluate(name, 'document.body.innerText')
                try:
                    (require_sandbox if label == 'sandbox' else require_no_cdp)(body)
                except AssertionError:
                    pass
                else:
                    raise AssertionError('Browser guard-removal control did not fail: ' + label)
                await runtime.remove(runtime_id, 2)
                print('PASS: actual browser assertion fails after removing ' + label + ' guard', flush=True)
        finally:
            runtime.engine = engine
            for runtime_id in ids:
                await runtime.remove(runtime_id, 2)
            await runtime.close()
            lock.close()
            for tag in controls:
                await command('image', 'rm', tag)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='Installed immutable sha256 image ID')
    asyncio.run(verify(parser.parse_args().image))
