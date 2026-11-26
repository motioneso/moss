"""Read native service-manager state; never use Moss's saved registration as proof."""
import csv
import ctypes
import os
from pathlib import Path
import platform
import subprocess
import xml.etree.ElementTree as ET

NS = {'t': 'http://schemas.microsoft.com/windows/2004/02/mit/task'}


def run(args):
    print('COMMAND:', subprocess.list2cmdline([str(arg) for arg in args]), flush=True)
    result = subprocess.run([str(arg) for arg in args], capture_output=True)
    print('EXIT:', result.returncode, flush=True)
    return result


def user_sid():
    result = run(['whoami.exe', '/USER', '/FO', 'CSV', '/NH'])
    result.check_returncode()
    return next(csv.reader(result.stdout.decode(errors='replace').splitlines()))[-1]


def task_definition(name):
    result = run(['schtasks.exe', '/Query', '/TN', name, '/XML'])
    if result.returncode:
        return None
    data = result.stdout
    if data.startswith((b'\xff\xfe', b'\xfe\xff')):
        text = data.decode('utf-16')
    elif data.startswith(b'<\x00'):
        text = data.decode('utf-16-le')
    else:
        text = data.decode('utf-8-sig')
    return ET.fromstring(text)


def windows_argv(command, arguments):
    # Decode with Windows itself, preserving spaces, quotes and terminal backslashes.
    line = subprocess.list2cmdline([command]) + ' ' + arguments
    count = ctypes.c_int()
    parse = ctypes.windll.shell32.CommandLineToArgvW
    parse.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    parse.restype = ctypes.POINTER(ctypes.c_wchar_p)
    argv = parse(line, ctypes.byref(count))
    assert argv, 'Windows could not decode the registered task action'
    try:
        return line, [argv[i] for i in range(count.value)]
    finally:
        free = ctypes.windll.kernel32.LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(argv)


def ordinary(path):
    return os.path.normcase(str(path).removeprefix('\\\\?\\'))


def read_back(name, launcher, folder, enabled=True):
    system = platform.system()
    if system == 'Windows':
        root = task_definition(name)
        if root is None:
            return None
        sid = user_sid()
        assert not ctypes.windll.shell32.IsUserAnAdmin(), 'Gate must run without admin rights'
        triggers = root.findall('t:Triggers/*', NS)
        assert len(triggers) == 1 and triggers[0].tag.endswith('}LogonTrigger')
        assert triggers[0].findtext('t:UserId', namespaces=NS) == sid
        assert triggers[0].findtext('t:Enabled', default='true', namespaces=NS) == 'true'
        principals = root.findall('t:Principals/t:Principal', NS)
        assert len(principals) == 1
        principal = principals[0]
        assert principal.findtext('t:UserId', namespaces=NS) == sid
        assert principal.findtext('t:LogonType', namespaces=NS) == 'InteractiveToken'
        assert principal.findtext('t:RunLevel', namespaces=NS) == 'LeastPrivilege'
        assert root.findtext('t:Settings/t:Enabled', default='true', namespaces=NS) == str(enabled).lower()
        actions = root.findall('t:Actions/*', NS)
        assert len(actions) == 1 and actions[0].tag.endswith('}Exec')
        action = actions[0]
        executable = action.findtext('t:Command', namespaces=NS)
        arguments = action.findtext('t:Arguments', default='', namespaces=NS)
        line, argv = windows_argv(executable, arguments)
        assert len(argv) == 3 and argv[1] == 'service-run'
        assert ordinary(argv[0]) == ordinary(launcher.resolve())
        assert ordinary(argv[2]) == ordinary(folder.resolve())
        print('PASS: Task Scheduler read-back is current-user logon, least privilege and exact server action', flush=True)
        return {'command_line': line, 'cwd': action.findtext('t:WorkingDirectory', namespaces=NS)}
    assert os.geteuid() != 0, 'Gate must run without admin rights'
    if system == 'Linux':
        import pwd
        result = run(['systemctl', '--user', 'show', name + '.service', '--no-pager',
                      '--property=LoadState,UnitFileState,FragmentPath,ExecStart,User'])
        values = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
        if values.get('LoadState') != 'loaded':
            return None
        result.check_returncode()
        assert values.get('UnitFileState') == ('enabled' if enabled else 'disabled')
        assert values.get('User', '') in ('', str(os.getuid()), pwd.getpwuid(os.getuid()).pw_name)
        action = values['ExecStart']
        assert str(launcher) in action and 'service-run' in action and str(folder) in action
        assert values['FragmentPath'].endswith('/' + name + '.service')
        print('PASS: systemd user-manager read-back has the enabled server action', flush=True)
    else:
        result = run(['launchctl', 'print', f'gui/{os.getuid()}/{name}'])
        if result.returncode:
            return None
        lines = [line.strip() for line in result.stdout.decode().splitlines()]
        assert 'type = LaunchAgent' in lines
        assert 'program = ' + str(launcher) in lines
        assert 'service-run' in lines and str(folder) in lines
        print('PASS: launchd loaded-agent read-back has the current-user server action', flush=True)
    return True


def assert_removed(name):
    system = platform.system()
    if system == 'Windows':
        assert task_definition(name) is None
        result = run(['schtasks.exe', '/Query', '/FO', 'CSV', '/NH'])
        result.check_returncode()
        names = [row[0].lstrip('\\').casefold() for row in csv.reader(result.stdout.decode(errors='replace').splitlines()) if row]
        assert name.casefold() not in names
        print('PASS: Task Scheduler confirms the task was removed', flush=True)
    elif system == 'Linux':
        result = run(['systemctl', '--user', 'show', name + '.service', '--property=LoadState'])
        assert 'LoadState=not-found' in result.stdout.decode()
        print('PASS: systemd confirms the unit was removed', flush=True)
    else:
        run(['launchctl', 'print', f'gui/{os.getuid()}']).check_returncode()
        assert run(['launchctl', 'print', f'gui/{os.getuid()}/{name}']).returncode != 0
        print('PASS: launchd confirms the agent was removed', flush=True)


def register_app_task(name, launcher, data, scratch):
    sid = user_sid()
    namespace = NS['t']
    ET.register_namespace('', namespace)
    def child(parent, tag, text=None):
        node = ET.SubElement(parent, '{' + namespace + '}' + tag)
        node.text = text
        return node
    root = ET.Element('{' + namespace + '}Task', version='1.2')
    trigger = child(child(root, 'Triggers'), 'LogonTrigger')
    child(trigger, 'Enabled', 'true')
    child(trigger, 'UserId', sid)
    principal = child(child(root, 'Principals'), 'Principal')
    principal.set('id', 'Owner')
    child(principal, 'UserId', sid)
    child(principal, 'LogonType', 'InteractiveToken')
    child(principal, 'RunLevel', 'LeastPrivilege')
    actions = child(root, 'Actions')
    actions.set('Context', 'Owner')
    action = child(actions, 'Exec')
    child(action, 'Command', str(launcher))
    child(action, 'Arguments', subprocess.list2cmdline(['moss-app', '--data', str(data)]))
    path = Path(scratch) / 'app-login.xml'
    ET.ElementTree(root).write(path, encoding='utf-16', xml_declaration=True)
    run(['schtasks.exe', '/Create', '/TN', name, '/XML', path, '/F']).check_returncode()
    assert task_definition(name) is not None
