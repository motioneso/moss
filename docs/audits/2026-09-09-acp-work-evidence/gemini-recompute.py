#!/usr/bin/env python3
"""Recompute revision totals from sanitized native usage events; standard library only."""
import json
import sys
from collections import Counter
from pathlib import Path

source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name('gemini-native-summary.json')
data = json.loads(source.read_text())
start, cutoff = data['interval_start_micros'], data['cutoff_micros']
components, silent, pure_silent, prompt_count = Counter(), 0, 0, 0
sessions = []
for session in data['sessions']:
    previous = Counter()
    baseline = Counter()
    window_deltas = []
    for event in sorted(session['events'], key=lambda e: (e['timestamp_micros'], int(e['seq_num']))):
        usage = event['usage']
        assert event['matches_aggregate_total']
        assert usage['totalTokenCount'] == usage['promptTokenCount'] + usage['candidatesTokenCount'] + usage['thoughtsTokenCount']
        assert all(value >= previous[key] for key, value in usage.items()), 'Cumulative counter reset needs explicit handling'
        if event['timestamp_micros'] > cutoff:
            break
        delta = usage['totalTokenCount'] + usage['cachedContentTokenCount'] - previous['totalTokenCount'] - previous['cachedContentTokenCount']
        previous = Counter(usage)
        if event['timestamp_micros'] < start:
            baseline = Counter(usage)
        else:
            window_deltas.append((event['timestamp_micros'], delta))
    totals = previous - baseline
    components.update(totals)
    native_total = totals['totalTokenCount'] + totals['cachedContentTokenCount']
    assert native_total == sum(delta for _, delta in window_deltas)
    prompt_totals = Counter()
    for timestamp, delta in window_deltas:
        matches = [t for t in session['turn_usage'] if t['start_ms'] * 1000 <= timestamp <= (t['end_ms'] * 1000 if t['end_ms'] is not None else cutoff)]
        assert len(matches) == 1, 'Native usage must map to exactly one room prompt'
        turn = matches[0]
        prompt_totals[turn['prompt_id']] += delta
        if turn['silent']:
            silent += delta
            if turn['acp_tool_count'] == 0:
                pure_silent += delta
    for turn in session['turn_usage']:
        assert prompt_totals[turn['prompt_id']] == turn['native_tokens']
    prompt_count += len(session['turn_usage'])
    sessions.append({'session_id': session['session_id'], 'native_tokens': native_total})
new_total = components['totalTokenCount'] + components['cachedContentTokenCount']
assert new_total == data['newly_recovered_total']
assert pure_silent == data['gemini_pure_silent_tokens']
assert prompt_count == 14
print(json.dumps({'sessions': sessions, 'components': dict(components), 'newly_recovered_gemini_tokens': new_total,
                  'gemini_silent_tokens': silent, 'gemini_pure_silent_tokens': pure_silent,
                  'revised_measured_total': data['original_published_measured_total'] + new_total,
                  'revised_pure_silent_tokens': 25158243 + pure_silent,
                  'revised_cache_read_fraction': (1149239084 + components['cachedContentTokenCount']) / (data['original_published_measured_total'] + new_total)}, indent=2))
