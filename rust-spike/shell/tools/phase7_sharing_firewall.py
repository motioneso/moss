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
        self.rule_name = f'moss-{folder.name}'
        self.namespace = None
        self.address = None
        self.planted_other = False
        self.planted_same_name = False
        self.planted_same_port = False

    def set_up_client(self):
        if SYSTEM == 'Linux':
            self.namespace = 'mossclient'
            sudo(['ip', 'netns', 'del', self.namespace], check=False)
            sudo(['ip', 'link', 'del', 'vmoss0'], check=False)
            sudo(['ip', 'netns', 'add', self.namespace])
            sudo(['ip', 'link', 'add', 'vmoss0', 'type', 'veth', 'peer', 'name', 'vmoss1'])
            sudo(['ip', 'link', 'set', 'vmoss1', 'netns', self.namespace])
            sudo(['ip', 'addr', 'add', '10.77.0.1/24', 'dev', 'vmoss0'])
            sudo(['ip', 'link', 'set', 'vmoss0', 'up'])
            sudo(['ip', 'netns', 'exec', self.namespace, 'ip', 'addr', 'add', '10.77.0.2/24', 'dev', 'vmoss1'])
            sudo(['ip', 'netns', 'exec', self.namespace, 'ip', 'link', 'set', 'vmoss1', 'up'])
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
            sudo(['ip', 'link', 'del', 'vmoss0'], check=False)

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
            out = sudo(['ufw', 'status'], check=False).stdout
            return f'{self.port}/tcp' in out
        if SYSTEM == 'Windows':
            shown = run(['netsh', 'advfirewall', 'firewall', 'show', 'rule', 'name=all', 'verbose'], check=False).stdout
            block = ''
            for line in shown.splitlines() + ['Rule Name: end']:
                if line.startswith('Rule Name:'):
                    first = block.splitlines()[0] if block else ''
                    name = first.split(':', 1)[1].strip() if ':' in first else ''
                    # Only Moss's marker name counts, never the runner's bare-prefix plant.
                    if name.startswith(f'{self.rule_name}-') and str(self.port) in block and 'sharing_probe' in block:
                        return True
                    block = line + '\n'
                else:
                    block += line + '\n'
            return False
        out = sudo([SOCKET_FILTER, '--listapps'], check=False).stdout
        return 'sharing_probe' in out

    def moss_record(self):
        try:
            return json.loads((self.folder / 'firewall.json').read_text())
        except Exception:
            return None

    def cleanup_moss_rule(self):
        """Deletes a Moss rule only when the record's marker is on the live rule."""
        record = self.moss_record()
        if not record:
            say('CLEANUP: no Moss record, so no rule is deleted by the runner')
            return
        rule = record.get('rule', {})
        marker = rule.get('name', '')
        token = rule.get('token', '')
        if SYSTEM == 'Linux':
            added = sudo(['ufw', 'show', 'added'], check=False).stdout
            lines = [line for line in added.splitlines() if f'{self.port}/tcp' in line]
            if marker and any(marker in line for line in lines):
                sudo(['ufw', 'delete', 'allow', 'in', 'proto', 'tcp', 'to', 'any', 'port', str(self.port)], check=False)
            else:
                say('CLEANUP: no Moss marker on the live rule, so nothing is deleted')
        elif SYSTEM == 'Windows':
            shown = run(['netsh', 'advfirewall', 'firewall', 'show', 'rule', f'name={marker}', 'verbose'], check=False)
            if token and token in shown.stdout:
                run(['netsh', 'advfirewall', 'firewall', 'delete', 'rule', f'name={marker}'], check=False)
            else:
                say('CLEANUP: no Moss marker on the live rule, so nothing is deleted')
        else:
            if rule.get('entry_added') is True and not record.get('preexisting'):
                sudo([SOCKET_FILTER, '--remove', str(self.binary)], check=False)
            else:
                say('CLEANUP: the record does not show Moss added the entry, so nothing is deleted')

    def remove_same_port_foreign(self):
        """Deletes only the runner's own same-port plant, proven by its comment marker."""
        if not self.planted_same_port:
            return
        self.planted_same_port = False
        marker = f'moss-runner-foreign-{self.port}'
        added = sudo(['ufw', 'show', 'added'], check=False).stdout
        if marker in added:
            sudo(['ufw', 'delete', 'allow', 'in', 'proto', 'tcp', 'to', 'any', 'port', str(self.port)], check=False)

    def remove_same_name_plant(self):
        """Deletes only the runner's own same-name plant, proven by its other port."""
        if not self.planted_same_name:
            return
        self.planted_same_name = False
        if self.same_name_present():
            run(['netsh', 'advfirewall', 'firewall', 'delete', 'rule', f'name={self.rule_name}'], check=False)

    # Rules planted by someone else. Moss must leave every one of them alone.
    def plant_other(self):
        """A rule with another name (Windows) or another port or program."""
        if self.other_present():
            say('FAIL: a rule for the second test is already in the firewall, not touching it')
            sys.exit(1)
        self.planted_other = True
        if SYSTEM == 'Windows':
            run(['netsh', 'advfirewall', 'firewall', 'add', 'rule', 'name=Moss-other-instance', 'dir=in',
                 'action=allow', 'protocol=TCP', f'localport={self.port}', f'program={self.binary}', 'enable=yes'])
        elif SYSTEM == 'Linux':
            sudo(['ufw', 'allow', 'in', 'proto', 'tcp', 'to', 'any', 'port', str(self.port + 1),
                  'comment', f'moss-runner-other-{self.port + 1}'])
        else:
            sudo([SOCKET_FILTER, '--add', '/usr/bin/true'], check=False)

    def other_present(self):
        if SYSTEM == 'Windows':
            return run(['netsh', 'advfirewall', 'firewall', 'show', 'rule', 'name=Moss-other-instance'], check=False).returncode == 0
        if SYSTEM == 'Linux':
            return f'{self.port + 1}/tcp' in sudo(['ufw', 'status'], check=False).stdout
        return '/usr/bin/true' in sudo([SOCKET_FILTER, '--listapps'], check=False).stdout

    def remove_other(self):
        if not self.planted_other:
            return
        if SYSTEM == 'Windows':
            run(['netsh', 'advfirewall', 'firewall', 'delete', 'rule', 'name=Moss-other-instance'], check=False)
        elif SYSTEM == 'Linux':
            marker = f'moss-runner-other-{self.port + 1}'
            if marker in sudo(['ufw', 'show', 'added'], check=False).stdout:
                sudo(['ufw', 'delete', 'allow', 'in', 'proto', 'tcp', 'to', 'any', 'port', str(self.port + 1)], check=False)
        else:
            sudo([SOCKET_FILTER, '--remove', '/usr/bin/true'], check=False)

    def plant_same_name(self):
        """Windows: a rule holding the bare instance prefix, with another program and port."""
        self.planted_same_name = True
        other = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'notepad.exe')
        run(['netsh', 'advfirewall', 'firewall', 'add', 'rule', f'name={self.rule_name}', 'dir=in',
             'action=allow', 'protocol=TCP', f'localport={self.port + 2}', f'program={other}', 'enable=yes'])

    def same_name_present(self):
        result = run(['netsh', 'advfirewall', 'firewall', 'show', 'rule', f'name={self.rule_name}'], check=False)
        return result.returncode == 0 and str(self.port + 2) in result.stdout

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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bin', required=True)
    parser.add_argument('--scratch', required=True)
    parser.add_argument('--port', type=int, default=5198)
    parser.add_argument('--negative-swallow-remove', action='store_true')
    args = parser.parse_args()
    suffix = '.exe' if SYSTEM == 'Windows' else ''
    binary = (Path(args.bin) / 'examples' / f'sharing_probe{suffix}').resolve()
    scratch = Path(args.scratch)
    shutil.rmtree(scratch, ignore_errors=True)
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
                  'comment', f'moss-runner-foreign-{args.port}'])
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
        expect(world.second_client() == 'ANSWERED', 'sharing on: the second client is answered')
        expect(world.reach('127.0.0.1') == 'ANSWERED', 'sharing on: this computer is answered')

        expect(probe.send('off') == 'Ok(())', 'sharing turns off')
        expect(world.second_client() != 'ANSWERED', 'after off: the second client is refused')
        expect(world.reach('127.0.0.1') == 'ANSWERED', 'after off: this computer still reaches the server')
        expect(not world.rule_present(), 'the firewall rule is gone after off')
        expect(not world.record_present(), 'the instance record is gone after off')
        expect(probe.send('restart-check') == 'false', 'after off: a restart would not listen beyond loopback')
        expect(world.other_present(), 'a rule planted by someone else survives on and off')

        probe.send('answer approve')
        expect(probe.send('on') == 'Ok(())', 'sharing turns on again')
        expect(world.rule_present(), 'the rule is back')
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
        world.cleanup_moss_rule()
        world.remove_same_port_foreign()
        world.remove_same_name_plant()
        world.remove_other()
        world.tear_down_client()


if __name__ == '__main__':
    main()
