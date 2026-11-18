#!/usr/bin/env python3
"""Remove each protection in a disposable copy, require its regression test to fail."""
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]

def replace_body(source, name, replacement):
    start = source.index('pub fn '+name)
    opening = source.index('{', start)
    level = 1
    end = opening+1
    while level:
        level += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[:opening+1]+'\n'+replacement+'\n'+source[end-1:]

def run_control(name, mutate, command, expected):
    with tempfile.TemporaryDirectory(prefix='moss-negative-') as scratch:
        copy = pathlib.Path(scratch)/'platform'
        shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns('target', '__pycache__'))
        mutate(copy)
        env = dict(os.environ, CARGO_TARGET_DIR=str(ROOT/'target/negative'))
        result = subprocess.run(command(copy), cwd=copy, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if result.returncode == 0 or expected not in result.stdout:
            raise RuntimeError(name+' did not fail for the expected reason:\n'+result.stdout[-3000:])
        print(f'NEGATIVE {name}: expected failure, exit {result.returncode}')
        for line in result.stdout.splitlines():
            if 'FAILED' in line or 'panicked' in line or expected in line or 'test result:' in line:
                print(line[:250])

def payload(copy):
    p=copy/'contracts/src/lib.rs'
    s=p.read_text()
    marker='#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct Metadata'
    assert marker in s
    s=s.replace(marker,'#[serde(rename_all = "camelCase")]\npub struct Metadata')
    s=replace_body(s,'parse_payload','serde_json::from_value(value).map_err(|_| Error::InvalidPayload)')
    p.write_text(s)

def routes(copy):
    p=copy/'registry/src/lib.rs'
    p.write_text(replace_body(p.read_text(),'assert_coverage','Ok(())'))

def providers(copy):
    p=copy/'harness/src/bin/check-literals.rs'
    s=p.read_text();needle='.any(|needle| lower.contains(needle))';assert needle in s
    p.write_text(s.replace(needle,'.any(|_| false)'))

def shapes(copy):
    p=copy/'harness/src/bin/check-literals.rs'
    s=p.read_text();needle='!allowed.contains(&v.ident.to_string().as_str())';assert needle in s
    p.write_text(s.replace(needle,'false'))

def dependencies(copy):
    p=copy/'tools/check-boundaries.py'
    s=p.read_text();needle='if module and owner and module != owner and not target_meta.get(\'public-api\', False):';assert needle in s
    p.write_text(s.replace(needle,'if False:'))

cargo=lambda copy,test,name:['cargo','test','--manifest-path',str(copy/'Cargo.toml'),'--test',test,name,'--','--exact','--nocapture']
run_control('payload refusal removed',payload,lambda p:cargo(p,'protections','payload_refuses_content_and_secrets'),'accepted forbidden top-level field content')
run_control('route coverage removed',routes,lambda p:cargo(p,'protections','undeclared_route_is_refused'),'undeclared route reached startup')
run_control('provider lint removed',providers,lambda p:cargo(p,'boundaries','provider_literal_is_rejected'),'provider guard accepted a hardcoded provider')
run_control('payload shape lint removed',shapes,lambda p:cargo(p,'boundaries','payload_shape_is_rejected'),'payload guard accepted free text')
run_control('module edge check removed',dependencies,lambda p:['python3',str(p/'tools/test-boundaries.py')],'private implementation edge was allowed')
print('NEGATIVE PASS: all five removed protections made their own regression check fail')
