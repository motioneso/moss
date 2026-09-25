"""Recompute the audit's native totals from its private source snapshot.
Usage: python3 verify_native.py ~/.local/share/acp-work-audits/2026-09-09
"""
import datetime
import json
import pathlib
import sys

base = pathlib.Path(sys.argv[1]).expanduser()
summary = json.loads((base / 'token-native-summary.json').read_text())
start, cutoff = summary['start_ms'], summary['cutoff_ms']
children = {pathlib.Path(d['file']).expanduser() for d in summary['descendants']}
totals = {'direct': {'Claude': 0, 'Codex': 0, 'OpenCode': 0},
          'descendants': {'Claude': 0, 'Codex': 0, 'OpenCode': 0}}
claude = {}
cache_reads = 0

def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000

for source in summary['input_fingerprints']:
    original = pathlib.Path(source['file']).expanduser()
    relative = original.relative_to(pathlib.Path.home())
    path = base / 'native-inputs' / relative
    category = 'descendants' if original in children else 'direct'
    before, final = {}, {}
    with path.open() as file:
        for line in file:
            record = json.loads(line)
            if not record.get('timestamp'):
                continue
            when = timestamp(record['timestamp'])
            if when > cutoff:
                continue
            if relative.parts[0] == '.claude':
                message = record.get('message', {})
                if when >= start and record.get('type') == 'assistant' and message.get('usage'):
                    key = message['id']
                    previous = claude.get(key)
                    if previous is None or when >= previous[0]:
                        claude[key] = (when, category, message['usage'])
            else:
                payload = record.get('payload', {})
                info = payload.get('info') or {}
                usage = info.get('total_token_usage')
                if payload.get('type') == 'token_count' and usage:
                    if when < start:
                        before = usage
                    final = usage
    if relative.parts[0] == '.codex':
        totals[category]['Codex'] += final.get('total_tokens', 0) - before.get('total_tokens', 0)
        cache_reads += final.get('cached_input_tokens', 0) - before.get('cached_input_tokens', 0)

for _, category, usage in claude.values():
    totals[category]['Claude'] += sum(usage.get(k, 0) for k in
        ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))
    cache_reads += usage.get('cache_read_input_tokens', 0)

seen = set()
for session in summary['opencode_input_snapshot']['sessions']:
    for row in session['usage_rows']:
        assert row['id'] not in seen
        seen.add(row['id'])
        if start <= row['time_completed'] <= cutoff:
            tokens = row['tokens']
            assert tokens['total'] == sum(tokens.get(k, 0) for k in ('input', 'output', 'reasoning')) + sum(tokens['cache'].values())
            totals['direct']['OpenCode'] += tokens['total']
            cache_reads += tokens['cache']['read']

assert totals['direct'] == summary['final_totals']['direct'], totals
assert totals['descendants'] == summary['final_totals']['descendants'], totals
assert sum(sum(v.values()) for v in totals.values()) == 1_198_135_470
assert cache_reads == 1_149_239_084
print(json.dumps({'verified': totals, 'cached_input_reads': cache_reads}, indent=2))
