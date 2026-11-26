#!/usr/bin/env python3
"""phase7_sharing_firewall: a second client reaches the server only while sharing is on.

The probe server (network/examples/sharing_probe.rs) runs the production listener switch,
firewall rule code and turn-on order. The runner plays the owner's answer to the operating
system prompt with a scripted stand-in, and reads the operating system's own rule list back
with commands of its own. It asserts, in order:

  off at the start  -> second client refused, no rule
  prompt declined   -> second client refused, no rule, no record
  listener alone    -> still refused where a firewall is active (Linux)
  prompt approved   -> second client answered, rule present
  off               -> second client refused, rule gone
  foreign rules     -> a rule Moss did not create is never changed or deleted by on or off;
                       on Windows a rule that already holds Moss's name makes turning on refuse
  restart check     -> the live rule carries Moss's marker only while sharing is on
  uninstall         -> the instance's own cleanup removes a rule left open

The runner plants its foreign rules on ports no other rule uses, each with its own marker,
and deletes only its own plants, after checking that marker. Cleanup of a Moss rule deletes
only when the instance record's marker is found on the live rule.

--negative-swallow-remove makes the stand-in swallow the removal, so off leaves the rule behind.
The run must then fail at "rule is gone after off".
"""
import argparse
import json
import os
from pathlib import Path
import platform
import queue
import shutil
import socket
import shlex
import uuid
import subprocess
import sys
import threading

SYSTEM = platform.system()
SOCKET_FILTER = '/usr/libexec/ApplicationFirewall/socketfilterfw'
CLIENT = r'''
import socket, ssl, sys
host, port = sys.argv[1], int(sys.argv[2])
context = ssl.create_default_context()
context.check_hostname = False
context.verify_mode = ssl.CERT_NONE
try:
    with socket.create_connection((host, port), timeout=4) as raw:
        with context.wrap_socket(raw) as tls:
            tls.sendall(b"GET / HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n")
            data = b""
            while chunk := tls.recv(4096):
                data += chunk
    print("ANSWERED" if b"moss-probe" in data else "ODD")
except ConnectionRefusedError:
    print("REFUSED")
except (TimeoutError, socket.timeout):
    print("TIMEOUT")
except OSError as error:
    print("ERROR", type(error).__name__)
'''


def say(*parts):
    print(*parts, flush=True)


def run(args, check=True, **kwargs):
    say('COMMAND:', subprocess.list2cmdline([str(a) for a in args]))
    kwargs.setdefault("timeout", 30)
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True, **kwargs)
    say('EXIT:', result.returncode)
    if result.stdout.strip():
        say(result.stdout.strip()[:1500])
    if check and result.returncode:
        say(result.stderr.strip()[:1500])
        result.check_returncode()
    return result


def sudo(args, **kwargs):
    if SYSTEM == 'Windows' or os.geteuid() == 0:
        return run(args, **kwargs)
    return run(['sudo', '-n', *args], **kwargs)


def expect(condition, label):
    if not condition:
        raise AssertionError(label)
    say('PASS:', label)


def ufw_added():
    text = sudo(['ufw', 'show', 'added']).stdout
    expect(text.startswith('Added user rules'), 'ufw gave a readable rule listing')
    return [shlex.split(line) for line in text.splitlines() if line.startswith('ufw ')]


def remove_ufw_plant(port, marker):
    selected = [parts for parts in ufw_added() if parts[:3] == ['ufw', 'allow', f'{port}/tcp']]
    if not selected:
        return
    expect(all(parts == ['ufw', 'allow', f'{port}/tcp', 'comment', marker] for parts in selected),
           'every rule selected for cleanup carries the exact runner marker')
    sudo(['ufw', 'delete', 'allow', 'in', 'proto', 'tcp', 'to', 'any', 'port', str(port)])


def windows_rule(name):
    shown = run(['netsh', 'advfirewall', 'firewall', 'show', 'rule', f'name={name}', 'verbose'], check=False)
    if shown.returncode == 1 and shown.stdout.strip() == 'No rules match the specified criteria.':
        return None
    expect(shown.returncode == 0, 'Windows rule lookup succeeded')
    expect(shown.stdout.count('Rule Name:') == 1, 'Windows lookup returned exactly one rule')
    fields = {}
    for line in shown.stdout.splitlines():
        if ':' in line:
            key, value = line.split(':', 1)
            fields[key.strip()] = value.strip()
    expect(fields.get('Rule Name') == name, 'Windows returned the requested rule name')
    return fields


def windows_port_unused(port):
    text = run(['netsh', 'advfirewall', 'firewall', 'show', 'rule', 'name=all', 'verbose']).stdout
    return all(value.strip() != str(port) for line in text.splitlines() if ':' in line
               for key, value in [line.split(':', 1)] if key.strip() == 'LocalPort')


def remove_windows_plant(name, marker, port, program):
    fields = windows_rule(name)
    if fields is None:
        return
    expect(fields.get('Description') == marker and fields.get('LocalPort') == str(port)
           and fields.get('Program', '').lower() == str(program).lower(), 'Windows cleanup owns the exact rule')
    run(['netsh', 'advfirewall', 'firewall', 'delete', 'rule', f'name={name}',
         'protocol=TCP', f'localport={port}', f'program={program}'])


def mac_apps():
    text = sudo([SOCKET_FILTER, '--listapps']).stdout
    lines = text.strip().splitlines()
    expect(bool(lines), 'macOS returned an application listing')
    header = lines[0].strip()
    prefixes = ['ALF: total number of apps = ', 'Total number of apps = ']
    count = next((header[len(prefix):].strip() for prefix in prefixes if header.startswith(prefix)), '')
    expect(count.isdecimal(), 'macOS returned an application count')
    paths = []
    for line in lines[1:]:
        line = line.strip()
        if not line or line in ['(Allow incoming connections)', '(Block incoming connections)']:
            continue
        index, separator, path = line.partition(':')
        expect(separator and index.strip() == str(len(paths) + 1) and path.strip().startswith('/'),
               'macOS returned a numbered application path')
        paths.append(path.strip())
    expect(len(paths) == int(count), 'macOS listing is complete')
    return paths


class Probe:
    def __init__(self, binary, folder, cert, key, port, mode):
        env = dict(os.environ, MOSS_FIREWALL_STAND_IN=str(binary), PROBE_STAND_IN=mode)
        self.process = subprocess.Popen(
            [str(binary), '--folder', str(folder), '--listen', f'0.0.0.0:{port}',
             '--cert', str(cert), '--key', str(key)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.expect_line('ready')

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line.strip())

    def expect_line(self, prefix, seconds=180):
        line = self.lines.get(timeout=seconds)
        say('PROBE:', line)
        assert line.startswith(prefix), line
        return line

    def send(self, command, seconds=180):
        say('PROBE <-', command)
        self.process.stdin.write(command + '\n')
        self.process.stdin.flush()
        line = self.lines.get(timeout=seconds)
        say('PROBE ->', line)
        return line

    def stop(self):
        try:
            self.process.stdin.write('quit\n')
            self.process.stdin.flush()
            self.process.wait(timeout=20)
        except Exception:
            self.process.kill()


class World:
    """The second client and the operating system's own view of the rule."""

    def __init__(self, folder, binary, port):
        self.folder, self.binary, self.port = folder, binary, port
        self.plant_marker = "moss-runner-" + uuid.uuid4().hex
        self.other_name = self.plant_marker + "-other"
        self.other_program = binary.with_name("foreign-probe-" + uuid.uuid4().hex + binary.suffix)
        self.rule_name = f'moss-{folder.name}'
        self.cleanup_record = None
        self.namespace = None
        self.address = None
        self.planted_other = False
        self.planted_same_name = False
        self.planted_same_port = False

    def set_up_client(self):
        if SYSTEM == 'Linux':
            self.namespace = 'moss' + uuid.uuid4().hex[:8]
            self.veth = 'ms' + uuid.uuid4().hex[:7]
            self.peer = self.veth + 'p'
            sudo(['ip', 'netns', 'add', self.namespace])
            sudo(['ip', 'link', 'add', self.veth, 'type', 'veth', 'peer', 'name', self.peer])
            sudo(['ip', 'link', 'set', self.peer, 'netns', self.namespace])
            sudo(['ip', 'addr', 'add', '10.77.0.1/24', 'dev', self.veth])
            sudo(['ip', 'link', 'set', self.veth, 'up'])
            sudo(['ip', 'netns', 'exec', self.namespace, 'ip', 'addr', 'add', '10.77.0.2/24', 'dev', self.peer])
            sudo(['ip', 'netns', 'exec', self.namespace, 'ip', 'link', 'set', self.peer, 'up'])
            sudo(['ip', 'netns', 'exec', self.namespace, 'ip', 'link', 'set', 'lo', 'up'])
            self.address = '10.77.0.1'
        else:
            # A runner-local interface that is not loopback.
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect(('192.0.2.1', 9))
            self.address = probe.getsockname()[0]
            probe.close()
            expect(not self.address.startswith('127.'), f'the second client uses non-loopback address {self.address}')

    def tear_down_client(self):
        if self.namespace:
            sudo(['ip', 'netns', 'del', self.namespace], check=False)
            sudo(['ip', 'link', 'del', self.veth], check=False)

    def reach(self, host):
        code = CLIENT
        if self.namespace and host == self.address:
            args = ['ip', 'netns', 'exec', self.namespace, sys.executable, '-c', code, host, str(self.port)]
            result = sudo(args, check=False)
        else:
            result = run([sys.executable, '-c', code, host, str(self.port)], check=False)
        return result.stdout.strip()

    def second_client(self):
        return self.reach(self.address)

    def rule_present(self):
        if SYSTEM == 'Linux':
            out = sudo(['ufw', 'status']).stdout
            return f'{self.port}/tcp' in out
        if SYSTEM == 'Windows':
            record = self.moss_record() or self.cleanup_record
            if not record:
                return False
            rule = record['rule']
            fields = windows_rule(rule['name'])
            if fields is None:
                return False
            expect(fields.get('Description') == rule['token']
                   and fields.get('LocalPort') == str(rule['port'])
                   and fields.get('Program', '').lower() == str(rule['program']).lower(),
                   'the live Moss rule has its exact marker, port and program')
            return True
        return str(self.binary) in mac_apps()

    def moss_record(self):
        try:
            return json.loads((self.folder / 'firewall.json').read_text())
        except FileNotFoundError:
            return None

    def cleanup_moss_rule(self):
        """Deletes a Moss rule only when the record's marker is on the live rule."""
        record = self.moss_record() or self.cleanup_record
        if not record:
            say('CLEANUP: no Moss record, so no rule is deleted by the runner')
            return
        rule = record.get('rule', {})
        marker = rule.get('name', '')
        token = rule.get('token', '')
        if SYSTEM == 'Linux':
            if marker and token:
                remove_ufw_plant(rule['port'], marker)
        elif SYSTEM == 'Windows':
            if marker and token:
                remove_windows_plant(marker, token, rule['port'], rule['program'])
        elif rule.get('entry_added') is True and not record.get('preexisting'):
            if str(self.binary) in mac_apps():
                sudo([SOCKET_FILTER, '--remove', str(self.binary)])

    def remove_same_port_foreign(self):
        if self.planted_same_port:
            remove_ufw_plant(self.port, self.plant_marker + '-same-port')
            self.planted_same_port = False

    def remove_same_name_plant(self):
        if self.planted_same_name:
            remove_windows_plant(self.rule_name, self.plant_marker, self.port + 2, self.same_program)
            self.planted_same_name = False

    # Rules planted by someone else. Moss must leave every one of them alone.
    def plant_other(self):
        expect(not self.other_present(), 'foreign plant selector is unused')
        if SYSTEM == 'Windows':
            expect(windows_port_unused(self.port + 1), 'foreign plant port is unused')
            run(['netsh', 'advfirewall', 'firewall', 'add', 'rule', f'name={self.other_name}', 'dir=in',
                 'action=allow', 'protocol=TCP', f'localport={self.port + 1}', f'program={self.binary}',
                 f'description={self.plant_marker}', 'enable=yes'])
        elif SYSTEM == 'Linux':
            sudo(['ufw', 'allow', 'in', 'proto', 'tcp', 'to', 'any', 'port', str(self.port + 1),
                  'comment', self.plant_marker + '-other'])
        else:
            shutil.copy2(self.binary, self.other_program)
            sudo([SOCKET_FILTER, '--add', str(self.other_program)])
        self.planted_other = True

    def other_present(self):
        if SYSTEM == 'Windows':
            return windows_rule(self.other_name) is not None
        if SYSTEM == 'Linux':
            return any(parts[:3] == ['ufw', 'allow', f'{self.port + 1}/tcp'] for parts in ufw_added())
        return str(self.other_program) in mac_apps()

    def remove_other(self):
        if not self.planted_other:
            return
        if SYSTEM == 'Windows':
            remove_windows_plant(self.other_name, self.plant_marker, self.port + 1, self.binary)
        elif SYSTEM == 'Linux':
            remove_ufw_plant(self.port + 1, self.plant_marker + '-other')
        elif str(self.other_program) in mac_apps():
            sudo([SOCKET_FILTER, '--remove', str(self.other_program)])
        self.planted_other = False
        if self.other_program.exists():
            self.other_program.unlink()

    def plant_same_name(self):
        expect(windows_rule(self.rule_name) is None, 'bare-prefix plant name is unused')
        # No other rule may use the plant's port.
        expect(windows_port_unused(self.port + 2), 'same-name plant port is unused')
        self.same_program = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'notepad.exe')
        run(['netsh', 'advfirewall', 'firewall', 'add', 'rule', f'name={self.rule_name}', 'dir=in',
             'action=allow', 'protocol=TCP', f'localport={self.port + 2}', f'program={self.same_program}',
             f'description={self.plant_marker}', 'enable=yes'])
        self.planted_same_name = True

    def same_name_present(self):
        return windows_rule(self.rule_name) is not None

    def record_present(self):
        return (self.folder / 'firewall.json').exists()


def make_certificate(folder):
    openssl = shutil.which('openssl') or r'C:\Program Files\Git\usr\bin\openssl.exe'
    cert, key = folder / 'cert.pem', folder / 'key.pem'
    run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
         '-subj', '/CN=Moss probe', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
         '-keyout', key, '-out', cert])
    if SYSTEM != 'Windows':
        key.chmod(0o600)
    return cert, key


def firewalld_services(binary, scratch, port, negative):
    """Installer file exists, but runtime catalog lacks it: runtime must never reload."""
    folder = scratch / ('instance-fwd-' + uuid.uuid4().hex[:8])
    folder.mkdir(parents=True)
    folder.chmod(0o700)
    service, token = 'moss-' + folder.name, uuid.uuid4().hex
    xml = (f'<?xml version="1.0" encoding="utf-8"?>\n<service>\n'
           f'  <short>{service}</short>\n  <description>{token}</description>\n'
           f'  <port port="{port}" protocol="tcp"/>\n</service>\n')
    (folder / 'firewalld-service.json').write_text(json.dumps(
        {'service': service, 'token': token, 'port': port}))
    source = folder / (service + '.xml')
    source.write_text(xml)
    destination = Path('/etc/firewalld/services') / source.name
    probe = None
    planted = False
    cleanup_rule = None
    world = World(folder, binary, port)
    try:
        # A real lookup, not a prompt stand-in. Do not overwrite any preexisting definition.
        expect(sudo(['test', '-e', destination], check=False).returncode == 1,
               'the unloaded-service plant path is absent')
        sudo(['install', '-m', '644', source, destination])
        planted = True
        shown = run(['firewall-cmd', f'--info-service={service}', '--verbose'], check=False)
        expect(shown.returncode != 0, 'firewalld has not loaded the new service')
        cert, key = make_certificate(folder)
        world.set_up_client()
        probe = Probe(binary, folder, cert, key, port, 'approve')
        reply = probe.send('on')
        record = world.moss_record()
        cleanup_rule = record['rule'] if record else None
        expect('ServiceUnavailable' in reply, 'a missing runtime service reports the reinstall remedy')
        expect(world.reach('127.0.0.1') == 'ANSWERED', 'missing runtime service keeps local access')
        expect(world.second_client() != 'ANSWERED', 'missing runtime service keeps sharing loopback only')
        for permanent in [[], ['--permanent']]:
            assigned = sudo(['firewall-cmd', *permanent, '--list-services']).stdout.split()
            expect(service not in assigned, 'missing runtime service is never assigned to a zone')
        shown = run(['firewall-cmd', f'--info-service={service}', '--verbose'], check=False)
        expect(shown.returncode != 0, 'the application did not reload firewalld')
        expect(not world.moss_record()['confirmed'], 'missing service never confirms sharing intent')
        say('FIREWALLD UNLOADED SERVICE: PASS')
        # This is the installer's one-time provisioning step, never an application command.
        sudo(['firewall-cmd', '--reload'])
        expect(probe.send('off') == 'Ok(())', 'confirmed absent assignments clear the failed intent')
        probe.send('answer decline')
        expect('Declined' in probe.send('on'), 'firewalld prompt refused keeps sharing off')
        expect(world.second_client() != 'ANSWERED', 'firewalld refused prompt keeps loopback only')
        probe.send('answer approve-add-only' if negative else 'answer approve')
        expect(probe.send('on') == 'Ok(())', 'loaded service can be assigned after approval')
        expect(probe.send('restart-check') == 'true', 'restart silently confirms live firewalld token and port')
        expect(probe.send('restart-check-other-port') == 'false', 'firewalld restart refuses a changed current port')
        expect(world.second_client() == 'ANSWERED', 'loaded firewalld service admits the second client')
        expect(probe.send('off') == 'Ok(())', 'firewalld sharing turns off')
        expect(world.second_client() != 'ANSWERED', 'firewalld off binds loopback only')
        for permanent in [[], ['--permanent']]:
            assigned = sudo(['firewall-cmd', *permanent, '--list-services']).stdout.split()
            expect(service not in assigned, 'the firewall rule is gone after off')
        expect(sudo(['cat', destination]).stdout == xml, 'off preserves the unassigned installer service')
        probe.send('answer approve')
        expect(probe.send('on') == 'Ok(())', 'firewalld sharing turns on for uninstall proof')
        probe.stop()
        probe = None
        env = dict(os.environ, MOSS_FIREWALL_STAND_IN=str(binary), PROBE_STAND_IN='approve')
        run([binary, 'firewall-close', '--instance', folder], env=env)
        for permanent in [[], ['--permanent']]:
            expect(service not in sudo(['firewall-cmd', *permanent, '--list-services']).stdout.split(),
                   'instance cleanup leaves no firewalld assignment')
        say('FIREWALLD LOADED SERVICE: PASS')
    finally:
        if probe:
            probe.stop()
        world.tear_down_client()
        if planted:
            # Off's negative control may have erased the record. Use its saved identity, but
            # still require live file/runtime marker checks in the real privileged helper.
            assigned = [service in sudo(['firewall-cmd', *permanent, '--list-services']).stdout.split()
                        for permanent in [[], ['--permanent']]]
            if any(assigned):
                expect(cleanup_rule is not None, 'cleanup has the rule identity captured before off')
                sudo([binary, 'firewall-rule', 'remove', '--name', cleanup_rule['name'],
                      '--port', str(port), '--program', binary, '--zone', cleanup_rule['zone'],
                      '--token', token, '--manager', 'firewalld', '--service', service])
                for permanent in [[], ['--permanent']]:
                    expect(service not in sudo(['firewall-cmd', *permanent, '--list-services']).stdout.split(),
                           'marker-checked cleanup removed the runner assignment')
            # This runner owns only the exact file it planted, never an installer/foreign file.
            expect(sudo(['cat', destination]).stdout == xml, 'the service file still has the runner marker and port')
            sudo(['rm', destination])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bin', required=True)
    parser.add_argument('--scratch', required=True)
    parser.add_argument('--port', type=int, default=5198)
    parser.add_argument('--negative-swallow-remove', action='store_true')
    parser.add_argument('--firewalld-services', action='store_true')
    args = parser.parse_args()
    suffix = '.exe' if SYSTEM == 'Windows' else ''
    binary = (Path(args.bin) / 'examples' / f'sharing_probe{suffix}').resolve()
    scratch = Path(args.scratch)
    shutil.rmtree(scratch, ignore_errors=True)
    if args.firewalld_services:
        expect(SYSTEM == 'Linux', 'firewalld proof runs on Linux')
        scratch.mkdir(parents=True)
        firewalld_services(binary, scratch, args.port, args.negative_swallow_remove)
        return
    folder = scratch / 'instance-sharing-proof'
    folder.mkdir(parents=True)
    if SYSTEM != 'Windows':
        folder.chmod(0o700)
    cert, key = make_certificate(folder)
    world = World(folder, binary, args.port)
    if world.rule_present():
        say('FAIL: the runner is not clean, a rule is already open for this test')
        sys.exit(1)
    probe = None
    try:
        if SYSTEM == 'Linux':
            status = sudo(['ufw', 'status', 'verbose']).stdout
            expect('Status: active' in status and 'deny (incoming)' in status, 'the Linux firewall is active and denies incoming connections')
        world.set_up_client()
        probe = Probe(binary, folder, cert, key, args.port, 'decline')
        expect(world.reach('127.0.0.1') == 'ANSWERED', 'sharing off: this computer still reaches the server')
        expect(world.second_client() != 'ANSWERED', 'sharing off at the start: the second client is refused')
        expect(not world.rule_present(), 'sharing off at the start: no firewall rule exists')

        reply = probe.send('on')
        expect('Declined' in reply, 'the declined prompt is reported as refused')
        expect(world.second_client() != 'ANSWERED', 'prompt refused: the second client is refused')
        expect(not world.rule_present() and not world.record_present(), 'prompt refused: no rule and no record')
        expect(world.reach('127.0.0.1') == 'ANSWERED', 'prompt refused: this computer still reaches the server')
        expect(probe.send('restart-check') == 'false', 'prompt refused: a restart would not listen beyond loopback')

        if SYSTEM == 'Linux':
            probe.send('listener-on')
            expect(world.second_client() != 'ANSWERED', 'an open listener without the rule: the firewall still refuses')
            probe.send('listener-off')

        # Rules Moss did not create.
        world.plant_other()
        expect(world.other_present(), 'a rule planted by someone else is in the firewall')
        if SYSTEM == 'Windows':
            world.plant_same_name()
            probe.send('answer approve')
            expect(probe.send('on') == 'Ok(())', 'a rule holding only the bare prefix: sharing turns on with its own marker')
            expect(world.same_name_present(), 'the bare-prefix rule is untouched after on')
            expect(probe.send('off') == 'Ok(())', 'a rule holding only the bare prefix: sharing turns off')
            expect(world.same_name_present(), 'the bare-prefix rule is untouched after off')
            expect(not world.rule_present(), "Moss's marked rule is gone after off and only the plant remains")
            world.remove_same_name_plant()
            expect(not world.same_name_present(), 'the planted same-name rule is cleaned up')
            probe.send('answer decline')
        if SYSTEM == 'Linux':
            sudo(['ufw', 'allow', 'in', 'proto', 'tcp', 'to', 'any', 'port', str(args.port),
                  'comment', world.plant_marker + '-same-port'])
            world.planted_same_port = True
            probe.send('answer approve')
            expect(probe.send('on') == 'Ok(())', 'a rule that already opens the port: sharing turns on')
            expect(probe.send('off') == 'Ok(())', 'a rule that already opens the port: sharing turns off')
            expect(world.rule_present(), 'a rule that was open before Moss is still open after off')
            world.remove_same_port_foreign()
            expect(not world.rule_present(), "the runner's own same-port plant is cleaned up by its marker")
            probe.send('answer decline')

        # The negative control approves adding but swallows removal.
        probe.send('answer approve-add-only' if args.negative_swallow_remove else 'answer approve')
        expect(probe.send('on') == 'Ok(())', 'prompt approved: sharing turns on')
        expect(world.rule_present(), 'prompt approved: the operating system lists the rule')
        expect(world.record_present(), 'prompt approved: the instance records the rule')
        if SYSTEM == 'Linux' and os.geteuid() != 0:
            expect(probe.send('restart') == 'paused', 'unprivileged ufw restart pauses without an authorization prompt')
            before = world.moss_record()
            expect(before['paused'] and world.rule_present(), 'paused restart keeps the live rule and its token')
            expect(world.second_client() != 'ANSWERED', 'paused restart binds loopback only')
            probe.send('answer decline')
            expect('Declined' in probe.send('on'), 'declined Resume stays paused')
            expect(world.moss_record() == before, 'declined Resume preserves the whole record')
            expect(world.second_client() != 'ANSWERED', 'declined Resume does not open the listener')
            probe.send('answer approve-add-only' if args.negative_swallow_remove else 'answer approve')
            expect(probe.send('on') == 'Ok(())', 'Resume verifies the real live marker through the authorized helper')
            expect(not world.moss_record()['paused'], 'confirmed Resume clears paused state')
        else:
            expect(probe.send('restart-check') == 'true', 'sharing on: a silent restart finds the live marker and may share')
        expect(probe.send('restart-check-other-port') == 'false', 'a restart on a changed port refuses the old live rule')
        expect(world.second_client() == 'ANSWERED', 'sharing on: the second client is answered')
        expect(world.reach('127.0.0.1') == 'ANSWERED', 'sharing on: this computer is answered')

        world.cleanup_record = world.moss_record()
        expect(probe.send('off') == 'Ok(())', 'sharing turns off')
        expect(world.second_client() != 'ANSWERED', 'after off: the second client is refused')
        expect(world.reach('127.0.0.1') == 'ANSWERED', 'after off: this computer still reaches the server')
        expect(not world.rule_present(), 'the firewall rule is gone after off')
        expect(not world.record_present(), 'the instance record is gone after off')
        world.cleanup_record = None
        expect(probe.send('restart-check') == 'false', 'after off: a restart would not listen beyond loopback')
        expect(world.other_present(), 'a rule planted by someone else survives on and off')

        probe.send('answer approve')
        expect(probe.send('on') == 'Ok(())', 'sharing turns on again')
        expect(world.rule_present(), 'the rule is back')
        world.cleanup_record = world.moss_record()
        probe.stop()
        probe = None
        # What uninstalling an instance runs after its server has stopped.
        env = dict(os.environ, MOSS_FIREWALL_STAND_IN=str(binary), PROBE_STAND_IN='approve')
        cleanup = subprocess.run([str(binary), 'firewall-close', '--instance', str(folder)], env=env)
        say('EXIT:', cleanup.returncode)
        expect(cleanup.returncode == 0, 'instance cleanup succeeds')
        expect(not world.rule_present() and not world.record_present(), 'no rule stays behind after instance cleanup')
        say('PHASE7 SHARING FIREWALL: PASS')
    except AssertionError as failure:
        say('FAIL:', failure)
        sys.exit(1)
    finally:
        if probe:
            probe.stop()
        failures = []
        for cleanup in [world.cleanup_moss_rule, world.remove_same_port_foreign,
                        world.remove_same_name_plant, world.remove_other, world.tear_down_client]:
            try:
                cleanup()
            except Exception as failure:
                failures.append(str(failure))
        if failures:
            raise AssertionError('Cleanup refused: ' + '; '.join(failures))


if __name__ == '__main__':
    main()
