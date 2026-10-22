"""Executable synthetic proof. Requires a port reserved with devports, not production."""
import argparse
import json
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from broker import Broker, Denied
from runtime import Runtime, command


def verify(port):
    runtime = Runtime()
    broker = None
    checks = []

    def passed(name):
        checks.append(name)
        print('PASS:', name, flush=True)

    try:
        alex, sam = runtime.create(), runtime.create()
        assert runtime.evaluate(alex, 'localStorage.getItem("marker")') is None
        assert runtime.evaluate(sam, 'localStorage.getItem("marker")') is None
        runtime.evaluate(alex, 'localStorage.setItem("marker","alex-synthetic")')
        runtime.evaluate(sam, 'localStorage.setItem("marker","sam-synthetic")')
        assert runtime.evaluate(alex, 'localStorage.getItem("marker")') == 'alex-synthetic'
        assert runtime.evaluate(sam, 'localStorage.getItem("marker")') == 'sam-synthetic'
        passed('independent browser localStorage on the same synthetic origin')

        for ns in ['pid', 'mnt', 'net']:
            a = command('exec', alex, 'readlink', f'/proc/1/ns/{ns}').stdout.strip()
            b = command('exec', sam, 'readlink', f'/proc/1/ns/{ns}').stdout.strip()
            assert a != b, ns
        passed('distinct PID, mount and network namespaces')

        inspect = json.loads(command('inspect', alex).stdout)[0]
        assert inspect['HostConfig']['ReadonlyRootfs']
        assert not inspect['HostConfig']['PortBindings']
        assert inspect['HostConfig']['NetworkMode'] == 'none'
        assert not inspect['EffectiveCaps']
        mounts = inspect['Mounts']
        assert all(m['Destination'] == '/profile' for m in mounts if m['Type'] == 'volume')
        assert not any(m['Type'] == 'bind' for m in mounts)
        passed('read-only root, no published ports, no network, no effective capabilities or host binds')

        def sandbox_status(key):
            runtime.call(key, 'Page.navigate', {'url': 'chrome://sandbox'})
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    status = runtime.evaluate(key, 'document.body.innerText')
                    if 'Seccomp-BPF sandbox' in status:
                        return status
                except (subprocess.CalledProcessError, RuntimeError):
                    pass
                time.sleep(.25)
            raise AssertionError('sandbox diagnostics did not load')

        def require_sandbox(status):
            assert re.search(r'Layer 1 Sandbox\s+Namespace', status)
            assert re.search(r'PID namespaces\s+Yes', status)
            assert re.search(r'Network namespaces\s+Yes', status)
            assert re.search(r'Seccomp-BPF sandbox\s+Yes', status)
            assert 'You are adequately sandboxed.' in status

        require_sandbox(sandbox_status(alex))
        runtime.call(alex, 'Page.navigate', {'url': 'http://127.0.0.1:8080'})
        runtime.ready(alex)
        unsafe = runtime.create(negative_control_no_sandbox=True)
        try:
            status = sandbox_status(unsafe)
            try:
                require_sandbox(status)
            except AssertionError:
                pass
            else:
                raise AssertionError('sandbox check did not fail with --no-sandbox')
        finally:
            runtime.destroy(unsafe)
        passed('Chromium namespace/seccomp sandbox diagnostics pass; fail with --no-sandbox')

        broker = Broker(runtime, port)
        token = broker.session('alex')
        other = broker.session('sam')
        admin = broker.session('admin')  # Deliberately no privileged bypass in this fixture.
        broker.connections['source'] = {'owner': 'alex', 'runtime': alex,
                                         'active': True, 'generation': 1}
        viewer = broker.attach(token, 'source')
        try:
            broker.attach(token, 'source')
            raise AssertionError('second controller accepted')
        except Denied:
            pass
        passed('one active synthetic controller per connection')

        def request(session=token, origin=None, text=None, path=None):
            headers = {'Origin': origin or broker.origin, 'Cookie': 'probe_session=' + session}
            data = None if text is None else json.dumps({'text': text}).encode()
            if data is not None:
                headers['Content-Type'] = 'application/json'
            url = broker.origin + (path or f'/{"frame" if text is None else "input"}/{viewer}')
            try:
                with urlopen(Request(url, headers=headers, data=data), timeout=10) as response:
                    return response.status, response.read(), response.headers
            except HTTPError as error:
                return error.code, error.read(), error.headers

        code, image, headers = request()
        assert code == 200 and image[:2] == b'\xff\xd8'
        assert headers['Cache-Control'] == 'no-store'
        assert request(text='synthetic typing')[0] == 200
        assert runtime.evaluate(alex, 'document.querySelector("#entry").value') == 'synthetic typing'
        assert runtime.evaluate(sam, 'document.querySelector("#entry").value') == ''
        passed('authenticated frame fetch and input reach only the selected real browser')
        assert request(session='missing')[0] == 403
        assert request(path='/frame/not-a-viewer')[0] == 403
        assert request(text='x' * 129)[0] == 403
        passed('missing session, invented viewer and oversized input refused')

        def negative(name, mutate, restore, **kwargs):
            mutate()
            assert request(**kwargs)[0] == 403, name
            broker.disabled.add(name)
            try:
                # The same denied request MUST succeed when its protection is removed.
                assert request(**kwargs)[0] == 200, 'negative control did not expose ' + name
            finally:
                broker.disabled.clear()
                restore()
            passed('denial plus protection-removed negative control: ' + name)

        # Give the other sessions this synthetic viewer's id to isolate ownership enforcement
        # from the independent viewer-to-session guard.
        broker.disabled.add('viewer_session')
        assert request(session=other)[0] == 403
        assert request(session=admin)[0] == 403
        broker.disabled.add('owner')
        assert request(session=other)[0] == 200
        assert request(session=admin)[0] == 200
        broker.disabled.clear()
        passed('other user and admin denied, both exposed when ownership protection removed')

        negative('origin', lambda: None, lambda: None, origin='https://invalid.example')
        negative('session', lambda: broker.sessions[token].update(active=False),
                 lambda: broker.sessions[token].update(active=True))
        expiry = broker.sessions[token]['expires']
        negative('session', lambda: broker.sessions[token].update(expires=0),
                 lambda: broker.sessions[token].update(expires=expiry))
        negative('generation', lambda: broker.connections['source'].update(generation=2),
                 lambda: broker.connections['source'].update(generation=1))
        negative('active', lambda: broker.connections['source'].update(active=False),
                 lambda: broker.connections['source'].update(active=True))
        lease = broker.views[viewer]['expires']
        negative('lease', lambda: broker.views[viewer].update(expires=0),
                 lambda: broker.views[viewer].update(expires=lease))
        second_session = broker.session('alex')
        negative('viewer_session', lambda: None, lambda: None, session=second_session)

        # Flush the profile via Chromium's ordinary shutdown before restart.
        try:
            runtime.call(alex, 'Browser.close')
        except subprocess.CalledProcessError:
            pass  # Chrome may close the command socket before its reply is read.
        runtime.restart(alex)
        assert runtime.evaluate(alex, 'localStorage.getItem("marker")') == 'alex-synthetic'
        passed('profile survives graceful browser/container restart')
        volume = runtime.resources[alex]
        broker.connections['source']['active'] = False
        assert request()[0] == 403
        runtime.destroy(alex)
        assert command('container', 'exists', alex, check=False).returncode != 0
        assert command('volume', 'exists', volume, check=False).returncode != 0
        passed('disconnect refuses access and removes its container and persistent volume')
        return checks
    finally:
        if broker:
            broker.close()
        runtime.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()
    if not 5180 <= args.port <= 5299:
        parser.error('use a devports reservation in 5180–5299')
    completed = verify(args.port)
    print(json.dumps({'passed': len(completed), 'scope': 'synthetic runtime only'}))
