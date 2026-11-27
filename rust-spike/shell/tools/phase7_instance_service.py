#!/usr/bin/env python3
"""Native service lifecycle gate. A real server and private bundled database, no app launch."""
import argparse
import csv
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
import phase7_service_registration as registration


def command(args, check=True, **kwargs):
    print('COMMAND:', subprocess.list2cmdline([str(a) for a in args]), flush=True)
    result = subprocess.run([str(a) for a in args], **kwargs)
    print('EXIT:', result.returncode, flush=True)
    if check:
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


def assert_linux_restart_limit(launcher, scratch):
    """A real user unit whose database program is broken must stop retrying."""
    install = scratch / 'broken-programs'
    install.mkdir()
    broken_launcher = install / 'moss-launcher'
    shutil.copy2(launcher, broken_launcher)
    folder = scratch / 'broken-instance'
    (folder / 'database').mkdir(parents=True, mode=0o700)
    name = service_name(folder.resolve())
    def state():
        result = subprocess.run(['systemctl', '--user', 'show', name + '.service',
                                 '--property=ActiveState,Result,NRestarts,StartLimitBurst,StartLimitIntervalUSec'],
                                capture_output=True, text=True, check=True)
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    try:
        command([broken_launcher, 'service-start', folder])
        wait_for(lambda: state().get('ActiveState') == 'failed' and int(state().get('NRestarts', '0')) >= 3,
                 'broken database reaches the native restart limit', seconds=30)
        before = state()
        assert before['ActiveState'] == 'failed', before
        assert before['StartLimitBurst'] == '3', before
        assert before['StartLimitIntervalUSec'] == 'infinity', before
        time.sleep(6)
        after = state()
        assert after['NRestarts'] == before['NRestarts'], (before, after)
        print('PASS: broken database stays failed without more restarts:', after, flush=True)
    finally:
        # This fixture has no server, database process or firewall rule to remove.
        command([broken_launcher, 'service-stop', folder])
        unit = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'systemd/user' / (name + '.service')
        unit.unlink(missing_ok=True)
        command(['systemctl', '--user', 'daemon-reload'])
        command(['systemctl', '--user', 'reset-failed', name + '.service'], check=False)


def database_failure_summary(folder):
    """Only fixed labels and numeric OS codes: never dump credential-bearing DB output."""
    for relative in ('database', 'database/moss-db.lock', 'database/initdb-unfinished',
                     'database/db/PG_VERSION', 'database/logs/initdb.log', 'database/logs/postgres.log'):
        print('DATABASE CHECK:', relative, (folder / relative).exists(), flush=True)
    stages = ('crash-dump protection', 'Postgres bundle', 'lock file', 'initdb failed',
              'initdb:', 'superuser password', 'first-run marker', 'start postgres',
              'postgres exited during start', 'migrations:', 'private', 'elevated',
              'access', 'Access', 'denied', 'reparse', 'DACL', 'unambiguous',
              'backfill', 'not the version', 'row-level security policy', 'checksum')
    log = folder / 'database.log'
    if log.exists():
        for line in log.read_text(errors='replace').splitlines():
            try:
                value = json.loads(line)
            except ValueError:
                continue
            error = value.get('error', '')
            if isinstance(error, str):
                print('DATABASE ERROR LABELS:', [stage for stage in stages if stage in error],
                      'OS codes:', re.findall(r'os error (\d+)', error),
                      'migration files:', re.findall(r'\b[0-9]{4}_[a-z0-9_]+\.(?:sql|backfill\.mjs)\b', error),
                      flush=True)
    # initdb has not run schema SQL. Match fixed phrases only, never its arbitrary output.
    log = folder / 'database/logs/initdb.log'
    if log.exists():
        text = log.read_text(errors='replace').lower()
        labels = ('permission denied', 'access is denied', 'could not create', 'could not open',
                  'could not execute', 'no such file', 'not found', 'invalid locale',
                  'icu', 'error', 'fatal', 'success')
        print('INITDB LABELS:', [label for label in labels if label in text], flush=True)


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
    try:
        command([args.bin / 'examples' / ('instance-fixture' + suffix), install, folder, str(args.port)])
    except subprocess.CalledProcessError:
        database_failure_summary(folder)
        raise
    launcher = programs / ('moss-launcher' + suffix)
    name = service_name(folder.resolve())
    if os.name == 'nt':
        # Rust canonical paths use the extended-length prefix on Windows.
        name = service_name(Path(chr(92) * 2 + '?' + chr(92) + str(folder.resolve())))
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
    replayed = []
    def restart_registration():
        # Linux restarts the entire user service manager. launchd re-loads the saved login
        # agent. Windows replays the exact Task Scheduler read-back after verified shutdown.
        # Coordinator ruling: actual Windows logon remains the part 18 fresh-machine gate.
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
                # Killing the supervisor closes its database job, racing taskkill's walk of
                # those descendants. taskkill can report 128 after the whole tree is gone.
                # Keep that exit visible, then prove shutdown before replaying login.
                command(['taskkill.exe', '/PID', pid, '/T', '/F'], check=False)
                def action_down():
                    result = subprocess.run(['tasklist.exe', '/FI', f'PID eq {int(pid)}', '/FO', 'CSV', '/NH'],
                                            capture_output=True, text=True, check=True)
                    return not any(len(row) > 1 and row[1] == pid for row in csv.reader(result.stdout.splitlines()))
                wait_for(lambda: action_down() and database_down() and not answering(),
                         'logout ends service action, private database and HTTPS')
            action = registration.read_back(name, launcher, folder, enabled=not (folder / 'service-stopped').exists())
            assert action, 'Task Scheduler lost the server login task'
            print('COMMAND:', action['command_line'], flush=True)
            process = subprocess.Popen(action['command_line'], cwd=action['cwd'], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=0x00000008 | 0x00000200 | 0x08000000)
            replayed.append(process)
            if (folder / 'service-stopped').exists():
                assert process.wait(timeout=20) == 0, 'queued task did not respect Stop'
            print('PASS: replayed exact Task Scheduler action; real Windows logon deferred to part 18', flush=True)
    saved_login = args.scratch / 'queued-login.plist'
    app_login = None
    def independent_login_registration():
        return registration.read_back(name, launcher, folder)
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
                registration.register_app_task(name + '-app', launcher, args.scratch / 'app-data', args.scratch)
                app_login = 'task'
            print('NEGATIVE CONTROL: desktop app autostart registered; no server service', flush=True)
            assert independent_login_registration(), 'server login registration exists independently of app autostart'
            raise AssertionError('Negative control unexpectedly passed')
        if platform.system() == 'Darwin':
            shutil.copy2(Path.home() / 'Library/LaunchAgents' / (name + '.plist'), saved_login)
        command([launcher, 'service-stop', folder])
        wait_for(lambda: stopped() and database_down(), 'Stop shuts down server and private database')
        assert (folder / 'service-stopped').exists()
        command([launcher, 'service-stop', folder])
        if platform.system() == 'Darwin':
            plist = Path.home() / 'Library/LaunchAgents' / (name + '.plist')
            assert not plist.exists(), 'repeated Stop left the LaunchAgent plist behind'
        print('PASS: repeated Stop succeeds and leaves no macOS login plist', flush=True)
        # A queued login action cannot undo an explicit Stop, even if invoked directly.
        if args.local_lifecycle_only:
            command([launcher, 'service-run', folder])
        elif platform.system() == 'Darwin':
            command(['launchctl', 'bootstrap', f'gui/{os.getuid()}', saved_login])
            time.sleep(1)
            command(['launchctl', 'bootout', f'gui/{os.getuid()}/{name}'])
            print('PASS: replayed saved macOS login action still respects Stop', flush=True)
        else:
            restart_registration()
        time.sleep(3)
        assert stopped() and database_down(), 'login action undid Stop'
        print('PASS: Stop stays down across queued login action', flush=True)
        command([launcher, 'service-start', folder])
        wait_for(answering, 'explicit Start enables and starts again')
        if platform.system() == 'Linux':
            assert_linux_restart_limit(launcher, args.scratch)
        print('local lifecycle PASS (login restart not exercised)' if args.local_lifecycle_only else 'phase7_instance_service PASS', flush=True)
    finally:
        if not args.negative_app_only:
            command([launcher, 'service-remove', folder])
            registration.assert_removed(name)
            for process in replayed:
                assert process.wait(timeout=20) == 0
        if app_login == 'task':
            command(['schtasks.exe', '/Delete', '/TN', name + '-app', '/F'])
            registration.assert_removed(name + '-app')
        elif app_login is not None:
            app_login.unlink()
        shutil.rmtree(args.scratch)


if __name__ == '__main__':
    main()
