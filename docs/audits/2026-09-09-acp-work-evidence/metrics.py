import json,pathlib,collections,re,datetime,statistics,csv
B=pathlib.Path(__import__('sys').argv[1]).expanduser();cs=[json.loads(l) for l in (B/'calls.jsonl').open()]
def command(c):
 i=c.get('rawInput') or {};return next((i[k] for k in ['command','cmd','command_line'] if isinstance(i.get(k),str)),'') if isinstance(i,dict) else ''
def safecommand(c):
 s=command(c)
 return s if '<<' not in s and not re.match(r'\s*(?:echo|printf|cat >|python)',s) else ''
def selected(p):return [c for c in cs if re.search(p,safecommand(c),re.M)]
patterns={
 'ci_status_calls':r'\bgh (?:pr checks|run (?:view|list|watch))\b',
 'pr2427_checks':r'\bgh pr checks 2427\b',
 'gate_status_wait_calls':r'run-gate\.sh (?:status|wait)\b',
 'static_launch_calls':r'(?:^|[\n;&|])\s*(?:pnpm (?:run )?verify:static\b|scripts/run-gate.sh start --gate verify:static\b)',
 'unit_launch_calls':r'(?:^|[\n;&|])\s*(?:pnpm (?:run )?test:unit\b|scripts/run-gate.sh start --gate test:unit\b)',
 'typecheck_launch_calls':r'(?:^|[\n;&|])\s*pnpm (?:run )?typecheck\b',
 'vitest_calls':r'(?:^|[\n;&|])\s*pnpm (?:exec )?vitest\s+run\b',
}
summary={};ledger=[]
for name,p in patterns.items():
 xs=selected(p);summary[name]={'count':len(xs),'by_agent':dict(collections.Counter(c['agent'] for c in xs))}
 for c in xs:ledger.append({'category':name,**{k:c.get(k) for k in ['file','line','agent','start','duration_ms','status']},'command':command(c)})
sl=[c for c in cs if re.fullmatch(r'\s*sleep\s+\d+(?:\.\d+)?\s*',command(c))];summary['standalone_sleeps']={'count':len(sl),'requested_seconds':sum(float(command(c).split()[1]) for c in sl),'by_agent':dict(collections.Counter(c['agent'] for c in sl))}
for c in sl:ledger.append({'category':'standalone_sleep',**{k:c.get(k) for k in ['file','line','agent','start','duration_ms','status']},'command':command(c)})
(B/'command-ledger.jsonl').write_text(''.join(json.dumps(c)+'\n' for c in ledger))
# Gate receipts are authoritative for runtime and outcome.
gates=[]
for p in sorted((B/'gate-logs').glob('*.log')):
 s=p.read_text();fields={k:re.search(pat,s).group(1) for k,pat in {'gate':r'### GATE\s+(.+)','start':r'### START\s+(.+)','end':r'### END\s+(.+)','rc':r'### FINAL rc=(\d+)'}.items()};fields['seconds']=(datetime.datetime.fromisoformat(fields['end'])-datetime.datetime.fromisoformat(fields['start'])).total_seconds();fields['file']=p.name;fields['lines']=len(s.splitlines());gates.append(fields)
summary['gates']={}
for typ in sorted(set(g['gate'] for g in gates)):
 gs=[g for g in gates if g['gate']==typ];summary['gates'][typ]={'count':len(gs),'passed':sum(g['rc']=='0' for g in gs),'seconds':sum(g['seconds'] for g in gs),'median_pass_seconds':statistics.median([g['seconds'] for g in gs if g['rc']=='0'])}
(B/'gate-receipts.json').write_text(json.dumps(gates,indent=2))
# Tool error patterns rather than raw failed status: pending CI returns nonzero too.
gem=[c for c in cs if c['agent']=='Gemini-Builder'];vf=[c for c in gem if c.get('title')=='Running view_file'];summary['gemini_view_file']={'calls':len(vf),'failed':sum(c['status']=='failed' for c in vf),'first_failed':None,'last_failed':None}
ff=sorted([c for c in vf if c['status']=='failed'],key=lambda c:c['start'])
if ff:summary['gemini_view_file'].update(first_failed=ff[0]['start'],last_failed=ff[-1]['end'])
summary['gate_pipe_blocks']=sum('BLOCKED: this pipes a verification gate' in str(c.get('rawOutput','')) for c in cs)
summary['graph_project_errors']=sum('project not found or not indexed' in str(c.get('rawOutput','')) for c in cs)
summary['tool_counts']={'all':len(cs),'failed_status':sum(c['status']=='failed' for c in cs),'kinds':dict(collections.Counter(c.get('kind') for c in cs))}
# CI facts. Sum jobs, not overlapping workflows, and mark as runner time.
runs=json.load((B/'ci-runs.json').open());cut=datetime.datetime.fromisoformat((B/'cutoff.txt').read_text());runs=[r for r in runs if datetime.datetime.fromisoformat(r['createdAt'].replace('Z','+00:00'))<=cut];jobs=[]
for r in runs:
 p=B/'ci-jobs'/f"{r['databaseId']}.json"
 if r['name']!='CI' or not p.exists():continue
 for j in json.load(p.open()).get('jobs',[]):
  if not j.get('started_at') or not j.get('completed_at'):continue
  start=datetime.datetime.fromisoformat(j['started_at'].replace('Z','+00:00'));end=datetime.datetime.fromisoformat(j['completed_at'].replace('Z','+00:00'))
  if end>cut:continue
  jobs.append({'run_id':r['databaseId'],'head':r['headSha'],'name':j['name'],'conclusion':j['conclusion'],'seconds':max(0,(end-start).total_seconds()),'start':j['started_at'],'end':j['completed_at'],'url':j['html_url'],'steps':[{k:s.get(k) for k in ['name','conclusion','started_at','completed_at']} for s in j['steps']]})
summary['ci']={'runs':len(runs),'CI_runs':sum(r['name']=='CI' for r in runs),'unique_heads':len(set(r['headSha'] for r in runs)),'conclusions':dict(collections.Counter(r['name']+':'+r['conclusion'] for r in runs)),'jobs':len(jobs),'job_seconds':sum(j['seconds'] for j in jobs),'by_job':{n:{'count':len(js:=[j for j in jobs if j['name']==n]),'seconds':sum(j['seconds'] for j in js),'failures':sum(j['conclusion']=='failure' for j in js)} for n in sorted(set(j['name'] for j in jobs))}}
(B/'ci-job-ledger.json').write_text(json.dumps(jobs,indent=2));(B/'metrics.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
