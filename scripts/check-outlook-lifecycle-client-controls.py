"""Require assertion failures on temporary client/test copies; never mutate shipped source."""
from pathlib import Path
import json
import re
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'packages/connectors/src/outlook-lifecycle-client.ts'
TEST = ROOT / 'tests/unit/outlook-lifecycle-client.test.ts'
FIXED = 'sends fixed references'
CONTROLS = (
    ('positive acknowledgment', [('finish(response.equals(SUCCESS))', 'finish(true)')],
     'does not acknowledge malformed'),
    ('EOF acknowledgment', [('response = Buffer.concat([response, chunk]);',
                            'response = Buffer.concat([response, chunk]);\n'
                            '          if (response.equals(SUCCESS)) finish(true);')],
     'does not acknowledge success followed by late extra data'),
    ('response bound', [('if (response.length + chunk.length > 32) return finish(false);', '')],
     'bounds response bytes before EOF'),
    ('absolute deadline', [('setTimeout(() => finish(false), this.timeoutMs)',
                           'setTimeout(() => finish(false), 120_000)')],
     'enforces an absolute deadline'),
    ('reference validation', [(
        'if (!UUID.test(runtimeId) || !Number.isSafeInteger(generation) || generation < 1)',
        'if (false)')], 'rejects invalid references'),
    ('broker UID', [('folder.uid !== this.uid ||', 'false ||'),
                    ('socket.uid !== this.uid ||', 'false ||')],
     'rejects unsupported socket permissions/identity: uid'),
    ('socket GID', [('folder.gid !== this.gid ||', 'false ||'),
                    ('socket.gid !== this.gid ||', 'false ||')],
     'rejects unsupported socket permissions/identity: gid'),
    ('directory mode', [('(folder.mode & 0o7777) !== 0o750 ||', 'false ||')],
     'rejects unsupported socket permissions/identity: folder-mode'),
    ('socket mode', [('(socket.mode & 0o7777) !== 0o660', 'false')],
     'rejects unsupported socket permissions/identity: socket-mode'),
    # Symlink mode also differs from the required socket mode: remove both
    # independent rejections to exercise the actual connection through the link.
    ('socket symlink', [('!socket.isSocket() ||', 'false ||'),
                        ('(socket.mode & 0o7777) !== 0o660', 'false')],
     'rejects unsupported socket permissions/identity: symlink'),
    ('fixed envelope', [('JSON.stringify({ operation, runtimeId, generation })',
                        'JSON.stringify({ ...ref, operation, runtimeId, generation })')], FIXED),
    ('reference snapshot', [('JSON.stringify({ operation, runtimeId, generation })',
                            'JSON.stringify({ operation, runtimeId, generation: ref.generation })')], FIXED),
    ('error sanitization', [('} catch {', '} catch (error) {'),
                            ('// Do not retain paths, request fields, raw socket errors or broker responses.\n'
                             '      throw new OutlookRuntimeUnavailable();', 'throw error;')],
     'reports socket absence without retaining the private path'),
)


def main():
    source = SOURCE.read_text()
    test = TEST.read_text()
    # Existing repository scratch convention keeps concurrent lint/format/type
    # scans away from transient mutated sources. Mirror relative imports inside it.
    with tempfile.TemporaryDirectory(prefix='.tmp-outlook-client-', dir=ROOT) as directory:
        temporary = Path(directory)
        candidate = temporary / SOURCE.relative_to(ROOT)
        suite = temporary / TEST.relative_to(ROOT)
        candidate.parent.mkdir(parents=True)
        suite.parent.mkdir(parents=True)
        suite.write_text(test)
        config = temporary / 'vitest.config.ts'
        config.write_text('import base from "../vitest.config.ts";\n'
                          'export default {...base, test: {...base.test, include: ' +
                          json.dumps([str(suite.relative_to(ROOT))]) + '}};\n')
        for label, mutations, name in CONTROLS:
            changed = source
            for before, after in mutations:
                assert changed.count(before) == 1, 'Ambiguous control: ' + label
                changed = changed.replace(before, after)
            candidate.write_text(changed)
            result = subprocess.run(
                ['pnpm', 'exec', 'vitest', 'run', '--config', str(config.relative_to(ROOT)),
                 str(suite.relative_to(ROOT)),
                 '--testNamePattern', re.escape(name)], cwd=ROOT, capture_output=True,
                text=True, timeout=45)
            output = result.stdout + result.stderr
            if result.returncode == 0 or 'AssertionError' not in output:
                raise AssertionError('Control did not fail an assertion: ' + label + '\n' + output[-4000:])
            print('PASS: removing ' + label + ' fails the actual client assertion', flush=True)


if __name__ == '__main__':
    main()
