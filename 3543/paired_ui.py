import argparse,json,time,subprocess,pathlib,os,shutil,re
from playwright.sync_api import sync_playwright,expect
parser=argparse.ArgumentParser();parser.add_argument('--variant',choices=['main','branch'],required=True);parser.add_argument('--run',type=int,required=True);args=parser.parse_args()
REPO=pathlib.Path(os.environ.get('MOSS_REPO',str(pathlib.Path.home()/'Jarv1s')))
ROOT=pathlib.Path(os.environ.get('PROOF_DIR','/tmp/moss-first-reminder-proof'));RUN=ROOT/f'final_runs/run_{args.run}';(RUN/'screenshots').mkdir(parents=True,exist_ok=True)
LOG=RUN/'final_script_log.txt';LOG.write_text('');expect.set_options(timeout=30000)
def log(n,s):
 line=f'step {n} action: {s}';print(line,flush=True)
 with LOG.open('a') as f:f.write(line+'\n')
def get(page,path):
 r=page.request.get(path);assert r.ok,(path,r.status,r.text()[:300]);return r.json()
def post(page,path,data):
 r=page.request.post(path,data=data,timeout=180000);assert r.ok,(path,r.status,r.text()[:300]);return r.json()
stackfile=ROOT/('stack-main.json' if args.variant=='main' else 'stack.json')
end=time.monotonic()+180
while not stackfile.exists():
 assert time.monotonic()<end,'scratch stack readiness timeout';time.sleep(2)
stack=json.loads(stackfile.read_text());ready=RUN/'auth-ready';stop=RUN/'auth-stop';auth=None
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/google-chrome');page=browser.new_page(viewport={'width':1280,'height':1800},base_url=stack['baseURL']);page.set_default_timeout(30000)
 try:
  log(1,f'{args.variant}: create fresh owner through real signup; no model configured')
  page.goto('/',wait_until='domcontentloaded');page.get_by_role('button',name='Create account',exact=True).click()
  page.get_by_label('Name',exact=True).fill('Reminder proof');page.get_by_label('Email',exact=True).fill('paired-reminder@example.test');page.get_by_label('Password',exact=True).fill('throwaway-first-reminder-3543');page.locator('form.auth-form').get_by_role('button',name='Create account',exact=True).click()
  menu=page.get_by_role('button',name='Account menu',exact=False);skip=page.get_by_role('button',name='Skip setup',exact=True);expect(menu.or_(skip).first).to_be_visible()
  if skip.is_visible():
   skip.click();anyway=page.get_by_role('button',name='Skip anyway',exact=True);expect(menu.or_(anyway).first).to_be_visible()
   if anyway.is_visible():anyway.click()
  expect(menu).to_be_visible();actor=get(page,'/api/auth/get-session')['user']['id']
  assert get(page,'/api/chat/threads?surface=drawer')['threads']==[]
  assert page.request.get('/api/chat/main').status==404
  log(2,'Signup completed; zero conversations; Main HTTP404. Keep this signed-in page loaded.')
  env={**os.environ,'B3543_STACK_FILE':str(stackfile),'B3543_AUTH_READY':str(ready),'B3543_AUTH_STOP':str(stop),'JARVIS_IMAGE_TAG':'b3543-main-control' if args.variant=='main' else 'b3543-first-reminder-final'}
  auth=subprocess.Popen([str(REPO/'node_modules/.bin/tsx'),str(ROOT/'auth.mts'),actor],cwd=str(REPO),env=env,stdout=(RUN/'auth.log').open('w'),stderr=subprocess.STDOUT)
  end=time.monotonic()+90
  while not ready.exists():
   assert auth.poll() is None,'credential helper failed';assert time.monotonic()<end,'credential helper timeout';time.sleep(1)
  assert post(page,'/api/onboarding/provider-install',{'providerKind':'openai-compatible'})['installState']=='installed'
  assert post(page,'/api/onboarding/provider-login/begin',{'providerKind':'openai-compatible'})['status']=='ready'
  end=time.monotonic()+90;model=None
  while time.monotonic()<end:
   models=get(page,'/api/ai/models')['models'];model=next((m for m in models if m['status']=='active' and m['tier']=='economy' and 'chat' in m['capabilities']),None)
   if model:break
   time.sleep(2)
  assert model,'no economy chat model';r=page.request.put('/api/admin/users/'+actor+'/ai-pin',data={'modelId':model['id']});assert r.ok,r.text()[:300]
  assert page.request.get('/api/chat/main').status==404
  log(3,'Precondition: real host Codex auth installed with sanctioned helper; genuine provider-install/login and ai-pin endpoints select economy model. No reload. Main still HTTP404.')
  page.get_by_role('button',name='Chat with Moss',exact=True).click();drawer=page.get_by_role('dialog',name='Chat with Moss',exact=True);composer=drawer.get_by_label('Message Moss',exact=True);expect(composer).to_be_enabled(timeout=60000)
  document_start=page.evaluate('performance.timeOrigin')
  composer.fill('remind me in 2 minutes to stretch');assert get(page,'/api/chat/threads?surface=drawer')['threads']==[];assert page.request.get('/api/chat/main').status==404
  drawer.screenshot(path=str(RUN/'screenshots/final_execution_4_before_enter.png'));log(4,'Real composer contains first reminder; zero conversations and Main HTTP404 immediately before Enter.')
  with page.expect_response(lambda r:r.request.method=='POST' and r.url.split('?')[0].endswith('/api/chat/turn'),timeout=120000) as response:composer.press('Enter')
  turn=response.value;assert turn.ok,turn.text()[:300];result=turn.json();reply=result['reply'];expect(drawer.get_by_text(reply,exact=True)).to_be_visible()
  drawer.screenshot(path=str(RUN/'screenshots/final_execution_5_reply.png'));tasks=get(page,'/api/chat/scheduled-tasks')['tasks'];threads=get(page,'/api/chat/threads?surface=drawer')['threads']
  log(5,'Real UI POST returned HTTP200: '+reply)
  if args.variant=='main':
   assert re.search(r"could(?:n't| not) save that reminder",reply,re.I),result
   assert tasks==[] and threads==[],(tasks,threads)
   log(6,'Expected regression reproduced: UI reports reminder was not saved; no schedule; no Main. FAIL on origin/main.')
   (RUN/'result.json').write_text(json.dumps({'variant':args.variant,'mainBefore':404,'reply':reply,'threadsAfter':threads,'tasksAfter':tasks,'regressionObserved':True},indent=2))
  else:
   assert "I'll remind you in 2 minutes" in reply,result
   assert len(threads)==1 and threads[0]['isMain'];main=threads[0]['id'];task=next(t for t in tasks if t['instruction']=='stretch');assert task['state']=='active'
   log(6,'First UI turn created Main and active schedule; waiting for actual worker delivery; dueAt='+task['dueAt'])
   end=time.monotonic()+210
   while time.monotonic()<end:
    task=next(t for t in get(page,'/api/chat/scheduled-tasks')['tasks'] if t['id']==task['id'])
    if task['state']=='completed':break
    time.sleep(4)
   assert task['state']=='completed',task
   expect(drawer.get_by_text('Reminder: stretch',exact=True)).to_be_visible(timeout=60000)
   assert page.evaluate('performance.timeOrigin')==document_start,'document reloaded before delivery'
   hist=get(page,f'/api/chat/threads/{main}/messages?surface=drawer')['messages'];assert sum(m['body']=='Reminder: stretch' for m in hist)==1;assert len(task['runs'])==1 and task['runs'][0]['message']['threadId']==main
   drawer.screenshot(path=str(RUN/'screenshots/final_execution_7_delivered.png'));log(7,'Actual worker delivered once; Reminder: stretch appeared live in newly created Main with the same document timeOrigin and no reload. PASS on branch.')
   (RUN/'result.json').write_text(json.dumps({'variant':args.variant,'mainBefore':404,'reply':reply,'mainId':main,'taskId':task['id'],'dueAt':task['dueAt'],'runs':task['runs'],'deliveredExactlyOnce':True,'sameDocumentWithoutReload':True},indent=2))
 except Exception:
  log(99,'Failure DOM: '+page.locator('body').inner_text()[:2500]);page.screenshot(path=str(RUN/'screenshots/failure.png'));raise
 finally:
  browser.close()
  if auth:stop.touch();auth.wait(timeout=45)
shutil.copy2(__file__,RUN/'final_script.py')
