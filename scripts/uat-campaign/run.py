#!/usr/bin/env python3
"""Run the eight remaining browser specs only after separate execution approval."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import resource
import re
import stat
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time

ROOT = Path(__file__).resolve().parent
REPO = Path(os.environ.get('MOSS_UAT_CAMPAIGN_REPO') or Path.home() / 'Jarv1s')
SOURCE = '9139da579aa3cd1ba99a039edd24a739c0ec0128'
N3 = '966527c413adc752def72f45ce0c54e660ca0615'
PG = 'sha256:151aa1c2e849e7828ed8aef2183ae15f692cbe887d2f28921d8b44b26e154d7e'
BUILDKIT = 'sha256:27933730df224df80c41f4e5a9b33fa78831a79fd31903df3bb7deb49363422f'
BUILDX = Path.home() / '.docker/cli-plugins/docker-buildx'
BUILDX_SHA = 'd41ece72044243b4f58b343441ae37446d9c29a7d6b5e11c61847bbcf8f7dfda'
DEVPORTS = Path.home() / '.local/bin/devports'
SPECS = [
    ('runtime-context', 300, 'admin+data', [
        'ordinary chat turn sends no page snapshot',
        'assistant tools never expose a screenshot capability',
        'chat refuses to take a screenshot and explains why instead (#1121)',
        'News screen error is pulled and resolved against the map (#1121)',
    ]),
    ('3134-reminder-notifications', 600, 'solo-admin', [
        'due reminders alert this browser once, wait for quiet hours, and respect the Chat mute',
    ]),
    ('3135-reminder-edits-real', 720, 'solo-admin', [
        'chat edits replace queued terms, appear in Settings and fire once at the revised time',
    ]),
    ('3136-repeating-reminders-real', 720, 'solo-admin', [
        'real repeating requests, saved groups and one catch-up after worker downtime',
    ]),
    ('3138-repeating-useful-checks-real', 900, 'solo-admin', [
        'real recurring Tasks check stays quiet, posts one real change and recovers saved cadence',
    ]),
    ('3148-side-chat-destination-real', 720, 'solo-admin', [
        'real task creation, destination edits, isolated delivery and failed target recovery',
    ]),
    ('3151-scheduled-owner-read', 600, 'solo-admin', [
        'a real model saves an exact owner read, reports source status and refuses removed access',
    ]),
    ('3152-configured-source-report', 600, 'solo-admin', [
        'the configured model writes a sourced report while away and revoked access exposes no source',
    ]),
]
LABEL = 'moss.stage4.r19'
HOLD_KEY = 'moss.stage4.r19.role'
VOLUMES = ['jarv1s-postgres-data','jarv1s-vault-data','jarv1s-model-cache',
           'jarv1s-cli-tools','jarv1s-cli-auth','jarv1s-cli-socket',
           'jarv1s-sports-browser-socket','jarv1s-modules']
MOUNTS = dict(zip(VOLUMES[1:], ['/data/vaults','/app/.cache/huggingface',
              '/data/cli-tools','/data/cli-auth','/run/jarv1s',
              '/run/moss-sports-browser','/data/modules']))
PIN_PATHS = ['Dockerfile','.dockerignore','pnpm-lock.yaml','package.json',
             'scripts/start-jarv1s.ts','tests/uat/seed/cli.ts',
             'packages/chat/src/attachments-routes.ts',
             'packages/cli-runner/src/uid-allocator.ts']
# Copied from R4: its service-account probe pins the original seven inputs plus startup paths.
R4_PIN_PATHS = PIN_PATHS[:7]
STARTUP_PIN_PATHS = ['scripts/migrate.ts','scripts/module-reconcile.ts','scripts/module-install.ts',
                     'packages/db/src/index.ts','packages/jobs/src/index.ts',
                     'packages/module-registry/src/index.ts','packages/module-registry/src/node.ts',
                     'packages/module-sdk/src/index.ts','packages/cli-runner/src/index.ts',
                     'packages/cli-runner/src/main-entry.ts','packages/cli-runner/src/main.ts',
                     'tests/uat/seed/guard.ts']
BUILT_READ_PATHS = ['dist/server.js','dist/worker.js','dist/local-embedding-worker.js',
                    'dist/pdf.worker.mjs','dist/pattern-worker.mjs','apps/web/dist/index.html',
                    'packages/sports/dist/browser-sidecar.mjs']
SIGNIN_WAIT_MS = 600_000
os.umask(0o077)


def save(p, value):
    p.write_text(json.dumps(value, indent=2) + '\n')
    p.chmod(0o600)


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


class Campaign:
    def __init__(self, directory, phase, host):
        self.d = directory
        self.statefile = directory / 'state.json'
        self.s = json.loads(self.statefile.read_text())
        self.phase = phase
        if phase == 'test':
            self.work_deadline = time.monotonic() + 12_000
            self.deadline = min(self.work_deadline,time.monotonic()+240)
        else:
            # R4 build budget; release runs only under its own cleanup deadline.
            self.work_deadline = None
            self.deadline = time.monotonic() + (1100 if phase == 'build' else 0)
        self.cleanup_deadline = None
        self.seq = 0
        self.command_lock = threading.RLock()
        self.host = host
        self.env = {'PATH':'/usr/local/bin:/usr/bin:/bin', 'HOME':str(directory/'home'),
                    'LANG':'C.UTF-8', 'DOCKER_CONFIG':str(directory/'docker-config'),
                    'TMPDIR':str(directory/'tmp'), 'DOCKER_BUILDKIT':'1',
                    'DOCKER_HOST':host}
        for n in ['home','docker-config','tmp','evidence','control']:
            (directory/n).mkdir(mode=0o700, exist_ok=True)
        (directory/'docker-config'/'config.json').write_text('{}\n')
        self.docker = [shutil.which('docker') or '/usr/bin/docker','--host',host]

    def persist(self):
        save(self.statefile,self.s)

    def command(self, *args, **kwargs):
        with self.command_lock:
            return self.command_serial(*args, **kwargs)

    def command_serial(self, args, seconds=30, check=True, capture=False, stdin_file=None, silent=False):
        limit = self.cleanup_deadline or self.deadline
        budget = min(seconds, max(0,limit-time.monotonic()))
        if budget <= 0:
            raise RuntimeError('phase deadline exhausted')
        self.seq += 1
        stem=f'{self.phase}-{self.seq:03d}'
        rec={'argv':args,'timeoutSeconds':budget,'started':time.time()}
        save(self.d/'evidence'/f'{stem}.json',rec)
        def child_limits():
            resource.setrlimit(resource.RLIMIT_FSIZE,(8*1024*1024,8*1024*1024))
        if silent and capture:
            raise RuntimeError('sensitive command cannot capture output')
        outpath=Path(os.devnull) if silent else self.d/'evidence'/f'{stem}.stdout'
        errpath=Path(os.devnull) if silent else self.d/'evidence'/f'{stem}.stderr'
        with outpath.open('wb') as out, errpath.open('wb') as err:
            p=subprocess.Popen(args,stdin=stdin_file if stdin_file is not None else subprocess.DEVNULL,stdout=out,stderr=err,
                               env=self.env,preexec_fn=child_limits)
            try:
                code=p.wait(timeout=budget)
            except BaseException:
                # Only this retained direct child is signalled; no PID/PGID guessing.
                if p.poll() is None:
                    p.kill()
                p.wait(timeout=10)
                rec.update(exitCode=p.returncode,interrupted=True,finished=time.time())
                save(self.d/'evidence'/f'{stem}.json',rec)
                raise
        rec.update(exitCode=code,finished=time.time())
        save(self.d/'evidence'/f'{stem}.json',rec)
        if check and code:
            raise RuntimeError(f'{stem}: nonzero exit {code}; private logs retained')
        raw=b'' if silent else (self.d/'evidence'/f'{stem}.stdout').read_bytes()
        if capture:
            return code,raw.decode('utf-8',errors='strict').strip()
        return code

    def dk(self,*args,**kw):
        return self.command(self.docker+list(args),**kw)

    def bx(self,*args,**kw):
        # Retain the plugin itself: timeout kills/waits its original process.
        # No operator Docker config, auth or plugin search directory is exposed.
        if sha(BUILDX)!=BUILDX_SHA:
            raise RuntimeError('pinned Buildx executable changed')
        return self.command([str(BUILDX),*args],**kw)

    def inspect(self,kind,name):
        # Absence requires a successful scoped listing. Transport/daemon errors never mean absent.
        if kind!='image':
            args=[kind,'ls','--format','{{.Names}}' if kind=='container' else '{{.Name}}']
            if kind=='container':
                args.insert(2,'--all')
            args += ['--filter','name='+name]
            _,listed=self.dk(*args,capture=True)
            if name not in listed.splitlines():
                return None
        _,raw=self.dk(kind,'inspect',name,capture=True)
        return json.loads(raw)[0]

    def pin_daemon(self):
        _,identity=self.dk('info','--format','{{.ID}}',capture=True)
        if not identity:
            raise RuntimeError('missing daemon ID')
        if self.s.get('daemonId',identity)!=identity:
            raise RuntimeError('selected daemon changed')
        self.s['daemonId']=identity
        self.persist()

    def label(self):
        return ['--label',f'{LABEL}={self.s["nonce"]}']

    def assert_owned(self,kind,name):
        item=self.inspect(kind,name)
        if item is None:
            return None
        labels=(item.get('Config',{}).get('Labels',{}) if kind=='container'
                else item.get('Labels',{})) or {}
        if labels.get(LABEL)!=self.s['nonce']:
            raise RuntimeError(f'ownership mismatch: {kind} {name}')
        return item

    def oneshot(self,name,seconds):
        self.dk('start',name)
        _,result=self.dk('wait',name,seconds=seconds,capture=True)
        self.dk('logs',name,check=False)
        if result!='0':
            raise RuntimeError(f'one-shot {name} exited {result}')

    def build(self):
        self.pin_daemon()
        if self.s.get('buildAttempted'):
            raise RuntimeError('one build attempt only; no automatic retry')
        self.s['buildAttempted']=True
        self.persist()
        for image in [PG,BUILDKIT]:
            if not self.inspect('image',image):
                raise RuntimeError('required preexisting pinned dependency image absent')
        builder=self.s['project']+'-builder'
        cname='buildx_buildkit_'+builder+'0'
        vname=cname+'_state'
        if self.inspect('container',cname) or self.inspect('volume',vname):
            raise RuntimeError('builder resource name already occupied')
        self.s.update(builder=builder,builderContainer=cname,builderVolume=vname)
        self.persist()
        error=None
        try:
            self.bx('create','--name',builder,'--driver','docker-container',
                    '--driver-opt','image='+BUILDKIT,'--driver-opt','memory=8g',
                    '--driver-opt','memory-swap=8g','--driver-opt','cpu-period=100000',
                    '--driver-opt','cpu-quota=200000',seconds=30)
            self.bx('inspect',builder,'--bootstrap',seconds=90)
            worker=self.inspect('container',cname)
            if not worker or worker['Image']!=BUILDKIT:
                raise RuntimeError('builder worker image identity mismatch')
            if worker['HostConfig'].get('Memory')!=8*1024**3:
                raise RuntimeError('builder worker memory cap mismatch')
            self.s['builderContainerId']=worker['Id']
            self.persist()
            self.dk('update','--pids-limit','512',cname)
            tag='ghcr.io/motioneso/moss:'+self.s['project']
            self.s['imageTag']=tag
            self.persist()
            # Second, unowned protection: the prune skips this label for up to 3 days after build.
            self.bx('build','--builder',builder,'--load','--tag',tag,
                    '--label','keep-from-prune=true',
                    '--build-arg','JARVIS_GIT_COMMIT='+SOURCE,
                    '--build-arg','JARVIS_APP_VERSION='+self.s['project'],
                    '--metadata-file',str(self.d/'evidence'/'build-metadata.json'),
                    '--file',str(self.d/'Dockerfile'),
                    '--progress','plain',str(self.d/'source'),seconds=900)
            image=self.inspect('image',tag)
            if not image:
                raise RuntimeError('build did not load image')
            self.s['imageId']=image['Id']
            self.persist()
            # The hourly prune keeps any image a container references; hold it before anything else.
            self.hold_image()
            env=image['Config']['Env']
            if 'JARVIS_GIT_COMMIT='+SOURCE not in env:
                raise RuntimeError('image embedded source mismatch')
            if (image['Config'].get('Labels') or {}).get('keep-from-prune')!='true':
                raise RuntimeError('image keep label missing')
            self.s['buildSucceeded']=True
            self.persist()
        except BaseException as exc:
            error=repr(exc)
        finally:
            signal.signal(signal.SIGTERM,signal.SIG_IGN)
            signal.signal(signal.SIGINT,signal.SIG_IGN)
            self.cleanup_deadline=time.monotonic()+120
            self.bx('rm','--force',builder,seconds=60,check=False)
            if self.inspect('container',cname) or self.inspect('volume',vname):
                error=(error or '')+' builder cleanup incomplete'
            self.s['builderCleanupPassed']=not bool(self.inspect('container',cname) or
                                                   self.inspect('volume',vname))
            self.persist()
            if error:
                self.release_after_failure()
        if error:
            raise RuntimeError(error)
        arm_signals()
        self.cleanup_deadline=None
        self.deadline=time.monotonic()+600
        try:
            self.source_probe()
        except BaseException:
            signal.signal(signal.SIGTERM,signal.SIG_IGN)
            signal.signal(signal.SIGINT,signal.SIG_IGN)
            self.cleanup_deadline=time.monotonic()+120
            errors=self.cleanup()
            self.s['cleanupErrors']=errors
            self.persist()
            raise

    def hold_image(self):
        # Created, never started: it only keeps the built image referenced until owned cleanup.
        hold=self.s['project']+'-image-hold'
        self.s['holdContainer']=hold
        self.persist()
        self.dk('create','--name',hold,*self.label(),'--label',HOLD_KEY+'=image-hold',
                '--network','none','--log-driver','none','--entrypoint','/bin/true',
                self.s['imageId'])
        self.verify_hold()
        self.s['holdCreatedAt']=time.time()
        self.persist()

    def verify_hold(self):
        item=self.assert_owned('container',self.s.get('holdContainer') or '')
        if (not item or item['Image']!=self.s['imageId'] or item['State']['Status']!='created'
                or (item['Config'].get('Labels') or {}).get(HOLD_KEY)!='image-hold'):
            raise RuntimeError('image hold container missing or changed')
        if self.s.setdefault('holdContainerId',item['Id'])!=item['Id']:
            raise RuntimeError('image hold container identity drift')
        self.persist()
        return item

    def image_ids(self,reference=None):
        args=['image','ls','--all','--no-trunc','--format','{{.ID}}']
        if reference:
            args+=['--filter','reference='+reference]
        _,listed=self.dk(*args,capture=True)
        return listed.splitlines()

    def release_image_hold(self):
        # Hold container first, then the owned tag; each removal is proven by a successful listing.
        self.s['imageReleaseStarted']=True
        self.persist()
        hold=self.s.get('holdContainer')
        if hold:
            item=self.assert_owned('container',hold)
            if item:
                if (item['Id']!=self.s.get('holdContainerId',item['Id'])
                        or item['State']['Status']!='created'):
                    raise RuntimeError('image hold container identity drift')
                self.dk('rm',item['Id'],seconds=10)
            if self.inspect('container',hold):
                raise RuntimeError('image hold container remains')
        self.s['holdContainerRemovedVerified']=True
        self.persist()
        tag,image_id=self.s.get('imageTag'),self.s.get('imageId')
        if tag:
            listed=self.image_ids(tag)
            if listed:
                if not image_id or listed!=[image_id]:
                    raise RuntimeError('owned image tag identity drift; no removal')
                if self.inspect('image',image_id).get('RepoTags')!=[tag]:
                    raise RuntimeError('image reference ownership changed; no removal')
                _,users=self.dk('container','ls','--all','--quiet','--filter','ancestor='+image_id,capture=True)
                if users:
                    raise RuntimeError('image still used by a container; no removal')
                self.dk('image','rm',tag,seconds=45)
            if self.image_ids(tag):
                raise RuntimeError('owned image tag remains')
        self.s['imageTagRemovedVerified']=True
        self.persist()
        if image_id and image_id in self.image_ids():
            raise RuntimeError('owned image remains')
        self.s['imageIdAbsentVerified']=True
        self.persist()

    def release_after_failure(self):
        self.cleanup_deadline=time.monotonic()+90
        try:
            self.release_image_hold()
        except Exception as exc:
            self.s['imageReleaseErrors']=[str(exc)]
            self.persist()

    def source_probe(self):
        image = self.s['imageId']
        self.verify_hold()
        inputs=json.loads((self.d/'source-inputs.json').read_text())
        paths=set(R4_PIN_PATHS+STARTUP_PIN_PATHS)
        paths.update(p for p,v in inputs.items() if 'sha256' in v and p.endswith('.sql')
                     and (p.startswith('infra/postgres/') or re.match(r'^packages/[^/]+/sql/',p)))
        expected={p:sha(self.d/'source'/p) for p in sorted(paths)}
        script=('const fs=require("fs"),c=require("crypto");'
                'if(process.getuid()!==1000||process.getgid()!==1000)process.exit(3);const e='
                +json.dumps(expected)+';for(const [p,h] of Object.entries(e)){'
                'if(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")!==h)process.exit(2)};'
                'const built='+json.dumps(BUILT_READ_PATHS)+';for(const p of built){'
                'if(!fs.readFileSync(p).length)process.exit(4)};'
                'const assets=fs.readdirSync("apps/web/dist/assets");'
                'if(!assets.length||assets.length>4096)process.exit(5);'
                'for(const p of assets){fs.accessSync("apps/web/dist/assets/"+p,fs.constants.R_OK)};'
                'for(const p of ["node_modules/.bin/tsx","node_modules/.bin/playwright","/usr/bin/setpriv","/usr/bin/tmux"]){'
                'fs.accessSync(p,fs.constants.R_OK|fs.constants.X_OK)};'
                'console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),'
                'hashedSourceFiles:Object.keys(e).length,readableBuiltFiles:built.length,readableWebAssets:assets.length}))')
        if len(script.encode())>96*1024:
            raise RuntimeError('fixed source probe exceeds bounded argv size')
        save(self.d/'evidence'/'source-probe-inputs.json',
             {'uid':1000,'gid':1000,'expected':expected,'builtReadPaths':BUILT_READ_PATHS,
              'webAssetDirectory':'apps/web/dist/assets'})
        probe=self.create_command('build-source-probe',image,['--network','none','--read-only',
                 '--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true',
                 '--entrypoint','node'],['-e',script])
        self.oneshot(probe,30)
        self.dk('rm',self.owned_container_id(probe),seconds=10)
        if self.inspect('container',probe):
            raise RuntimeError('The completed source probe container remains.')
        self.s['serviceUidSourceProbePassed']=True
        self.persist()

    def release(self):
        # Recovery only, for a held image whose test phase never reached its own cleanup.
        self.cleanup_deadline=time.monotonic()+120
        self.pin_daemon()
        if not self.s.get('holdContainer') or self.s.get('imageIdAbsentVerified'):
            raise RuntimeError('no held image to release')
        for name in self.s.get('containers',[]):
            if self.inspect('container',name):
                raise RuntimeError('campaign containers remain; owned stack recovery comes first')
        self.release_image_hold()
        save(self.d/'evidence'/'image-release.json',{'holdContainer':self.s['holdContainer'],
             'holdContainerRemovedVerified':True,'imageTag':self.s.get('imageTag'),
             'imageId':self.s.get('imageId'),'imageTagRemovedVerified':True,
             'imageIdAbsentVerified':True,'daemonId':self.s['daemonId']})

    def setup(self):
        image=self.s['imageId']
        network=self.s['project']+'-net'
        self.s['network']=network
        egress=self.s['project']+'-egress'
        self.s['egressNetwork']=egress
        for v in VOLUMES:
            self.s['volumes'].append(self.s['project']+'_'+v)
        self.persist()
        # Fail closed before any resource or sign-in link exists if the hold or image is gone.
        self.verify_hold()
        if self.inspect('image',self.s['imageTag'])['Id']!=image:
            raise RuntimeError('nonce image tag drift')
        self.s['holdVerifiedBeforeTest']=True
        self.persist()
        for kind,names in [('network',[network,egress]),('volume',self.s['volumes'])]:
            for name in names:
                if self.inspect(kind,name):
                    raise RuntimeError('reserved resource already exists')
        # Sole operator handoff surface: empty, private, owned by the browser's UID 1000.
        signin=self.d/'signin'
        self.s['signinDir']=str(signin)
        self.persist()
        signin.mkdir(mode=0o700)
        meta=os.lstat(signin)
        if (not stat.S_ISDIR(meta.st_mode) or meta.st_mode & 0o777!=0o700
            or meta.st_uid!=1000 or meta.st_gid!=1000 or os.listdir(signin)):
            raise RuntimeError('sign-in handoff directory unsafe')
        self.s['portClaimOwner']=self.s['project']
        self.persist()
        _,claimed=self.command([str(DEVPORTS),'claim',self.s['portClaimOwner']],seconds=15,capture=True)
        if not claimed.isdecimal() or not 5180<=int(claimed)<=5299:
            raise RuntimeError('devports returned invalid claimed port')
        self.s['port']=int(claimed)
        self.persist()
        claim=Path('/tmp/devports')/claimed/'owner'
        if claim.read_text().strip()!=self.s['portClaimOwner']:
            raise RuntimeError('claimed port owner mismatch')
        expected={p:sha(self.d/'source'/p) for p in PIN_PATHS}
        script='const fs=require("fs"),c=require("crypto"); const e='+json.dumps(expected)+'; for(const [p,h] of Object.entries(e)){if(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")!==h)process.exit(2)}'
        probe=self.create_command('source-probe',image,['--network','none','--read-only',
                 '--cap-drop','ALL','--security-opt','no-new-privileges:true',
                 '--entrypoint','node'],['-e',script])
        self.oneshot(probe,30)
        self.dk('network','create','--internal',*self.label(),network)
        net=self.assert_owned('network',network)
        if not net or net.get('Internal') is not True:
            raise RuntimeError('network is not internal')
        self.s['networkId']=net['Id']
        self.persist()
        self.dk('network','create',*self.label(),egress)
        ext=self.assert_owned('network',egress)
        if not ext or ext.get('Internal') is not False or ext.get('Driver')!='bridge':
            raise RuntimeError('egress bridge identity/config mismatch')
        self.s['egressNetworkId']=ext['Id']
        self.persist()
        for name in self.s['volumes']:
            self.dk('volume','create',*self.label(),name)
            vol=self.assert_owned('volume',name)
            self.s.setdefault('volumeInventory',{})[name]={'Name':vol['Name'],'CreatedAt':vol.get('CreatedAt'),'Driver':vol['Driver']}
            self.persist()
        # No operator auth/home binds; all environment values are throwaway fixtures.
        env=self.fixture_env(strict_real=True)
        self.s['envKeys']=sorted(env)
        self.persist()
        ef=self.d/'fixture.env'
        ef.write_text(''.join(k+'='+v+'\n' for k,v in sorted(env.items())))
        ef.chmod(0o600)
        # Fail closed before any container exists, so before any sign-in link can.
        self.assert_strict_real_env(env,ef)
        common=['--network',network,'--dns','127.0.0.1','--env-file',str(ef),
                '--security-opt','no-new-privileges:true']
        pg=self.create_command('postgres',PG,['--network',network,'--dns','127.0.0.1','--network-alias','postgres',
                '--env','POSTGRES_DB=jarv1s','--env','POSTGRES_USER=postgres',
                '--env','POSTGRES_PASSWORD=postgres','--mount',
                'type=volume,src='+self.s['project']+'_jarv1s-postgres-data,dst=/var/lib/postgresql/data'],[])
        self.dk('start',pg)
        # Finite readiness, not repeated workload execution.
        ready=False
        for _ in range(30):
            code=self.dk('exec',pg,'pg_isready','-U','postgres','-d','jarv1s',check=False)
            if code==0:
                ready=True
                break
            time.sleep(1)
        if not ready:
            raise RuntimeError('postgres readiness deadline')
        migrate=self.create_command('migrate',image,common,
                 ['node_modules/.bin/tsx','scripts/migrate.ts'])
        self.oneshot(migrate,180)
        init=self.create_command('socket-init',image,['--network','none','--read-only',
                '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','FOWNER','--cap-add','FSETID',
                '--mount','type=volume,src='+self.s['project']+'_jarv1s-sports-browser-socket,dst=/run/moss-sports-browser'],
                ['sh','-c','chown 0:1001 /run/moss-sports-browser && chmod 2770 /run/moss-sports-browser'])
        self.oneshot(init,30)
        # Only app/CLI-runner gets external egress and a functional DNS upstream.
        appargs=['--network',network,'--dns','1.1.1.1','--env-file',str(ef),
                 '--security-opt','no-new-privileges:true',
                 '--network-alias','jarv1s','--group-add','1001','--cap-drop','ALL']
        for cap in ['CHOWN','SETUID','SETGID','FOWNER','KILL']:
            appargs+=['--cap-add',cap]
        for vol,target in MOUNTS.items():
            appargs+=['--mount','type=volume,src='+self.s['project']+'_'+vol+',dst='+target]
        appargs+=['--mount','type=bind,src='+str(self.d/'control')+',dst=/data/control']
        self.assert_strict_real_env(env,ef,appargs)
        app=self.create_command('app',image,appargs,['node_modules/.bin/tsx','scripts/start-jarv1s.ts'])
        app_id=self.s['containerIds'][app]
        self.dk('network','connect',egress,app_id)
        connected=self.assert_owned('container',app)
        if set(connected['NetworkSettings']['Networks'])!={network,egress}:
            raise RuntimeError('unexpected app network membership')
        self.s['appContainer']=app
        # Durable before the app can mint anything: cleanup must stop it and sweep CLI-auth.
        self.s['claudeCredentialIntent']={'tokenStore':'.jarvis/cli-tokens/anthropic',
                                          'homes':'/data/cli-auth and /data/cli-auth/agents/*'}
        self.persist()
        self.dk('start',app_id)
        seedargs=common+['--user','1000:1000']
        for v in ['jarv1s-vault-data','jarv1s-modules']:
            seedargs+=['--mount','type=volume,src='+self.s['project']+'_'+v+',dst='+MOUNTS[v]]
        # Same original 1133 seed; provider bring-up remains in original strict sign-in helper.
        self.assert_strict_real_env(env,ef,seedargs)
        seed=self.create_command('seed',image,seedargs,
                ['node_modules/.bin/tsx','tests/uat/seed/cli.ts'])
        # Wait until supervisor prepared volume ownership and migrated/reconciled.
        ready=False
        for _ in range(45):
            code=self.dk('exec',app,'node','-e',
                 f"fetch('http://127.0.0.1:{self.s['port']}/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",check=False)
            if code==0:
                ready=True
                break
            time.sleep(2)
        if not ready:
            raise RuntimeError('app readiness deadline')
        self.oneshot(seed,90)

    def test(self):
        self.pin_daemon()
        if (not self.s.get('buildSucceeded') or not self.s.get('builderCleanupPassed')
                or not self.s.get('serviceUidSourceProbePassed') or not self.s.get('holdContainer')
                or self.s.get('imageReleaseStarted')):
            raise RuntimeError('Own build and held image are required.')
        if self.s.get('testAttempted'):
            raise RuntimeError('The campaign has already been attempted.')
        self.s.update(testAttempted=True, specResults=[], full1133Accepted=False,
                      stage4Accepted=False, accepted=False)
        self.persist()
        failure = None
        try:
            self.setup()
            self.deadline = self.work_deadline
            self.write_adapters()
            with HelperBridge(self) as bridge:
                for index, spec in enumerate(SPECS):
                    if index:
                        self.reset_fixture(index, spec[2])
                    passed = self.run_spec(index, spec, bridge)
                    if not passed:
                        failure = 'A spec failed. Later specs were not attempted.'
                        break
            if len(self.s.get('signinWindowsSeconds', [])) != 1:
                failure = failure or 'The campaign did not complete exactly one sign-in.'
            self.s['allEightPassed'] = (len(self.s['specResults']) == len(SPECS)
                                       and all(row['passed'] for row in self.s['specResults'])
                                       and failure is None)
        except BaseException as exc:
            failure = repr(exc)
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            self.cleanup_deadline = time.monotonic() + 300
            errors = self.cleanup()
            attempted = {row['spec'] for row in self.s['specResults']}
            for name, seconds, profile, titles in SPECS:
                if name not in attempted:
                    self.s['specResults'].append({
                        'spec': name, 'passed': False, 'status': 'not-run',
                        'tests': [{'title': title, 'status': 'not-run', 'passed': False}
                                  for title in titles],
                        'modelCalls': None, 'reason': failure or 'Campaign stopped.',
                    })
            self.s.update(failure=failure, cleanupErrors=errors, accepted=False,
                          full1133Accepted=False, stage4Accepted=False)
            self.persist()
            save(self.d/'evidence'/'campaign-result.json', {
                key: self.s.get(key) for key in ['source', 'specResults', 'allEightPassed',
                    'failure', 'cleanupErrors', 'signinWindowsSeconds',
                    'full1133Accepted', 'stage4Accepted']})
        if failure or errors:
            raise RuntimeError('Campaign stopped. Private results and cleanup evidence are retained.')

    def reset_fixture(self, index, profile):
        app = self.owned_container_id(self.s['appContainer'])
        self.dk('stop', '--time', '10', app, seconds=20)
        observed = self.assert_owned('container', self.s['appContainer'])
        if observed['State']['Running'] or observed['State'].get('Pid', 0):
            raise RuntimeError('The previous provider and worker did not stop.')
        pg = self.owned_container_id(self.s['project']+'-postgres')
        self.dk('exec', pg, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
                '-c', 'DROP DATABASE jarv1s WITH (FORCE)', seconds=30)
        self.dk('exec', pg, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
                '-c', 'CREATE DATABASE jarv1s', seconds=30)
        common = ['--network', self.s['network'], '--dns', '127.0.0.1',
                  '--env-file', str(self.d/'fixture.env'),
                  '--security-opt', 'no-new-privileges:true']
        migrate = self.create_command('migrate-'+str(index), self.s['imageId'], common,
                                      ['node_modules/.bin/tsx', 'scripts/migrate.ts'])
        self.oneshot(migrate, 180)
        self.dk('start', app)
        self.wait_ready()
        args = common + ['--user', '1000:1000', '--env', 'JARVIS_UAT_SEED_LEVEL='+profile]
        for volume in ['jarv1s-vault-data', 'jarv1s-modules']:
            args += ['--mount', 'type=volume,src='+self.s['project']+'_'+volume+',dst='+MOUNTS[volume]]
        seed = self.create_command('seed-'+str(index), self.s['imageId'], args,
                                   ['node_modules/.bin/tsx', 'tests/uat/seed/cli.ts'])
        self.oneshot(seed, 90)
        self.s.setdefault('fixtureResets', []).append({
            'beforeSpec': index, 'profile': profile, 'databaseRecreated': True,
            'previousProviderAndWorkerStopped': True, 'credentialVolumeReused': True})
        self.persist()

    def wait_ready(self):
        for unused in range(45):
            code = self.dk('exec', self.owned_container_id(self.s['appContainer']), 'node', '-e',
                f"fetch('http://127.0.0.1:{self.s['port']}/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
                check=False)
            if code == 0:
                return
            time.sleep(2)
        raise RuntimeError('Application readiness deadline expired.')

    def write_adapters(self):
        adapter = self.d/'adapter'
        adapter.mkdir(mode=0o700)
        for filename, content in ADAPTERS.items():
            path = adapter/filename
            path.write_text(content)
            path.chmod(0o555 if filename in ['docker', 'chrome'] else 0o444)
        source = self.d/'source'/'tests'/'uat'/'specs'
        scripts = set()
        for name in ['3136-repeating-reminders-real', '3138-repeating-useful-checks-real']:
            body = (source/(name+'.uat.spec.ts')).read_text()
            for literal in re.findall(r'"(const fs=.*?)"', body):
                scripts.add(json.loads('"'+literal+'"'))
        if len(scripts) != 2:
            raise RuntimeError('Pinned worker inspection scripts changed.')
        self.worker_scripts = scripts
        self.s['adapterHashes'] = {name: sha(adapter/name) for name in ADAPTERS}
        self.persist()

    def run_spec(self, index, spec, bridge):
        name, seconds, profile, titles = spec
        evidence = self.d/'evidence'/name
        evidence.mkdir(mode=0o700)
        result = {'spec': name, 'deadlineSecondsPerTest': seconds, 'seed': profile,
                  'passed': False, 'status': 'failed', 'modelCalls': None,
                  'tests': [{'title': title, 'passed': False, 'status': 'not-run'} for title in titles],
                  'creationEvidence': 'unknown', 'evidenceDirectory': str(evidence)}
        self.s['specResults'].append(result)
        self.persist()
        started = time.time()
        self.current_evidence = evidence
        bridge.failure = None
        browser = None
        failure = None
        try:
            self.verify_hold()
            self.s['providerAccounting'] = {
                'route': 'Claude sign-in through the application', 'upstreamCalls': None,
                'tokens': None, 'price': None, 'quota': None,
                'modelWitness': 'Original helper annotations and console output in each report.'}
            environment = {
                'HOME': '/tmp/home', 'MOSS_UAT_CAPTURE_OFF': '1', 'MOSS_UAT_BROWSER': 'chromium',
                'JARVIS_UAT_REQUIRE_REAL_CHAT': '1', 'JARVIS_UAT_REAL_CHAT_CONFIGURED': '1',
                'JARVIS_UAT_REAL_CHAT_PROVIDER': 'claude', 'JARVIS_UAT_CLAUDE_SIGNIN_DIR': '/signin',
                'JARVIS_UAT_CLAUDE_SIGNIN_WAIT_MS': str(SIGNIN_WAIT_MS),
                'JARVIS_UAT_BASE_URL': f"http://jarv1s:{self.s['port']}",
                'JARVIS_UAT_PROJECT_NAME': self.s['project'],
                'PATH': '/adapter:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                'NODE_OPTIONS': '--require=/adapter/observe.cjs', 'R19_EVIDENCE': '/result',
                'R19_BRIDGE': '/bridge/helper.sock', 'R19_DEADLINE_MS': str(seconds*1000),
                'R19_SECURE_ORIGIN': f"http://jarv1s:{self.s['port']}",
                'JARVIS_UAT_CLAUDE_TOKEN_REUSED': '1' if index else '0',
            }
            args = ['--init', '--network', self.s['network'], '--dns', '127.0.0.1', '--user', '1000:1000',
                    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                    '--shm-size', '256m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m']
            for key, value in environment.items():
                args += ['--env', key+'='+value]
            for host, target, readonly in [
                (self.d/'source'/'tests'/'uat', '/app/tests/uat', True),
                (self.d/'adapter', '/adapter', True), (evidence, '/result', False),
                (self.d/'bridge', '/bridge', True), (self.d/'signin', '/signin', False),
            ]:
                args += ['--mount', 'type=bind,src='+str(host)+',dst='+target+(',readonly' if readonly else '')]
            args += ['--mount', 'type=bind,src='+str(self.d/'adapter'/'chrome')+
                     ',dst=/opt/google/chrome/chrome,readonly']
            browser = self.create_command('browser-'+str(index), self.s['imageId'], args,
                ['xvfb-run', '-a', '--server-args=-screen 0 1280x900x24',
                 'node_modules/.bin/playwright', 'test', name+'.uat.spec.ts',
                 '--config=/adapter/config.ts', '--workers=1', '--retries=0',
                 '--global-timeout='+str((seconds*len(titles)+SIGNIN_WAIT_MS//1000+60)*1000),
                 '--output=/result/test-results'])
            self.s['browserContainer'] = browser
            self.persist()
            self.browser_mono = time.monotonic()
            self.browser_epoch = time.time()*1000
            self.active_approval = 0.0
            self.dk('start', browser)
            self.monitor_spec(browser, evidence, seconds, len(titles), bridge)
            observed = self.assert_owned('container', browser)
            result['containerExitCode'] = observed['State']['ExitCode']
        except BaseException as exc:
            failure = repr(exc)
        finally:
            self.deadline = self.work_deadline
            if browser:
                self.dk('stop', '--time', '5', self.owned_container_id(browser), seconds=15, check=False)
            self.dk('stop', '--time', '10', self.owned_container_id(self.s['appContainer']), seconds=20)
            observed = self.assert_owned('container', self.s['appContainer'])
            if observed['State']['Running'] or observed['State'].get('Pid', 0):
                raise RuntimeError('Provider shutdown could not be verified between specs.')
            self.collect_spec_evidence(evidence, started, result)
            report_path = evidence/'playwright.json'
            if report_path.exists() and report_path.stat().st_size <= 8*1024*1024:
                try:
                    report = json.loads(report_path.read_text())
                    actual = []
                    def visit(suites):
                        for suite in suites:
                            for case in suite.get('specs', []):
                                for item in case.get('tests', []):
                                    actual.append((case['title'], item))
                            visit(suite.get('suites', []))
                    visit(report.get('suites', []))
                    exact = [title for title, unused in actual] == titles
                    rows = []
                    for title, item in actual:
                        attempts = item.get('results', [])
                        timing = next((row for row in result.get('caseDeadlineEvidence', [])
                                       if row['title'] == title), None)
                        passed = (item.get('status') == 'expected' and item.get('expectedStatus') == 'passed'
                                  and len(attempts) == 1 and attempts[0].get('status') == 'passed'
                                  and attempts[0].get('retry', 0) == 0 and timing is not None
                                  and type(attempts[0].get('duration')) in (int, float)
                                  and 0 <= attempts[0]['duration'] <= seconds*1000+timing['approvalMs'])
                        rows.append({'title': title, 'passed': passed,
                                     'status': attempts[0].get('status') if attempts else 'not-run',
                                     'durationMs': attempts[0].get('duration') if attempts else None,
                                     'attemptCount': len(attempts), 'annotations': item.get('annotations', [])})
                    result['tests'] = [next((row for row in rows if row['title'] == title),
                                           {'title': title, 'passed': False, 'status': 'not-run'})
                                       for title in titles]
                    result['unexpectedTests'] = [row for row in rows if row['title'] not in titles]
                    result['reportErrors'] = report.get('errors', [])
                    result['passed'] = (not failure and result.get('containerExitCode') == 0 and exact
                                        and not report.get('errors') and all(row['passed'] for row in rows)
                                        and result.get('accountingReadSucceeded') is True)
                except (ValueError, KeyError, TypeError) as exc:
                    failure = failure or 'The report could not be verified: '+str(exc)
            else:
                failure = failure or 'The complete browser report is unavailable.'
            for row in result['tests']:
                if row['status'] == 'running':
                    row.update(status='interrupted', passed=False)
            if index >= 6 and result.get('creationEvidence') != 'recorded':
                result['passed'] = False
                failure = failure or 'Creation attempt evidence is incomplete.'
            result.update(status='passed' if result['passed'] else 'failed', failure=failure)
            save(evidence/'result.json', result)
            self.persist()
        return result['passed']

    def monitor_spec(self, browser, evidence, seconds, count, bridge):
        begin = time.monotonic()
        active = begin
        event_count = 0
        completed = 0
        case_evidence = []
        self.s['specResults'][-1]['caseDeadlineEvidence'] = case_evidence
        sign_start = None
        approval = 0.0
        windows = self.s.setdefault('signinWindowsSeconds', [])
        link = self.d/'signin'/(self.s['project']+'.link')
        code = self.d/'signin'/(self.s['project']+'.code')
        while True:
            now = time.monotonic()
            try:
                meta = os.lstat(link)
                if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 1000 or meta.st_mode & 0o077:
                    raise RuntimeError('The sign-in link file is unsafe.')
                present = True
            except FileNotFoundError:
                present = False
            if present and sign_start is None:
                if windows:
                    raise RuntimeError('A second sign-in was requested. No code may be supplied.')
                sign_start = now
                print(f'Sign-in link file: {link}\nWrite the approval code to: {code}', flush=True)
            elif not present and sign_start is not None:
                windows.append(now-sign_start)
                approval += now-sign_start
                sign_start = None
                self.persist()
            waiting = now-sign_start if sign_start is not None else 0.0
            if waiting > SIGNIN_WAIT_MS/1000:
                raise RuntimeError('Sign-in approval deadline expired.')
            events_path = evidence/'events.jsonl'
            if events_path.exists():
                if events_path.stat().st_size > 1024*1024:
                    raise RuntimeError('The test event file exceeded its size limit.')
                lines = events_path.read_text().splitlines()
                for line in lines[event_count:]:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        break
                    event_count += 1
                    if event['kind'] == 'begin':
                        active = self.browser_mono + max(0.0, (event['at']-self.browser_epoch)/1000)
                        self.active_approval = approval
                        for row in self.s['specResults'][-1]['tests']:
                            if row['title'] == event['title']:
                                row['status'] = 'running'
                    elif event['kind'] == 'end':
                        completed += 1
                        excluded = (approval-self.active_approval+waiting)*1000
                        case_evidence.append({'title': event['title'], 'approvalMs': excluded,
                                              'durationMs': event['duration']})
                        for row in self.s['specResults'][-1]['tests']:
                            if row['title'] == event['title']:
                                row.update(status=event['status'], durationMs=event['duration'],
                                           passed=event['status'] == 'passed')
                        self.persist()
                        allowed = seconds*1000 + excluded
                        if event['duration'] > allowed:
                            raise RuntimeError('A test exceeded its original deadline.')
            if bridge.failure:
                raise RuntimeError('The scoped helper failed: '+bridge.failure)
            if now-begin-approval-waiting > seconds*count+60:
                raise RuntimeError('The spec wall-clock deadline expired.')
            if completed < count and now-active-(approval-getattr(self, 'active_approval', 0))-waiting > seconds+1:
                raise RuntimeError('A test exceeded its original deadline.')
            observed = self.assert_owned('container', browser)
            if not observed['State']['Running']:
                if sign_start is not None:
                    windows.append(time.monotonic()-sign_start)
                    self.persist()
                if completed != count:
                    raise RuntimeError('The complete original test event set is unavailable.')
                return
            time.sleep(0.5)

    def collect_spec_evidence(self, evidence, started, result):
        try:
            query = ("SELECT COALESCE(json_agg(t), '[]'::json) FROM "
                     "(SELECT kind, outcome, count(*) AS recorded_events FROM app.moss_model_activity_log "
                     "GROUP BY kind, outcome ORDER BY kind, outcome) t")
            unused, output = self.dk('exec', self.owned_container_id(self.s['project']+'-postgres'),
                'psql', '-U', 'postgres', '-d', 'jarv1s', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
                '-c', query, capture=True)
            result['appReportedModelActivity'] = json.loads(output)
            result['accountingReadSucceeded'] = True
            result['modelCalls'] = None
            save(evidence/'model-activity.json', {'appReportedEvents': result['appReportedModelActivity'],
                 'upstreamCalls': None, 'tokens': None, 'price': None, 'quota': None,
                 'scope': 'Fresh database for this spec. Recorded events are not upstream call counts.'})
        except Exception:
            result['accountingReadSucceeded'] = False
            result['accountingUnavailable'] = True
        with self.command_lock:
            unused, logs = self.dk('logs', '--timestamps', '--since', str(int(started)),
                                   self.owned_container_id(self.s['appContainer']), capture=True)
            logs += '\n'+(self.d/'evidence'/f'{self.phase}-{self.seq:03d}.stderr').read_text()
        refusals = []
        for line in logs.splitlines():
            timestamp, separator, payload = line.partition(' ')
            try:
                record = json.loads(payload)
            except ValueError:
                continue
            if isinstance(record, dict) and record.get('event') == 'chat.scheduled_read_refused':
                refusals.append({'timestamp': timestamp, **record})
        save(evidence/'creation-refusals.json', {
            'events': refusals, 'attemptCorrelation': None,
            'limitation': 'The source does not include an attempt identifier in refusal events.'})
        attempts = evidence/'creation-attempts.jsonl'
        if attempts.exists() and attempts.stat().st_size <= 4*1024*1024:
            rows = [json.loads(line) for line in attempts.read_text().splitlines()]
            source_attempts = [row for row in rows if row.get('path') == '/api/tasks'
                               and row.get('phase') == 'response-complete']
            scheduled_attempts = [row for row in rows if row.get('scheduledRequest')
                                  and row.get('phase') == 'response-complete']
            result['creationEvidence'] = 'recorded' if source_attempts and scheduled_attempts else 'incomplete'
            result['creationAttempts'] = rows
        result['creationFailureCorrelation'] = 'unknown' if refusals else 'not-observed'
        result['historical3503Resolved'] = False

    def create_command(self,role,image,args,command):
        name=f'{self.s["project"]}-{role}'
        self.s['containers'].append(name)
        self.persist()
        self.dk('create','--name',name,*self.label(),'--log-driver','local',
                '--log-opt','max-size=4m','--log-opt','max-file=1','--log-opt','compress=false',
                '--cpus','2','--memory','2g','--memory-swap','2g','--pids-limit','256',
                *args,image,*command)
        item=self.assert_owned('container',name)
        if not item or item['Image']!=image:
            raise RuntimeError('container/image identity mismatch')
        self.s.setdefault('containerIds',{})[name]=item['Id']
        self.persist()
        return name

    def fixture_env(self,strict_real=True):
        if strict_real is not True:
            raise RuntimeError('Only the real sign-in provider is permitted.')
        e={'NODE_ENV':'production','JARVIS_DEPLOY_MODE':'compose',
           'JARVIS_APP_VERSION':self.s['project'],'JARVIS_GIT_COMMIT':SOURCE,
           'PORT':str(self.s['port']),'HOST':'0.0.0.0',
           'JARVIS_AUTH_TRUSTED_ORIGINS':f"http://jarv1s:{self.s['port']}",
           'POSTGRES_PASSWORD':'postgres','BETTER_AUTH_SECRET':'uat-only-not-a-real-secret-00000000000',
           'JARVIS_CONNECTOR_SECRET_KEY':'0'*32,'JARVIS_AI_SECRET_KEY':'1'*32,
           'JARVIS_MODULE_CREDENTIAL_SECRET_KEY':'2'*32,'JARVIS_NEWS_CREDENTIAL_SECRET_KEY':'2'*32,
           'JARVIS_INTEGRATIONS_SECRET_KEY':'3'*32,'JARVIS_CLI_RUNNER_RPC_SECRET':'uat-only-not-real',
           'JARVIS_EMBED_PROVIDER':'stub','JARVIS_ALLOW_STUB_EMBEDDINGS':'1',
           'HF_HOME':'/app/.cache/huggingface','JARVIS_WEB_DIST_DIR':'/app/apps/web/dist',
           'JARVIS_NOTES_ROOTS':'/data/vaults/00000000-0000-4000-8000-000000000001',
           'JARVIS_MODULES_DIR':'/data/modules','JARVIS_HOST_CONTROL_DIR':'/data/control',
           'JARVIS_HOST_UID':'1000','JARVIS_HOST_GID':'1000','JARVIS_CLI_RUNNER_SINGLE_USER':'0',
           'JARVIS_CLI_PER_USER_UID':'1','JARVIS_CLI_HOME':'/data/cli-auth',
           'JARVIS_CLI_HOME_BASE':'/data/cli-auth','JARVIS_CLI_NEUTRAL_BASE':'/data/cli-auth/chat',
           'JARVIS_CHAT_HOME':'/data/cli-auth/chat','JARVIS_CLI_TOOLS_PREFIX':'/data/cli-tools',
           'JARVIS_CLI_RUNNER_SOCKET':'/run/jarv1s/cli-runner.sock','NPM_CONFIG_PREFIX':'/data/cli-tools',
           'JARVIS_MULTIPLEXER':'tmux',
           'JARVIS_MCP_SERVER_URL':f"http://127.0.0.1:{self.s['port']}/api/mcp",
           'MOSS_SPORTS_RENDERER_SOCKET':'/run/moss-sports-browser/renderer.sock',
           'MOSS_RECONCILE_CONFIRM_OWNER_EMAIL':'uat-admin@jarv1s.local',
           'JARVIS_UAT_SEED_CONFIRM':'1','JARVIS_UAT_SEED_LEVEL':'admin+data',
           'JARVIS_UAT_WITHOUT_NEWS_JSON_BINDING':'1',
           'JARVIS_UAT_NEWS_TRANSIENT_INPUT':'uat-transient.invalid'}
        roles={'BOOTSTRAP':('postgres','postgres'),'MIGRATION':('jarvis_migration_owner','uat-migration-pw'),
               'APP':('jarvis_app_runtime','uat-app-pw'),'AUTH':('jarvis_auth_runtime','uat-auth-pw'),
               'WORKER':('jarvis_worker_runtime','uat-worker-pw')}
        for k,(u,p) in roles.items():
            e['JARVIS_'+k+'_DATABASE_URL']=f'postgres://{u}:{p}@postgres:5432/jarv1s'
        return e

    def assert_strict_real_env(self,env,env_file,*argsets):
        # Any scripted-provider route makes Moss's real Claude check run the fixture.
        banned_keys={'JARVIS_UAT_SEED_CHAT_SCRIPT','JARVIS_UAT_SCRIPTED_PROVIDER_BIN',
                     'CLAUDE_CODE_EXECUTABLE','PATH'}
        if banned_keys & set(env):
            raise RuntimeError('strict-real env carries a scripted-provider key')
        if any('scripted-provider' in k or 'scripted-provider' in v for k,v in env.items()):
            raise RuntimeError('strict-real env points at scripted-provider')
        written=env_file.read_text()
        if written!=''.join(k+'='+v+'\n' for k,v in sorted(env.items())):
            raise RuntimeError('strict-real env file drift')
        for line in written.splitlines():
            if line.split('=',1)[0] in banned_keys or 'scripted-provider' in line:
                raise RuntimeError('strict-real env file carries scripted-provider')
        for args in argsets:
            if any('scripted-provider' in a or a.split('=',1)[0] in banned_keys for a in args):
                raise RuntimeError('strict-real container args carry scripted-provider')
        self.s['strictRealEnvVerified']=True
        self.persist()

    def owned_container_id(self,name):
        item=self.assert_owned('container',name)
        recorded=self.s.get('containerIds',{}).get(name)
        if not item or not recorded or recorded!=item['Id']:
            raise RuntimeError('recorded container missing/drifted')
        return recorded

    def clear_signin(self):
        # Link and code are one-time sign-in material; only regular files are expected here.
        if not self.s.get('signinDir'):
            return
        signin=Path(self.s['signinDir'])
        if signin.parent!=self.d or signin.is_symlink():
            raise RuntimeError('sign-in handoff directory identity drift')
        if signin.exists():
            for name in os.listdir(signin):
                entry=signin/name
                if not stat.S_ISREG(os.lstat(entry).st_mode):
                    raise RuntimeError('unexpected sign-in handoff entry')
                entry.unlink()
            signin.rmdir()
        if os.path.lexists(signin):
            raise RuntimeError('sign-in handoff directory remains')
        self.s['signinHandoffRemovedVerified']=True
        self.persist()

    def remove_auth_before_teardown(self):
        if not self.s.get('claudeCredentialIntent'):
            self.clear_signin()
            return
        # Docker stop + State.Running/Pid verification ends the entire provider namespace.
        for role in ['browserContainer','appContainer']:
            name=self.s.get(role)
            if name:
                identity=self.owned_container_id(name)
                self.dk('stop','--time','10',identity,seconds=15)
                item=self.assert_owned('container',name)
                if item['State']['Running'] or item['State'].get('Pid',0)!=0:
                    raise RuntimeError('provider activity not proven stopped')
        if not self.s.get('appContainer'):
            raise RuntimeError('missing app identity for credential cleanup')
        self.s['providerActivityStopped']=True
        self.persist()
        self.clear_signin()
        volume=self.s['project']+'_jarv1s-cli-auth'
        observed=self.assert_owned('volume',volume)
        expected=self.s.get('volumeInventory',{}).get(volume)
        if not observed or {'Name':observed['Name'],'CreatedAt':observed.get('CreatedAt'),'Driver':observed['Driver']}!=expected:
            raise RuntimeError('CLI-auth volume identity drift')
        # No app remains active. Root's sole DAC_OVERRIDE permits deleting and reading owner700
        # files. Paths mirror real-chat-env.ts Claude cleanup across every agent home; the
        # content sweep then proves no setup token survives anywhere in the volume.
        script=("const fs=require('node:fs');const base='/data/cli-auth';const homes=[base];"
                "const agents=base+'/agents';"
                "if(fs.existsSync(agents)){for(const n of fs.readdirSync(agents)){"
                "const h=agents+'/'+n;if(fs.lstatSync(h).isDirectory())homes.push(h)}}"
                "const targets=[];for(const h of homes){const t=h+'/.jarvis/cli-tokens/anthropic';"
                "targets.push(t,t+'.tmp',h+'/.claude/.credentials.json')}"
                "for(const p of targets)fs.rmSync(p,{force:true});"
                "for(const p of targets){try{fs.lstatSync(p);process.exit(4)}catch(e){if(e.code!=='ENOENT')throw e}}"
                "const needle=Buffer.from('sk-ant-oat');"
                "const walk=d=>{for(const n of fs.readdirSync(d)){const p=d+'/'+n;const s=fs.lstatSync(p);"
                "if(s.isDirectory())walk(p);else if(s.isFile()&&fs.readFileSync(p).includes(needle))process.exit(6)}};"
                "walk(base);")
        cleaner=self.create_command('auth-cleaner',self.s['imageId'],
                ['--network','none','--read-only','--user','0:0','--cap-drop','ALL',
                 '--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges:true',
                 '--mount','type=volume,src='+volume+',dst=/data/cli-auth','--entrypoint','node'],['-e',script])
        self.oneshot(cleaner,30)
        self.s['authCopiesRemovedVerified']=True
        self.persist()

    def cleanup(self):
        errors=[]
        # Never destroy auth storage until provider stop and copy removal are proven.
        try:
            self.remove_auth_before_teardown()
        except Exception as exc:
            errors.append('credential cleanup failed; owned resources retained: '+str(exc))
            self.s['imageHoldRetainedForRecovery']=True
            self.persist()
            save(self.d/'evidence'/'cleanup.json',{'errors':errors,'authCopiesRemovedVerified':False,
                 'daemonId':self.s['daemonId'],'resourcesRetainedForOwnedRecovery':True,
                 'imageHoldRetainedForRecovery':True,'holdContainer':self.s.get('holdContainer')})
            return errors
        # Synthetic fixture environment is separate from the real copied credential.
        ef=self.d/'fixture.env'
        if ef.exists():
            ef.unlink()
        for name in reversed(self.s['containers']):
            try:
                item=self.assert_owned('container',name)
                if item:
                    if self.s.get('containerIds',{}).get(name,item['Id'])!=item['Id']:
                        raise RuntimeError('recorded container identity drift')
                    self.dk('logs',name,seconds=5,check=False)
                    self.dk('rm','--force',item['Id'],seconds=10)
                if self.inspect('container',name):
                    raise RuntimeError('container remains')
            except Exception as exc:
                errors.append(str(exc))
        for kind,names in [('volume',self.s['volumes']),('network',[self.s.get('network'),self.s.get('egressNetwork')])]:
            for name in filter(None,names):
                try:
                    item=self.assert_owned(kind,name)
                    if item:
                        if kind=='network' and item['Id']!=self.s.get('egressNetworkId' if name==self.s.get('egressNetwork') else 'networkId',item['Id']):
                            raise RuntimeError('network identity drift')
                        if kind=='volume' and name in self.s.get('volumeInventory',{}):
                            observed={'Name':item['Name'],'CreatedAt':item.get('CreatedAt'),'Driver':item['Driver']}
                            if observed!=self.s['volumeInventory'][name]:
                                raise RuntimeError('volume identity drift')
                        self.dk(kind,'rm',item['Id'] if kind=='network' else name,seconds=10)
                    if self.inspect(kind,name):
                        raise RuntimeError(kind+' remains')
                except Exception as exc:
                    errors.append(str(exc))
        port=self.s.get('port')
        if port is not None:
            try:
                claim=Path('/tmp/devports')/str(port)
                if claim.exists():
                    if (claim/'owner').read_text().strip()!=self.s['portClaimOwner']:
                        raise RuntimeError('port claim owner changed; no release')
                    self.command([str(DEVPORTS),'release',str(port)],seconds=15)
                if claim.exists():
                    raise RuntimeError('owned port claim remains')
                self.s['portClaimAbsent']=True
            except Exception as exc:
                errors.append(str(exc))
        # The image is released last, and only once every other owned resource is proven gone.
        if errors:
            self.s['imageHoldRetainedForRecovery']=True
            self.persist()
        else:
            self.cleanup_deadline=time.monotonic()+90
            try:
                self.release_image_hold()
            except Exception as exc:
                errors.append('image hold release failed: '+str(exc))
        save(self.d/'evidence'/'cleanup.json',{'errors':errors,'daemonId':self.s['daemonId'],
             'claimedPort':port,'portClaimAbsent':self.s.get('portClaimAbsent',False),
             'containers':self.s['containers'],'volumes':self.s['volumes'],
             'network':self.s.get('network'),'egressNetwork':self.s.get('egressNetwork'),
             'fixtureFileAbsent':not ef.exists(),'providerActivityStopped':self.s.get('providerActivityStopped',False),
             'authCopiesRemovedVerified':self.s.get('authCopiesRemovedVerified',False),
             'signinHandoffRemovedVerified':self.s.get('signinHandoffRemovedVerified',False),
             'claudeTokenSavedForReuse':False,
             'imageId':self.s.get('imageId'),'imageTag':self.s.get('imageTag'),
             'holdContainer':self.s.get('holdContainer'),'holdContainerId':self.s.get('holdContainerId'),
             'holdContainerRemovedVerified':self.s.get('holdContainerRemovedVerified',False),
             'imageTagRemovedVerified':self.s.get('imageTagRemovedVerified',False),
             'imageIdAbsentVerified':self.s.get('imageIdAbsentVerified',False),
             'imageHoldRetainedForRecovery':self.s.get('imageHoldRetainedForRecovery',False),
             'sourceAndEvidenceRetainedPrivately':True})
        return errors



ADAPTERS = {
    'config.ts': """import base from '/app/tests/uat/playwright.uat.config.ts';
export default {...base, testDir:'/app/tests/uat/specs', retries:0, workers:1,
  reporter:[['line'],['json',{outputFile:'/result/playwright.json'}],['/adapter/reporter.cjs']]};
""",
    'reporter.cjs': """const fs = require('node:fs');
function emit(value) { fs.appendFileSync('/result/events.jsonl', JSON.stringify({...value,at:Date.now()})+'\\n'); }
module.exports = class {
  onTestBegin(test) { emit({kind:'begin',title:test.title}); }
  onTestEnd(test,result) { emit({kind:'end',title:test.title,status:result.status,duration:result.duration}); }
};
""",
    'chrome': """#!/bin/sh
exec /opt/google/chrome/chrome.real --unsafely-treat-insecure-origin-as-secure="$R19_SECURE_ORIGIN" "$@"
""",
    'docker': """#!/usr/local/bin/node
const net = require('node:net');
const client = net.createConnection(process.env.R19_BRIDGE);
let output = '';
client.setTimeout(95000,()=>{client.destroy();process.exit(124)});
client.on('connect',()=>client.end(JSON.stringify({argv:process.argv.slice(2)})+'\\n'));
client.on('data',chunk=>{output+=chunk;if(output.length>4194304){client.destroy();process.exit(125)}});
client.on('end',()=>{try{const result=JSON.parse(output);process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.code)}catch{process.exit(125)}});
client.on('error',()=>process.exit(125));
""",
    'observe.cjs': """const fs = require('node:fs');
const crypto = require('node:crypto');
const Module = require('node:module');
const originalLoad = Module._load;
const marked = new WeakSet();
let ordinal = 0;
function diagnostics(value, result=[], depth=0) {
  if (!value || typeof value!=='object' || depth>12) return result;
  if (typeof value.keyword==='string') result.push({keyword:value.keyword,schemaPath:typeof value.schemaPath==='string'?value.schemaPath:null,instancePath:typeof value.instancePath==='string'?value.instancePath:null});
  for (const child of Object.values(value)) diagnostics(child,result,depth+1);
  return result;
}
function record(response) {
  const request=response.request();
  const path=new URL(response.url()).pathname;
  if (request.method()!=='POST' || !['/api/tasks','/api/chat/turn'].includes(path)) return;
  const attempt={ordinal:++ordinal,at:Date.now(),path,status:response.status(),scheduledRequest:false};
  const data=request.postData()||'';
  attempt.requestSha256=crypto.createHash('sha256').update(data).digest('hex');
  attempt.scheduledRequest=/Check the status of my task Scheduled source proof \\d+ in 45 seconds/.test(data);
  const filename=process.env.R19_EVIDENCE+'/creation-attempts.jsonl';
  fs.appendFileSync(filename,JSON.stringify({...attempt,phase:'response-headers'})+'\\n');
  response.body().then(body=>{
    if(body.length>1048576) {fs.appendFileSync(filename,JSON.stringify({...attempt,phase:'response-body-unavailable',reason:'size-limit'})+'\\n');return}
    let parsed=null; try{parsed=JSON.parse(body.toString('utf8'))}catch{}
    const taskId=parsed&&typeof parsed.task?.id==='string'?parsed.task.id:null;
    fs.appendFileSync(filename,JSON.stringify({...attempt,phase:'response-complete',bodyBytes:body.length,bodySha256:crypto.createHash('sha256').update(body).digest('hex'),taskId,validation:diagnostics(parsed)})+'\\n');
  }).catch(()=>fs.appendFileSync(filename,JSON.stringify({...attempt,phase:'response-body-unavailable'})+'\\n'));
}
function context(value) {
  if(marked.has(value))return value; marked.add(value);
  value.on('response',record);
  return value;
}
function browser(value) {
  if(marked.has(value))return value; marked.add(value);
  const original=value.newContext;
  value.newContext=async function(...args){return context(await original.apply(this,args))};
  return value;
}
function install(value) {
  for(const name of ['chromium','firefox','webkit']) {
    const type=value?.[name]; if(!type||marked.has(type))continue;marked.add(type);
    for(const method of ['launch','connect','connectOverCDP','launchPersistentContext']) {
      const original=type[method];if(typeof original!=='function')continue;
      type[method]=async function(...args){const result=await original.apply(this,args);return method==='launchPersistentContext'?context(result):browser(result)};
    }
  }
}
Module._load=function(...args){const value=originalLoad.apply(this,args);if(/playwright/.test(String(args[0])))install(value);return value};
""",
}


class HelperBridge:
    def __init__(self, campaign):
        self.campaign = campaign
        self.failure = None
        self.done = threading.Event()
        self.server = None
        self.thread = None

    def __enter__(self):
        directory = self.campaign.d/'bridge'
        directory.mkdir(mode=0o700)
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(directory/'helper.sock'))
        (directory/'helper.sock').chmod(0o600)
        self.server.listen(1)
        self.server.settimeout(0.5)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, kind, value, traceback):
        self.done.set()
        self.thread.join(100)
        self.server.close()
        if self.thread.is_alive():
            raise RuntimeError('The helper bridge did not stop.')

    def serve(self):
        while not self.done.is_set():
            try:
                connection, unused = self.server.accept()
            except socket.timeout:
                continue
            with connection:
                connection.settimeout(5)
                content = b''
                try:
                    while b'\n' not in content:
                        chunk = connection.recv(65536)
                        if not chunk:
                            break
                        content += chunk
                        if len(content) > 1024*1024:
                            raise RuntimeError('Helper request exceeds the size limit.')
                    request = json.loads(content)
                    output = self.dispatch(request['argv'])
                    connection.sendall(json.dumps(output).encode())
                except Exception as exc:
                    self.failure = type(exc).__name__
                    try:
                        connection.sendall(json.dumps({'code':125,'stderr':'Scoped helper refused the request.'}).encode())
                    except OSError:
                        pass

    def dispatch(self, args):
        campaign = self.campaign
        if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
            raise RuntimeError('Invalid helper arguments.')
        prefix = ['compose', '-p', campaign.s['project'], '-f', 'infra/docker-compose.prod.yml',
                  '-f', 'tests/uat/compose.override.yml']
        command = None
        if args[:len(prefix)] == prefix:
            tail = args[len(prefix):]
            sql_prefix = ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'jarv1s', '-t', '-A', '-c']
            if tail[:len(sql_prefix)] == sql_prefix and len(tail) == len(sql_prefix)+1:
                command = ['exec', campaign.owned_container_id(campaign.s['project']+'-postgres'),
                           'psql', '-U', 'postgres', '-d', 'jarv1s', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', tail[-1]]
            elif tail[:5] == ['exec', '-T', 'jarv1s', 'node', '-e'] and len(tail) == 6:
                script = tail[-1]
                matched = re.fullmatch(r"process\.kill\((\d+),\s*'(SIGSTOP|SIGCONT)'\)", script)
                if script not in campaign.worker_scripts and not matched:
                    raise RuntimeError('Only the pinned worker inspection and worker signals are allowed.')
                if matched:
                    pid = int(matched[1])
                    if pid <= 1:
                        raise RuntimeError('Invalid worker identity.')
                    script = ("const fs=require('fs');if(!fs.readFileSync('/proc/"+str(pid)+
                              "/cmdline','utf8').split('\\0').includes('dist/worker.js'))process.exit(90);"+script)
                command = ['exec', campaign.owned_container_id(campaign.s['appContainer']), 'node', '-e', script]
            elif tail == ['restart', 'jarv1s']:
                command = ['restart', '--time', '10', campaign.owned_container_id(campaign.s['appContainer'])]
        elif args == ['logs', '--tail', '1000', campaign.s['project']+'-jarv1s-1']:
            command = ['logs', '--tail', '1000', campaign.owned_container_id(campaign.s['appContainer'])]
        if command is None:
            raise RuntimeError('Helper command is outside the allowed scope.')
        with campaign.command_lock:
            code, stdout = campaign.dk(*command, seconds=90, check=False, capture=True)
            stderr = (campaign.d/'evidence'/f'{campaign.phase}-{campaign.seq:03d}.stderr').read_text()
            save(campaign.current_evidence/f'helper-{campaign.seq:03d}.json',
                 {'argv': args, 'mapped': command, 'exitCode': code})
        if len(stdout.encode())+len(stderr.encode()) > 2*1024*1024:
            raise RuntimeError('Helper output exceeds the size limit.')
        if code:
            self.failure = 'A helper command failed.'
        return {'code': code, 'stdout': stdout+'\n' if stdout else '', 'stderr': stderr}


def snapshot_manifest(source):
    result={'.':{'directory':True,'mode':source.stat().st_mode & 0o777}}
    for p in source.rglob('*'):
        key=str(p.relative_to(source))
        if p.is_symlink():
            result[key]={'link':os.readlink(p)}
        elif p.is_file():
            result[key]={'sha256':sha(p),'mode':p.stat().st_mode & 0o777}
        elif p.is_dir():
            result[key]={'directory':True,'mode':p.stat().st_mode & 0o777}
    return result


def normalize_context_directories(source):
    # Copied from R4. Only the freshly extracted private context; never follow or chmod symlinks.
    before=snapshot_manifest(source)
    directories=[source]
    for parent,names,_ in os.walk(source,followlinks=False):
        names[:]=[name for name in names if not (Path(parent)/name).is_symlink()]
        directories.extend(Path(parent)/name for name in names)
    changed=[]
    for directory in directories:
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError('context directory changed during preparation')
        mode=directory.stat().st_mode & 0o777
        os.chmod(directory,0o755,follow_symlinks=False)
        changed.append({'path':str(directory.relative_to(source)),
                        'beforeMode':mode,'afterMode':0o755})
    after=snapshot_manifest(source)
    files=lambda manifest:{p:v for p,v in manifest.items() if not v.get('directory')}
    if files(before)!=files(after):
        raise RuntimeError('directory correction changed source bytes/file modes/symlinks')
    return {'source':SOURCE,'onlyContextDirectoriesChanged':True,
            'sourceBytesFileModesAndSymlinksPreserved':True,'directoryMode':0o755,
            'outerCampaignMode':source.parent.stat().st_mode & 0o777,
            'directories':changed}


def stop(signum,frame):
    raise InterruptedError('received signal '+str(signum))


def arm_signals():
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase',choices=['prepare','build','test','release'])
    parser.add_argument('--campaign',help='Direct owned campaign directory basename')
    parser.add_argument('--docker-host',default='unix:///var/run/docker.sock')
    parser.add_argument('--execute',action='store_true')
    a=parser.parse_args()
    if not a.execute:
        parser.error('requires --execute; preparation/review is not execution authority')
    if a.docker_host!='unix:///var/run/docker.sock':
        parser.error('exact local Unix daemon only')
    if a.phase=='prepare':
        if a.campaign:
            parser.error('prepare generates its own nonce')
        nonce=secrets.token_hex(6)
        d=ROOT/('campaign-'+nonce)
        d.mkdir(mode=0o700)
        commit=subprocess.check_output(['git','-C',str(REPO),'merge-base',N3,SOURCE],timeout=15).decode().strip()
        if commit!=N3:
            raise RuntimeError('N3 ancestry mismatch')
        archive=d/'source.tar'
        subprocess.run(['git','-C',str(REPO),'archive','--format=tar','--output='+str(archive),SOURCE],check=True,timeout=30)
        source=d/'source'
        source.mkdir(mode=0o700)
        with tarfile.open(archive,mode='r:') as tf:
            members=tf.getmembers()
            if len(members)>15000 or sum(m.size for m in members)>256*1024*1024:
                raise RuntimeError('source archive exceeds finite preparation limits')
            tf.extractall(source,members=members,filter='data')
        correction=normalize_context_directories(source)
        save(d/'directory-mode-correction.json',correction)
        inputs=snapshot_manifest(source)
        save(d/'source-inputs.json',inputs)
        save(d/'state.json',{'source':SOURCE,'n3Ancestor':N3,'nonce':nonce,'project':'s4r19-'+nonce,
                             'containers':[],'volumes':[],'imageId':None,'accepted':False,
                             'directoryModeCorrectionSha256':sha(d/'directory-mode-correction.json')})
        recipe = (source/'Dockerfile').read_text()
        recipe += '\nUSER root\nRUN pnpm exec playwright install chrome && apt-get update && apt-get install -y --no-install-recommends xvfb xauth && rm -rf /var/lib/apt/lists/* && mv /opt/google/chrome/chrome /opt/google/chrome/chrome.real\n'
        (d/'Dockerfile').write_text(recipe)
        (d/'Dockerfile').chmod(0o600)
        prepared = json.loads((d/'state.json').read_text())
        prepared.update(recipeSha256=sha(d/'Dockerfile'), runnerSha256=sha(Path(__file__)),
                        full1133Accepted=False, stage4Accepted=False)
        save(d/'state.json', prepared)
        print(d.name)
        return
    if not a.campaign or Path(a.campaign).name!=a.campaign or not re.fullmatch(r'campaign-[0-9a-f]{12}',a.campaign):
        parser.error('--campaign must name direct owned child campaign directory')
    d=ROOT/a.campaign
    if d.is_symlink() or not d.is_dir():
        parser.error('campaign absent/unsafe')
    with (ROOT/'execution.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        c=Campaign(d,a.phase,a.docker_host)
        if sha(d/'directory-mode-correction.json')!=c.s.get('directoryModeCorrectionSha256'):
            raise RuntimeError('directory correction provenance changed')
        if sha(d/'Dockerfile') != c.s.get('recipeSha256') or sha(Path(__file__)) != c.s.get('runnerSha256'):
            raise RuntimeError('Prepared build recipe or runner changed.')
        inputs=json.loads((d/'source-inputs.json').read_text())
        if snapshot_manifest(d/'source')!=inputs:
            raise RuntimeError('source snapshot changed')
        arm_signals()
        if a.phase=='build':
            c.build()
        elif a.phase=='test':
            c.test()
        else:
            c.release()

if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        print(type(exc).__name__+': '+str(exc),file=sys.stderr)
        sys.exit(1)
