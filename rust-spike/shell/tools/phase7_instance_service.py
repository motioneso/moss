#!/usr/bin/env python3
"""Native service lifecycle gate. A real server and private bundled database, no app launch."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import ssl
import subprocess
import time
import urllib.request
import html


def command(args, **kwargs):
    print('COMMAND:', subprocess.list2cmdline([str(a) for a in args]), flush=True)
    result = subprocess.run([str(a) for a in args], **kwargs)
    print('EXIT:', result.returncode, flush=True)
    result.check_returncode()
    return result


def wait_for(assertion, label, seconds=210):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if assertion():
            print('PASS:', label, flush=True)
            return
        time.sleep(.5)
    raise AssertionError(label)


def service_name(folder):
    value = 0xcbf29ce484222325
    for byte in str(folder).encode():
        value = ((value ^ byte) * 0x100000001b3) & ((1 << 64) - 1)
    return f'moss-server-{value:016x}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin', type=Path, required=True)
    parser.add_argument('--postgres', type=Path, required=True)
    parser.add_argument('--scratch', type=Path, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--negative-app-only', action='store_true')
    parser.add_argument('--local-lifecycle-only', action='store_true', help='Never restart the live user manager; not the full CI login gate')
    args = parser.parse_args()
    assert args.local_lifecycle_only or os.environ.get('GITHUB_ACTIONS') == 'true', 'Manager restart is allowed only on disposable CI runners; use --local-lifecycle-only on this box'
    assert os.environ.get('RUSTUP_HOME'), 'Set RUSTUP_HOME explicitly'
    assert args.scratch.is_absolute() and not args.scratch.exists(), 'Use a new task-owned scratch folder'
    repo = Path(__file__).resolve().parents[3]
    args.scratch.mkdir(parents=True)
    suffix = '.exe' if os.name == 'nt' else ''
    dist = args.scratch / 'staged'
    dist.mkdir()
    for name in ('moss-app', 'moss-server', 'moss-db', 'moss-launcher'):
        shutil.copy2(args.bin / (name + suffix), dist / (name + suffix))
    shutil.copytree(args.postgres, dist / 'postgres', symlinks=True)
    (dist / 'web').mkdir()
    (dist / 'web/index.html').write_text('<!doctype html><title>Moss service proof</title>')
    source = (repo / 'rust-spike/bundled-db/src/migrate.rs').read_text()
    folders = re.search(r'pub const FOLDERS:.*?= \[(.*?)\];', source, re.S)[1]
    schema = re.findall(r'"([^"]+)"', folders)
    schema += [re.search(r'const BOOTSTRAP: &str = "([^"]+)";', source)[1]]
    for folder in schema:
        target = dist / 'schema' / folder
        target.mkdir(parents=True)
        for file in (repo / folder).iterdir():
            if file.is_file() and file.suffix in ('.sql', '.mjs'):
                shutil.copy2(file, target / file.name)
    if os.name == 'nt':
        openssl = Path(r'C:\Program Files\Git\mingw64\bin')
        if not (openssl / 'openssl.exe').is_file():
            openssl = Path(r'C:\Program Files\Git\usr\bin')
        (dist / 'openssl').mkdir()
        for file in [openssl / 'openssl.exe', *openssl.glob('*.dll')]:
            shutil.copy2(file, dist / 'openssl' / file.name)
        (dist / 'openssl/openssl.cnf').write_text('# Default provider only\n')
    spec = importlib.util.spec_from_file_location('install_version', Path(__file__).with_name('install-version.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    programs = args.scratch / 'programs with spaces'
    old = module.install_version(dist, programs, '7.0.0')
    install = module.install_version(dist, programs, '7.1.0')
    assert old.is_dir() and (programs / 'current').read_text().strip() == '7.1.0'
    print('PASS: side-by-side versions retained and current selected', flush=True)
    folder = args.scratch / 'instance with spaces'
    command([args.bin / 'examples' / ('instance-fixture' + suffix), install, folder, str(args.port)])
    launcher = programs / ('moss-launcher' + suffix)
    name = service_name(folder.resolve())
    if os.name == 'nt':
        # Rust canonical paths use the extended-length prefix on Windows.
        name = service_name(Path('\\\\?\\' + str(folder.resolve())))
    url = f'https://127.0.0.1:{args.port}/api/hello'
    def answering():
        try:
            with urllib.request.urlopen(url, context=ssl._create_unverified_context(), timeout=2) as response:
                return response.status == 200 and json.load(response)['api']['current'] == 1
        except (OSError, ValueError):
            return False
    def stopped():
        return not folder.joinpath('running.json').exists() and not answering()
    def database_down():
        result = subprocess.run([str(install / ('moss-db' + suffix)), 'status', '--root', str(folder / 'database')], capture_output=True)
        return not json.loads(result.stdout).get('supervisor_pid')
    def restart_registration():
        # Linux restarts the entire user service manager. launchd re-loads the saved login
        # agent. Windows runs its own login startup processor after ending the old action.
        if platform.system() == 'Linux':
            command(['sudo', 'systemctl', 'restart', f'user@{os.getuid()}.service'])
        elif platform.system() == 'Darwin':
            domain = f'gui/{os.getuid()}'
            if subprocess.run(['launchctl', 'print', f'{domain}/{name}'], capture_output=True).returncode == 0:
                command(['launchctl', 'bootout', f'{domain}/{name}'])
            time.sleep(2)
            command(['launchctl', 'bootstrap', domain, Path.home() / 'Library/LaunchAgents' / (name + '.plist')])
        else:
            if not (stopped() and database_down()):
                pid = (folder / 'service.pid').read_text().strip()
                command(['taskkill.exe', '/PID', pid, '/T', '/F'])
                wait_for(database_down, 'logout ends private database')
            command(['runonce.exe', '/AlternateShellStartup'])
    app_login = None
    def independent_login_registration():
        if platform.system() == 'Linux':
            return subprocess.run(['systemctl', '--user', 'is-enabled', name + '.service'], capture_output=True).returncode == 0
        if platform.system() == 'Darwin':
            return (Path.home() / 'Library/LaunchAgents' / (name + '.plist')).is_file()
        return subprocess.run(['reg.exe', 'query', r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run', '/v', name], capture_output=True).returncode == 0
    try:
        if not args.negative_app_only:
            command([launcher, 'service-start', folder])
            assert independent_login_registration(), 'server login registration exists independently of app autostart'
            wait_for(answering, 'service brings up real HTTPS and database without app')
            before = json.loads((folder / 'running.json').read_text())['pid']
            if not args.local_lifecycle_only:
                restart_registration()
                wait_for(lambda: answering() and json.loads((folder / 'running.json').read_text())['pid'] != before,
                         'server returns after service manager restart without app')
        else:
            # Install only the actual desktop-app login entry. The same independent-server
            # assertion must fail; an app opening a window is never enough to satisfy this gate.
            launch = f'"{launcher}" moss-app --data "{args.scratch / "app-data"}"'
            if platform.system() == 'Linux':
                app_login = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'autostart' / (name + '-app.desktop')
                app_login.parent.mkdir(parents=True, exist_ok=True)
                app_login.write_text('[Desktop Entry]\nType=Application\nName=Moss app negative control\nExec=' + launch + '\n')
            elif platform.system() == 'Darwin':
                app_login = Path.home() / 'Library/LaunchAgents' / (name + '-app.plist')
                app_login.parent.mkdir(parents=True, exist_ok=True)
                app_login.write_text('<plist version="1.0"><dict><key>Label</key><string>' + name + '-app</string><key>ProgramArguments</key><array><string>' + html.escape(str(launcher)) + '</string><string>moss-app</string></array><key>RunAtLoad</key><true/></dict></plist>')
            else:
                command(['reg.exe', 'add', r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run', '/v', name + '-app', '/t', 'REG_SZ', '/d', launch, '/f'])
                app_login = 'registry'
            print('NEGATIVE CONTROL: desktop app autostart registered; no server service', flush=True)
            assert independent_login_registration(), 'server login registration exists independently of app autostart'
            raise AssertionError('Negative control unexpectedly passed')
        command([launcher, 'service-stop', folder])
        wait_for(lambda: stopped() and database_down(), 'Stop shuts down server and private database')
        assert (folder / 'service-stopped').exists()
        # A queued login action cannot undo an explicit Stop, even if invoked directly.
        if args.local_lifecycle_only:
            command([launcher, 'service-run', folder])
        else:
            restart_registration()
        time.sleep(3)
        assert stopped() and database_down(), 'login action undid Stop'
        print('PASS: Stop stays down across queued login action', flush=True)
        command([launcher, 'service-start', folder])
        wait_for(answering, 'explicit Start enables and starts again')
        print('local lifecycle PASS (login restart not exercised)' if args.local_lifecycle_only else 'phase7_instance_service PASS', flush=True)
    finally:
        if not args.negative_app_only:
            command([launcher, 'service-remove', folder])
        if app_login == 'registry':
            command(['reg.exe', 'delete', r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run', '/v', name + '-app', '/f'])
        elif app_login is not None:
            app_login.unlink()
        shutil.rmtree(args.scratch)


if __name__ == '__main__':
    main()
