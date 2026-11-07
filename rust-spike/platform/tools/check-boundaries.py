#!/usr/bin/env python3
"""Build gate: manifest edges plus provider/model literals and raw I/O outside owners.

No downloads or third-party Python packages. Rust literal scanning uses the repo's syn-based tool.
"""
import pathlib
import subprocess
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]

def dependency_errors(manifests):
    errors = []
    packages = {m['package']['name']: m for m in manifests}
    for name, manifest in packages.items():
        metadata = manifest['package'].get('metadata', {}).get('moss', {})
        module = metadata.get('module')
        sections = [manifest] + list(manifest.get("target", {}).values())
        for settings in sections:
            for section in ('dependencies', 'build-dependencies', 'dev-dependencies'):
                for alias, dependency in settings.get(section, {}).items():
                    dep = dependency.get('package', alias) if isinstance(dependency, dict) else alias
                    target = packages.get(dep)
                    if module and dep in ('tokio-postgres', 'postgres', 'sqlx', 'reqwest', 'hyper', 'ureq', 'moss-platform-adapters'):
                        errors.append(f'{name} imports private I/O dependency {dep}')
                    if name not in ('moss-platform-adapters', 'moss-platform-harness') and dep in ('reqwest', 'hyper', 'ureq'):
                        errors.append(f'{name} imports an HTTP client outside adapters')
                    if not target:
                        continue
                    target_meta = target['package'].get('metadata', {}).get('moss', {})
                    owner = target_meta.get('module')
                    if module and owner and module != owner and not target_meta.get('public-api', False):
                        errors.append(f'{name} imports implementation crate {target["package"]["name"]}')
    return errors

def main():
    manifests = [tomllib.loads(p.read_text()) for p in ROOT.glob('*/Cargo.toml')]
    errors = dependency_errors(manifests)
    for error in errors:
        print('BOUNDARY FAIL:', error)
    if errors:
        return 1
    result = subprocess.run(['cargo','run','--quiet','--manifest-path',str(ROOT/'Cargo.toml'),'-p','moss-platform-harness','--bin','check-literals','--',str(ROOT)])
    if result.returncode:
        return result.returncode
    print('BOUNDARY PASS: module dependency edges, provider/model literals, payload type shapes, owned I/O')
    return 0
if __name__ == '__main__':
    sys.exit(main())
