"""Account-free effective-policy proof on the real candidate runtime.

Only test-side exec uses CDP. Derivative images change the policy file alone;
neither helpers nor bypasses are installed in the image or lifecycle service.
"""
import argparse
import asyncio
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shlex
import shutil
import tempfile
import uuid

from chromium_seccomp import chromium_policy
from lifecycle import Inventory
from podman import Podman
from runtime import Runtime
from service_lock import ServiceLock
from verify_browser import ROOT, call, evaluate, navigate, require_sandbox
from verify_network import command


EXPECTED = {
    'AutofillAddressEnabled': False,
    'AutofillCreditCardEnabled': False,
    'BackgroundModeEnabled': False,
    'BrowserSignin': 0,
    'DefaultNotificationsSetting': 2,
    'DownloadRestrictions': 3,
    'PasswordManagerEnabled': False,
    'PrintingEnabled': False,
    'SyncDisabled': True,
}
PREFERENCES = (
    'autofill.profile_enabled', 'autofill.credit_card_enabled',
    'background_mode.enabled', 'credentials_enable_service',
    'signin.allowed_on_next_startup',
)
FILENAME = 'moss-synthetic-policy-download.txt'
CONTENT = 'moss synthetic policy probe; no account data'


@contextmanager
def engine_store(root, runroot):
    """Test-only PATH adapter; every engine subprocess uses the selected store."""
    if bool(root) != bool(runroot):
        raise ValueError('Supply both engine root and runroot')
    executable = shutil.which('podman')
    if not executable:
        raise RuntimeError('Podman not found')
    original = os.environ.get('PATH', '')
    with tempfile.TemporaryDirectory(prefix='moss-policy-engine-', dir='/tmp') as directory:
        arguments = [executable]
        if root:
            arguments.extend(['--root', str(Path(root).resolve()),
                              '--runroot', str(Path(runroot).resolve())])
        wrapper = Path(directory) / 'podman'
        wrapper.write_text('#!/bin/sh\nexec ' + shlex.join(arguments) + ' "$@"\n')
        wrapper.chmod(0o700)
        os.environ['PATH'] = directory + os.pathsep + original
        try:
            yield
        finally:
            os.environ['PATH'] = original


async def policy_rows(name):
    await navigate(name, 'chrome://policy')
    return await evaluate(name, '''new Promise((resolve,reject)=>{
      const end=Date.now()+10000;
      const check=()=>{
        const tables=Array.from(document.querySelectorAll('policy-table'));
        if(!tables.length){if(Date.now()>end)reject(Error('policy UI timeout'));
          else setTimeout(check,100);return;}
        resolve(tables.flatMap(t=>Array.from(t.shadowRoot.querySelectorAll('policy-row'))
          .map(e=>Object.fromEntries(['name','value','source','scope','level','messages']
            .map(k=>[k,e.shadowRoot.querySelector('.policy.row .'+k)?.innerText.trim()])))
          .filter(row=>''' + json.dumps(list(EXPECTED)) + '''.includes(row.name))));
      };check();
    })''')


def require_policy(rows, key):
    matches = [row for row in rows if row['name'] == key]
    assert len(matches) == 1, 'Missing/duplicate policy: ' + key
    assert matches[0] == {
        'name': key, 'value': json.dumps(EXPECTED[key]), 'source': 'Platform',
        'scope': 'Machine', 'level': 'Mandatory', 'messages': 'OK',
    }, 'Policy not effective: ' + key


async def preferences(name):
    await navigate(name, 'chrome://settings')
    return await evaluate(name, '''new Promise(resolve=>
      chrome.settingsPrivate.getAllPrefs(p=>resolve(p.filter(pref=>'''
                          + json.dumps(list(PREFERENCES)) + '''.includes(pref.key)))))''')


def require_preference(prefs, key):
    matches = [pref for pref in prefs if pref['key'] == key]
    assert len(matches) == 1, 'Missing preference: ' + key
    pref = matches[0]
    assert (pref['value'] is False and pref.get('enforcement') == 'ENFORCED' and
            pref.get('controlledBy') == 'USER_POLICY'), 'Preference not enforced: ' + key


async def require_locked_preferences(name):
    prefs = await preferences(name)
    for key in PREFERENCES:
        require_preference(prefs, key)
        changed = await evaluate(name, '''new Promise(resolve=>
          chrome.settingsPrivate.setPref(''' + json.dumps(key) + ''',true,'',resolve))''')
        assert changed is False, 'Managed preference was writable: ' + key
    prefs = await preferences(name)
    for key in PREFERENCES:
        require_preference(prefs, key)


async def download_file(name):
    # Permit headless saving through the test-side debugger so policy, rather
    # than a headless default or missing user gesture, must block the fixture.
    # This setting is identical in the positive and policy-removal runs.
    await call(name, 'Browser.setDownloadBehavior', {
        'behavior': 'allow', 'downloadPath': '/profile/Downloads'})
    await navigate(name, 'data:text/html,<title>Synthetic download fixture</title>')
    result = await call(name, 'Runtime.evaluate', {
        'expression': '''(()=>{const a=document.createElement('a');
          a.href=URL.createObjectURL(new Blob([''' + json.dumps(CONTENT) + ''']));
          a.download=''' + json.dumps(FILENAME) + ''';document.body.append(a);a.click();})()''',
        'userGesture': True,
    })
    assert 'exceptionDetails' not in result, 'Download fixture failed'
    # The same bounded observation checks bytes in both images; the control
    # must actually save the marker, not merely report missing policy metadata.
    return json.loads(await command('exec', name, '/usr/bin/python3', '-B', '-c', '''
import json, time
from pathlib import Path
path = Path('/profile/Downloads/''' + FILENAME + '''')
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    if path.exists():
        print(json.dumps(path.read_text()))
        break
    time.sleep(.1)
else:
    print('null')
'''))


def require_no_download(content):
    assert content is None, 'Browser saved the synthetic download'


def expect_failure(assertion, *arguments):
    try:
        assertion(*arguments)
    except AssertionError:
        return
    raise AssertionError('Policy-removal control did not fail: ' + assertion.__name__)


async def derivative(image, root, removed, tags):
    policy = {key: value for key, value in EXPECTED.items() if key not in removed}
    context = root / ('control-' + str(len(tags)))
    context.mkdir()
    (context / 'policy.json').write_text(json.dumps(policy))
    tag = 'localhost/moss-policy-control:' + uuid.uuid4().hex
    tags.append(tag)
    await command('build', '--pull=never', '--tag', tag, '--file', '-', str(context),
                  data=(f'FROM {image}\nCOPY policy.json '
                        '/etc/chromium/policies/managed/moss.json\n').encode())
    installed = (await command('image', 'inspect', '--format', '{{.Id}}', tag)).decode().strip()
    return 'sha256:' + installed.removeprefix('sha256:')


async def require_sources(name, expected_policy):
    for installed, source in (('/opt/moss/runner.py', 'image/runner.py'),
                              ('/opt/moss/proxy.py', 'proxy.py')):
        assert await command('exec', name, 'cat', installed) == (ROOT / source).read_bytes()
    actual = await command('exec', name, 'cat', '/etc/chromium/policies/managed/moss.json')
    assert json.loads(actual) == expected_policy, 'Image policy differs from expected inputs'
    await navigate(name, 'chrome://sandbox')
    require_sandbox(await evaluate(name, 'document.body.innerText'))


async def verify(image):
    assert json.loads((ROOT / 'image/policy.json').read_text()) == EXPECTED
    with tempfile.TemporaryDirectory(prefix='moss-policy-', dir='/tmp') as directory:
        root = Path(directory)
        transport = root / 'transport'
        transport.mkdir(mode=0o700)
        seccomp = root / 'seccomp.json'
        seccomp.write_text(json.dumps(chromium_policy(json.loads(
            Path('/usr/share/containers/seccomp.json').read_text()))))
        inventory = Inventory(root / 'state')
        lock = ServiceLock(inventory.directory)
        engine = await asyncio.to_thread(Podman, image=image, seccomp=seccomp,
                                         transport_root=transport, service_lock=lock)
        runtime = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                          denied_networks=())
        ids, tags = [], []

        async def allocate(candidate, policy):
            runtime.engine = await asyncio.to_thread(
                Podman, image=candidate, seccomp=seccomp, transport_root=transport, service_lock=lock)
            runtime_id = str(uuid.uuid4())
            ids.append(runtime_id)
            await runtime.allocate(runtime_id, 1)
            name = engine.names(runtime_id)[0]
            await require_sources(name, policy)
            return runtime_id, name

        try:
            runtime_id, name = await allocate(image, EXPECTED)
            rows = await policy_rows(name)
            for key in EXPECTED:
                require_policy(rows, key)
            await require_locked_preferences(name)
            require_no_download(await download_file(name))
            print('PASS: nine mandatory policies, five locked preferences and blocked Blob download',
                  flush=True)
            await command('stop', '--time', '10', name)
            await runtime.allocate(runtime_id, 1)
            rows = await policy_rows(name)
            for key in EXPECTED:
                require_policy(rows, key)
            await require_locked_preferences(name)
            require_no_download(await download_file(name))
            print('PASS: effective policies and download denial persist after browser restart', flush=True)
            await runtime.remove(runtime_id, 2)

            control = await derivative(image, root, EXPECTED, tags)
            runtime_id, name = await allocate(control, {})
            rows, prefs = await policy_rows(name), await preferences(name)
            for key in EXPECTED:
                expect_failure(require_policy, rows, key)
            for key in PREFERENCES:
                expect_failure(require_preference, prefs, key)
            content = await download_file(name)
            assert content == CONTENT, 'Unmanaged control did not actually save the fixture'
            expect_failure(require_no_download, content)
            print('PASS: clearing policies fails all policy/preference assertions and saves fixture',
                  flush=True)
            await runtime.remove(runtime_id, 2)

            control = await derivative(image, root, {'DownloadRestrictions'}, tags)
            policy = {key: value for key, value in EXPECTED.items() if key != 'DownloadRestrictions'}
            runtime_id, name = await allocate(control, policy)
            rows = await policy_rows(name)
            for key in policy:
                require_policy(rows, key)
            await require_locked_preferences(name)
            content = await download_file(name)
            assert content == CONTENT, 'Download-only control did not save the fixture'
            expect_failure(require_no_download, content)
            print('PASS: removing only DownloadRestrictions fails the actual download assertion', flush=True)
        finally:
            runtime.engine = engine
            try:
                for runtime_id in ids:
                    await runtime.remove(runtime_id, 2)
            finally:
                await runtime.close()
                lock.close()
                for tag in tags:
                    await command('image', 'rm', tag)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='Installed immutable sha256 image ID')
    parser.add_argument('--engine-root')
    parser.add_argument('--engine-runroot')
    args = parser.parse_args()
    with engine_store(args.engine_root, args.engine_runroot):
        asyncio.run(verify(args.image))
