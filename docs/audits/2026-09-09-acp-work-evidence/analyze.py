import json,pathlib,collections,datetime,re,hashlib,statistics
BASE=pathlib.Path(__import__('sys').argv[1]).expanduser(); START=1788710100000; END=int(datetime.datetime.fromisoformat((BASE/'cutoff.txt').read_text()).timestamp()*1000)
def iso(t): return datetime.datetime.fromtimestamp(t/1000,datetime.timezone.utc).isoformat()
def clean(x):
 if isinstance(x,dict):
  if x.get('name','').upper().endswith(('TOKEN','KEY','SECRET','PASSWORD')): return {**x,'value':'[REDACTED]'}
  return {k:('[REDACTED]' if re.search(r'token$|password|secret|api.?key',k,re.I) and not re.search(r'Tokens?$|token_count',k) else clean(v)) for k,v in x.items()}
 if isinstance(x,list): return [clean(v) for v in x]
 if isinstance(x,str):
  x=x.replace(str(pathlib.Path.home()/'Jarv1s'),'~/Jarv1s').replace(str(pathlib.Path.home())+'/','~/')
  x=re.sub(r'(?i)((?:VIBEROOM_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|password|authorization)[\s"\x27:=]+)[^\s"\x27,}]+',r'\1[REDACTED]',x)
  return x
 return x
hist=[]
for n,l in enumerate((BASE/'room/history.jsonl').open(),1):
 r=json.loads(l)
 if START<=r['ts']<=END: hist.append({**r,'source_line':n})
(BASE/'history-clean.jsonl').write_text(''.join(json.dumps(clean(r),ensure_ascii=False)+'\n' for r in hist))
turns=[]; calls=[]; files=[]; events=collections.Counter(); errors=[]
for p in sorted((BASE/'room/transcripts').glob('*.jsonl')):
 rows=[]
 for n,l in enumerate(p.open(),1):
  try: rows.append((n,json.loads(l)))
  except json.JSONDecodeError: errors.append([p.name,n,'partial JSON'])
 agent=re.sub(r'-\d{4}-\d{2}-\d{2}T.*','',p.name); provider='unknown'; sid=None; configs={}; requests={}; active=None; tc={}; fc=0
 for n,r in rows:
  t=r['t']; m=r.get('msg',{}); method=m.get('method'); params=m.get('params',{}); res=m.get('result',{}); u=params.get('update',{}); kind=u.get('sessionUpdate')
  if method=='initialize': requests[m['id']]={'method':'initialize'}
  if method in ('session/new','session/load'): requests[m['id']]={'method':method}
  if 'agentInfo' in res: provider=res['agentInfo']['name']
  if 'sessionId' in res: sid=res['sessionId']
  if method=='session/set_config_option': configs[params['configId']]=params['value']
  if method=='session/prompt':
   active={'file':p.name,'line':n,'agent':agent,'provider':provider,'session_id':params.get('sessionId',sid),'id':m['id'],'start':t,'start_iso':iso(t),'prompt':'\n'.join(z.get('text','') for z in params.get('prompt',[]) if z.get('type')=='text'),'answer':'','thought_chars':0,'configs':dict(configs),'tool_count':0}
   requests[m['id']]=active
  if active and kind=='agent_message_chunk': active['answer']+=u.get('content',{}).get('text','')
  if active and kind=='agent_thought_chunk': active['thought_chars']+=len(u.get('content',{}).get('text',''))
  if kind=='tool_call':
   key=u['toolCallId']
   if key not in tc:
    tc[key]={'file':p.name,'line':n,'agent':agent,'provider':provider,'start':t,'turn_line':active['line'] if active else None,'session_id':sid,'id':key,'update_count':0,'output_events_bytes':0}
    if active: active['tool_count']+=1
   tc[key].update({k:u[k] for k in ('title','kind','status','rawInput') if k in u})
  if kind in ('tool_call','tool_call_update') and u.get('toolCallId') in tc:
   c=tc[u['toolCallId']]; c['end']=t; c['end_line']=n;c['update_count']+=1
   for k in ('title','kind','status','rawInput','rawOutput'):
    if k in u: c[k]=u[k]
   if 'content' in u: c['content']=u['content']
   c['output_events_bytes']+=len(json.dumps({k:u[k] for k in ('content','rawOutput') if k in u}).encode())
  if m.get('id') in requests and r['dir']=='A->C' and ('result' in m or 'error' in m):
   req=requests[m['id']]
   if 'prompt' in req:
    req.update(end=t,end_line=n,duration_ms=t-req['start'],usage=res.get('usage'),stop_reason=res.get('stopReason'),error=m.get('error'),meta=res.get('_meta',{}))
    if START<=req['start']<=END:
     turns.append(req);fc+=1
    if active is req: active=None
  if START<=t<=END: events[kind or method or 'response']+=1
 for req in requests.values():
  if 'prompt' in req and 'end' not in req and START<=req['start']<=END: turns.append(req);fc+=1
 for c in tc.values():
  if START<=c['start']<=END:
   c['duration_ms']=c['end']-c['start']; calls.append(c)
 files.append({'file':p.name,'agent':agent,'provider':provider,'session_id':sid,'bytes':p.stat().st_size,'lines':len(rows),'first':iso(rows[0][1]['t']) if rows else None,'last':iso(rows[-1][1]['t']) if rows else None,'prompt_count':fc,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
for t in turns:
 t['prompt_bytes']=len(t['prompt'].encode());t['answer_bytes']=len(t['answer'].encode());t['silent']=bool(re.fullmatch(r'\s*\[silent\][.!]?\s*',t['answer'],re.I));t['brief']='<room-brief>' in t['prompt']
for name,data in [('turns',turns),('calls',calls),('manifest',files)]: (BASE/(name+'.jsonl')).write_text(''.join(json.dumps(clean(r),ensure_ascii=False)+'\n' for r in data))
usagekeys=['inputTokens','outputTokens','cachedReadTokens','cachedWriteTokens','totalTokens','thoughtTokens']
def summarize(ts):
 return {'turns':len(ts),'usage_turns':sum(bool(t.get('usage')) for t in ts),'silent_turns':sum(t['silent'] for t in ts),'silent_totalTokens':sum((t.get('usage') or {}).get('totalTokens',0) for t in ts if t['silent']), 'no_tool_turns':sum(t['tool_count']==0 for t in ts),'no_tool_totalTokens':sum((t.get('usage') or {}).get('totalTokens',0) for t in ts if t['tool_count']==0),'tool_calls':sum(t['tool_count'] for t in ts),'duration_ms':sum(t.get('duration_ms',0) for t in ts),'prompt_bytes':sum(t['prompt_bytes'] for t in ts),'brief_turns':sum(t['brief'] for t in ts),**{k:sum((t.get('usage') or {}).get(k,0) for t in ts) for k in usagekeys}}
summary={'start':iso(START),'cutoff':iso(END),'hours':(END-START)/3600000,'files':len(files),'transcript_bytes':sum(f['bytes'] for f in files),'events':events,'history_records':len(hist),'history_kinds':dict(collections.Counter(h['kind'] for h in hist)),'history_agents':dict(collections.Counter(h['fromName'] for h in hist if h['kind']=='chat')),'all':summarize(turns),'by_agent':{a:summarize([t for t in turns if t['agent']==a]) for a in sorted(set(t['agent'] for t in turns))},'by_provider':{a:summarize([t for t in turns if t['provider']==a]) for a in sorted(set(t['provider'] for t in turns))},'errors':errors}
(BASE/'summary.json').write_text(json.dumps(summary,indent=2)); print(json.dumps(summary,indent=2))
