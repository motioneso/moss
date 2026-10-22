"""Candidate Chromium acceptance for the shared host infrastructure policy.

Uses real interfaces, DNS, public Microsoft TLS and Runtime/Podman/Egress.
Microsoft is deliberately reclassified as an ingress stand-in by trusted test
code. No Moss ingress, accounts, response interception or TLS bypass is used.
Controls omit Runtime's policy binding or only proactive tunnel closure.
"""
import argparse
import asyncio
import json
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch

from chromium_seccomp import chromium_policy
from egress import connect_host
from infrastructure import InfrastructurePolicy
from lifecycle import Inventory
from podman import Podman
from runtime import Runtime
from service_lock import ServiceLock
from verify_browser import PUBLIC, ROOT, evaluate, navigate
from verify_network import command
from verify_policies import EXPECTED, engine_store, require_sources


REDIRECT = 'https://microsoft.com/robots.txt'


def require_blocked(result, document_uri):
    assert result.get('errorText') == 'net::ERR_TUNNEL_CONNECTION_FAILED', \
        'Browser did not report host CONNECT denial'
    assert document_uri == 'chrome-error://chromewebdata/', 'Browser rendered the destination'


def require_closed(writers):
    assert writers and all(writer.is_closing() for writer in writers), \
        'Refresh left an old browser transport open'


def expect_failure(assertion, *args):
    try:
        assertion(*args)
    except AssertionError:
        return
    raise AssertionError('Protection removal did not fail the browser assertion')


async def visit(name, url=PUBLIC):
    # A fresh query avoids accepting cached content from the preceding visit.
    result = await navigate(name, url + '?moss-network-proof=' + uuid.uuid4().hex)
    uri = await evaluate(name, 'document.documentURI')
    return result, uri


async def require_public(name, url=PUBLIC):
    result, uri = await visit(name, url)
    assert 'errorText' not in result, 'Ordinary browser HTTPS failed'
    assert uri.startswith(PUBLIC), 'Public HTTPS document missing'
    return result, uri


async def verify(image):
    assert json.loads((ROOT / 'image/policy.json').read_text()) == EXPECTED
    with tempfile.TemporaryDirectory(prefix='moss-net-', dir='/tmp') as directory:
        root = Path(directory)
        transport = root / 'transport'
        transport.mkdir(mode=0o700)
        seccomp = root / 'seccomp.json'
        seccomp.write_text(json.dumps(chromium_policy(json.loads(
            Path('/usr/share/containers/seccomp.json').read_text()))))
        inventory = Inventory(root / 'state')
        lock = ServiceLock(inventory.directory)
        policy = InfrastructurePolicy(('192.0.2.0/24',), ['localhost'])
        policies = [policy]
        allocations = []
        runtimes = []
        try:
            assert await policy.refresh(), 'Initial host discovery failed'
            engine = await asyncio.to_thread(Podman, image=image, seccomp=seccomp,
                                             transport_root=transport, service_lock=lock)
            managed = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                              denied_networks=(), infrastructure=policy)
            runtimes.append(managed)

            async def allocate(runtime):
                runtime_id = str(uuid.uuid4())
                allocations.append((runtime, runtime_id))
                await runtime.allocate(runtime_id, 1)
                name = engine.names(runtime_id)[0]
                await require_sources(name, EXPECTED)
                actual = json.loads(await command('inspect', name))[0]
                assert actual['HostConfig']['NetworkMode'] == 'none'
                assert actual['HostConfig']['ReadonlyRootfs']
                assert not actual['HostConfig']['PortBindings']
                assert not actual['EffectiveCaps']
                return runtime_id, name

            runtime_id, name = await allocate(managed)
            assert await policy.refresh(), 'Pre-navigation host discovery failed'
            await require_public(name)
            await require_public(name, REDIRECT)
            print('PASS: candidate sources/sandbox, network-none and public Chromium TLS', flush=True)

            # Use the actual expiry timer and monotonic age, without changing
            # the policy clock or replacing discovery. No refresh loop runs in
            # this test until the explicit recovery below.
            remaining = max(0, policy.deadline - asyncio.get_running_loop().time())
            print('Observing the actual 60-second policy lifetime', flush=True)
            await asyncio.sleep(remaining + 0.1)
            assert policy.deadline == 0, 'Independent policy expiry did not run'
            require_blocked(*(await visit(name)))
            assert await policy.refresh(), 'Recovery host discovery failed'
            await require_public(name)
            print('PASS: actual policy expiry denies Chromium; real refresh restores public TLS', flush=True)

            proxy = managed.proxies[runtime_id]
            opened = tuple(writer for writer in proxy.writers if not writer.is_closing())
            assert opened, 'No live browser transport available for refresh assertion'
            # Test-only trusted reclassification. The installed service loads
            # all infrastructure names from its fixed config before listening.
            policy.hosts = ('localhost', 'www.microsoft.com')
            assert await policy.refresh(), 'Public ingress discovery failed'
            require_closed(opened)
            require_blocked(*(await visit(name)))
            print('PASS: real public ingress refresh closes browser transport and denies its hostname',
                  flush=True)

            # Observe the real parser without changing its result or upstream
            # responses. Both CONNECTs must occur, establishing that the public
            # redirect source succeeded before its target was denied.
            destinations = []

            def observe_connect(header):
                host = connect_host(header)
                destinations.append(host)
                return host

            with patch('egress.connect_host', side_effect=observe_connect):
                require_blocked(*(await visit(name, REDIRECT)))
            assert 'microsoft.com' in destinations, 'Redirect source CONNECT missing'
            assert 'www.microsoft.com' in destinations, 'Redirect target CONNECT missing'
            assert destinations.index('microsoft.com') < destinations.index('www.microsoft.com'), \
                'Redirect target was not requested after its source'
            print('PASS: real public HTTPS redirect reaches source and denies infrastructure target',
                  flush=True)

            # Retain discovered addresses but remove the direct hostname match.
            # This request must pass through destination DNS/address checks.
            policy.hosts = ('localhost',)
            assert await policy.refresh(), 'Address-only host discovery failed'
            require_blocked(*(await visit(name)))
            print('PASS: discovered ingress address denial still blocks Chromium without hostname match',
                  flush=True)

            # Same candidate and engine; only this trusted test runtime omits
            # the policy. The real service always supplies it (unit controls
            # cover both service and Runtime binding).
            control = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                              denied_networks=())
            runtimes.append(control)
            _, control_name = await allocate(control)
            result, uri = await require_public(control_name)
            expect_failure(require_blocked, result, uri)
            result, uri = await require_public(control_name, REDIRECT)
            expect_failure(require_blocked, result, uri)
            print('PASS: omitting host policy restores verified public TLS and fails the same browser denial',
                  flush=True)

            closure_policy = InfrastructurePolicy(('192.0.2.0/24',), ['localhost'])
            policies.append(closure_policy)
            assert await closure_policy.refresh(), 'Closure-control discovery failed'
            closure_runtime = Runtime(inventory=inventory, engine=engine, transport_root=transport,
                                      denied_networks=(), infrastructure=closure_policy)
            runtimes.append(closure_runtime)
            closure_id, closure_name = await allocate(closure_runtime)
            assert await closure_policy.refresh(), 'Closure-control pre-navigation discovery failed'
            await require_public(closure_name)
            closure_proxy = closure_runtime.proxies[closure_id]
            opened = tuple(writer for writer in closure_proxy.writers if not writer.is_closing())
            assert opened, 'No live control transport available'
            closure_policy.hosts = ('localhost', 'www.microsoft.com')
            # Remove only proactive tunnel closure; new CONNECTs still face the
            # live hostname/address/generation guards. Chromium must actually
            # reuse its old tunnel and render a fresh response after refresh.
            with patch.object(closure_proxy, 'close_connections'):
                assert await closure_policy.refresh(), 'Closure-control ingress discovery failed'
                expect_failure(require_closed, opened)
                result, uri = await require_public(closure_name)
                expect_failure(require_blocked, result, uri)
            closure_policy.invalidate()
            require_closed(opened)
            print('PASS: removing only tunnel closure preserves browser access; closure/denial assertions fail',
                  flush=True)
        finally:
            for policy in policies:
                policy.invalidate()
            try:
                for runtime, runtime_id in allocations:
                    await runtime.remove(runtime_id, 2)
            finally:
                for runtime in runtimes:
                    await runtime.close()
                lock.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='Installed immutable sha256 image ID')
    parser.add_argument('--engine-root')
    parser.add_argument('--engine-runroot')
    args = parser.parse_args()
    with engine_store(args.engine_root, args.engine_runroot):
        asyncio.run(verify(args.image))
