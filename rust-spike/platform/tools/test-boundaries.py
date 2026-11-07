#!/usr/bin/env python3
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location('boundaries', pathlib.Path(__file__).with_name('check-boundaries.py'))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
a = {'package': {'name': 'module-a', 'metadata': {'moss': {'module': 'a'}}}, 'dependencies': {'module-b': {'path': '../b'}}}
b = {'package': {'name': 'module-b', 'metadata': {'moss': {'module': 'b'}}}}
assert checker.dependency_errors([a,b]), 'private implementation edge was allowed'
b['package']['metadata']['moss']['public-api'] = True
assert not checker.dependency_errors([a,b]), 'public API edge was refused'
print('BOUNDARY PASS: private module edge refused, public API edge allowed')

a['dependencies'] = {'network': {'package': 'reqwest', 'version': '0.12'}}
assert checker.dependency_errors([a,b]), 'renamed private I/O dependency was allowed'
a['dependencies'] = {}
a['target'] = {'cfg(unix)': {'build-dependencies': {'module-b': {'path': '../b'}}}}
b['package']['metadata']['moss']['public-api'] = False
assert checker.dependency_errors([a,b]), 'target-specific build dependency escaped'
print('BOUNDARY PASS: renamed I/O and target-specific implementation edges refused')
