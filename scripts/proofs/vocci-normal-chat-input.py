"""Real disposable-owner UI proof; run only via test:normal-chat-live / verify-gate.

ASR and chat are disclosed third-party stand-ins. Moss HTTP responses are untouched.
Generated sine audio and synthetic packet framing do not prove hardware/ASR accuracy.
"""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import struct
import subprocess
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright

assert os.environ.get('JARVIS_GATE_RUN') == '1', 'verify-gate required'
root = Path.home() / '.local/state/moss/vocci-recovery/normal-chat-input/live'
root.mkdir(parents=True, exist_ok=True)
run = max([int(p.name.split('_')[1]) for p in (root / 'final_runs').glob('run_*')] + [0]) + 1
out = root / 'final_runs' / f'run_{run}'
out.mkdir(parents=True)
shutil.copyfile(__file__, out / 'final_script.py')
shutil.copyfile(__file__, root / 'final_script.py')
url = os.environ['VOCCI_LIVE_URL']
log = out / 'final_script_log.txt'
records = []
transcript = 'Automatic normal input first proof'
busy_started = threading.Event()
release_busy = threading.Event()


def step(n, message):
    with log.open('a') as f:
        f.write(f'step {n} action: {message}\n')
    print(f'step {n}: {message}', flush=True)


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, value, code=200):
        body = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.respond({'object': 'list', 'data': []})

    def do_POST(self):
        body = self.rfile.read(int(self.headers['content-length']))
        if self.path == '/v1/audio/transcriptions':
            records.append({'path': self.path, 'audioMultipartBytes': len(body), 'transcript': transcript})
            self.respond({'text': transcript, 'segments': [{'start': 0, 'end': .12, 'text': transcript}]})
            return
        value = json.loads(body)
        records.append({'path': self.path, 'stream': value.get('stream', False)})
        messages = value.get('messages', [])
        last = str(next((m.get('content', '') for m in reversed(messages) if m.get('role') == 'user'), ''))
        if 'Busy typed proof' in last:
            busy_started.set()
            assert release_busy.wait(60), 'Busy proof did not release provider'
        text = 'Normal automatic reply proof.'
        if value.get('stream'):
            chunks = [
                {'id': 'proof', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'normal-proof-chat', 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': text}, 'finish_reason': None}]},
                {'id': 'proof', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'normal-proof-chat', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}
            ]
            response = ''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
            data = response.encode()
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.respond({'choices': [{'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}})


port = int(subprocess.check_output(['devports', 'claim', 'vocci-normal-chat-provider']).decode().strip())
server = ThreadingHTTPServer(('127.0.0.1', port), Provider)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
endpoint = f'http://127.0.0.1:{port}'


def api(context, method, path, data=None, expected=200):
    response = context.request.fetch(url + path, method=method, **({'data': data} if data is not None else {}))
    assert response.status == expected, f'{method} {path}: {response.status} {response.text()[:400]}'
    return response.json()


def wait_status(context, path, predicate, page, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = api(context, 'GET', path)
        if predicate(value):
            return value
        page.wait_for_timeout(1000)
    raise AssertionError(f'Status deadline {path}: {value}')


def bundle(device):
    rid = 'amsg_1792470000_' + uuid.uuid4().hex[:8]
    pcm = b''.join(struct.pack('<h', int(1600 * math.sin(i * 2 * math.pi * 220 / 16000))) for i in range(1920))
    wav = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', len(pcm) + 36, b'WAVE', b'fmt ', 16, 1, 1, 16000, 32000, 2, 16, b'data', len(pcm)) + pcm
    files = {'wav': wav, 'packets': bytes([255, 1, 0, 0, 1, 0]), 'sidecar': b'{"record":["1792470000","start"]},{"duration":["1792470000","120"]},{"record":["1792470000","end"]}'}
    value = {'version': 1, 'sourceDeviceId': device, 'recordingId': rid}
    for kind, data in files.items():
        value[kind] = {'name': rid + {'wav': '.wav', 'packets': '.opus', 'sidecar': '.json'}[kind], 'base64': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest()}
    return value


def admit(context, page, device, enablement, text):
    global transcript
    transcript = text
    value = {'version': 2, 'intent': 'voice-request', 'enablementId': enablement, 'capturedAt': None, 'recording': bundle(device)}
    accepted = api(context, 'POST', '/api/meetings/voice-recordings', value, 202)
    completed = wait_status(context, '/api/meetings/voice-recordings/' + accepted['id'], lambda s: s['state'] == 'complete', page)
    return value, completed['voiceRequestId']


def receipt(context, rid):
    return api(context, 'GET', '/api/chat/voice-requests/' + rid)


def replied(context, page, rid):
    return wait_status(context, '/api/chat/voice-requests/' + rid, lambda s: s['state'] == 'replied', page)


try:
    with sync_playwright() as p:
        browser = p.firefox.launch(headless=True)
        try:
            context = browser.new_context(viewport={'width': 1280, 'height': 1800}, service_workers='block')
            page = context.new_page()
            page.set_default_timeout(30000)
            posts = []
            page.on('request', lambda r: posts.append(r.url) if r.method == 'POST' and '/api/chat/' in r.url else None)
            page.goto(url)
            page.get_by_label('Name', exact=True).fill('Normal chat proof')
            page.get_by_label('Email', exact=True).fill('normal-chat-proof@example.test')
            page.get_by_label('Password', exact=True).fill(secrets.token_urlsafe(24))
            page.get_by_role('button', name='Create account', exact=True).click()
            page.get_by_role('button', name='Skip setup', exact=True).click(timeout=30000)
            page.get_by_role('button', name='Skip anyway', exact=True).click()
            page.get_by_role('button', name=re.compile('^Account menu')).click()
            page.get_by_role('menuitem', name='Settings', exact=True).click()
            provider = api(context, 'POST', '/api/ai/providers', {'providerKind': 'openai-compatible', 'displayName': 'Disclosed normal chat stand-in', 'baseUrl': endpoint, 'authMethod': 'api_key', 'credentialPayload': {'apiKey': 'synthetic-proof-key'}}, 201)['provider']['id']
            models = {}
            for kind, tier in [('transcription', 'economy'), ('chat', 'interactive')]:
                models[kind] = api(context, 'POST', '/api/ai/models', {'providerConfigId': provider, 'providerModelId': 'normal-proof-' + kind, 'displayName': 'Proof ' + kind, 'capabilities': [kind], 'status': 'active', 'tier': tier}, 201)['model']['id']
            page.get_by_role('button', name='Admin / Setup', exact=True).click()
            page.get_by_role('button', name='AI providers', exact=True).click()
            with page.expect_response(lambda r: r.url.endswith('/api/ai/services/chat/binding') and r.request.method == 'PUT') as chat_saved:
                page.get_by_label('Binding for Chat & briefing', exact=True).select_option('model:' + models['chat'])
            assert chat_saved.value.status == 200
            page.get_by_label('Provider and model', exact=True).select_option(models['transcription'])
            with page.expect_response(lambda r: r.url.endswith('/api/ai/services/transcription/binding') and r.request.method == 'PUT') as saved:
                page.get_by_role('button', name='Save transcription provider', exact=True).click()
            assert saved.value.status == 200
            step(1, 'Disposable signup and real Settings chat/transcription bindings saved')
            page.goto(url + '/today')
            page.get_by_role('button', name='Chat with Moss', exact=True).click()
            drawer = page.get_by_role('dialog', name='Chat with Moss', exact=True)
            composer = drawer.get_by_label('Message Moss', exact=True)
            expect(composer).to_be_editable(timeout=60000)
            composer.fill('Keep my unsent typed draft')
            device = str(uuid.uuid4())
            enabled = api(context, 'POST', '/api/meetings/voice-enablement', {'version': 2, 'sourceDeviceId': device, 'requestKey': str(uuid.uuid4()), 'recordingIds': []})['id']
            original, first = admit(context, page, device, enabled, 'Automatic normal input first proof')
            first_receipt = replied(context, page, first)
            expect(drawer.locator('.chatd-msg--me .chatd-bubble').filter(has_text='Automatic normal input first proof')).to_have_count(1, timeout=30000)
            expect(drawer.locator('.chatd-msg:not(.chatd-msg--me) .chatd-bubble').filter(has_text='Normal automatic reply proof.')).to_have_count(1)
            expect(composer).to_have_value('Keep my unsent typed draft')
            assert not drawer.get_by_text('Ring voice requests', exact=False).count()
            assert not drawer.get_by_role('button', name='Send to Main', exact=True).count()
            assert not any('/send' in item or item.endswith('/turn') for item in posts)
            step(2, 'Uncertain-time versioned audio automatically produced one normal user/reply; no Send/popup; typed draft preserved')
            # Replay the exact real receiver envelope; assert immutable receipt and saved pair.
            replay = api(context, 'POST', '/api/meetings/voice-recordings', original)
            assert replay['voiceRequestId'] == first
            assert receipt(context, first) == first_receipt
            page.reload(wait_until='commit')
            page.get_by_role('button', name='Chat with Moss', exact=True).click()
            expect(drawer.locator('.chatd-msg--me .chatd-bubble').filter(has_text='Automatic normal input first proof')).to_have_count(1, timeout=60000)
            expect(composer).to_have_value('Keep my unsent typed draft')
            step(3, 'Exact receiver replay retained receipt and reload recovered one canonical pair without changing draft')
            drawer.get_by_role('button', name='More chat options', exact=True).click()
            page.get_by_role('menuitemcheckbox', name='Start private chat', exact=True).click()
            expect(drawer.get_by_text('Private chat: not saved to history.', exact=False)).to_be_visible()
            _, private_id = admit(context, page, device, enabled, 'Private deferral input proof')
            assert receipt(context, private_id)['state'] == 'queued'
            page.wait_for_timeout(16000)
            assert receipt(context, private_id)['state'] == 'queued'
            assert 'Private deferral input proof' not in drawer.inner_text()
            drawer.get_by_role('button', name='More chat options', exact=True).click()
            page.get_by_role('menuitemcheckbox', name='Leave private chat', exact=True).click()
            expect(drawer.get_by_text('Private chat: not saved to history.', exact=False)).to_have_count(0)
            expect(composer).to_be_editable(timeout=60000)
            replied(context, page, private_id)
            expect(drawer.locator('.chatd-msg--me .chatd-bubble').filter(has_text='Private deferral input proof')).to_have_count(1, timeout=30000)
            step(4, 'Private selection hid voice evidence and deferred effects until Main; normal history recovered')
            composer.fill('Busy typed proof')
            drawer.get_by_role('button', name='Send', exact=True).click()
            assert busy_started.wait(40), 'Real chat provider was not reached'
            _, second = admit(context, page, device, enabled, 'Busy queued input second proof')
            _, third = admit(context, page, device, enabled, 'Busy queued input third proof')
            assert receipt(context, second)['state'] == 'queued' and receipt(context, third)['state'] == 'queued'
            expect(drawer.locator('.chatd-msg--me .chatd-bubble').filter(has_text='Busy queued input second proof')).to_have_count(1, timeout=15000)
            release_busy.set()
            replied(context, page, second)
            replied(context, page, third)
            for text in ['Busy queued input second proof', 'Busy queued input third proof']:
                expect(drawer.locator('.chatd-msg--me .chatd-bubble').filter(has_text=text)).to_have_count(1, timeout=30000)
            step(5, 'Real in-flight typed turn deferred two voice arrivals; canonical serialized replies and stable normal bubbles recovered')
            # Actual preclaim provider loss: disable model through real API, then restore it.
            api(context, 'PATCH', '/api/ai/models/' + models['chat'], {'status': 'disabled'})
            _, failed = admit(context, page, device, enabled, 'Provider recovery input proof')
            page.wait_for_timeout(16000)
            assert receipt(context, failed)['state'] == 'queued'
            api(context, 'PATCH', '/api/ai/models/' + models['chat'], {'status': 'active'})
            replied(context, page, failed)
            expect(drawer.locator('.chatd-msg--me .chatd-bubble').filter(has_text='Provider recovery input proof')).to_have_count(1, timeout=30000)
            step(6, 'Real provider-unavailable preclaim failure retained queue; restoring model recovered automatically')
            session = api(context, 'GET', '/api/auth/get-session')
            legacy = subprocess.check_output(['node', '--import', 'tsx', 'scripts/proofs/seed-legacy-voice-input.ts', session['user']['id'], first_receipt['threadId']], text=True).strip()
            expect(drawer.locator('.chatd-msg--me .chatd-bubble').filter(has_text='Legacy retained input proof')).to_have_count(1, timeout=15000)
            assert receipt(context, legacy)['state'] == 'ready-to-send'
            drawer.get_by_role('button', name='Send to Main', exact=True).click()
            replied(context, page, legacy)
            expect(drawer.get_by_role('button', name='Send to Main', exact=True)).to_have_count(0, timeout=15000)
            step(7, 'Pre-upgrade receipt fixture remained accessible inline and dispatched once only through its recovery control')
            messages = api(context, 'GET', '/api/chat/threads/' + first_receipt['threadId'] + '/messages')['messages']
            for rid in [first, private_id, second, third, failed, legacy]:
                current = receipt(context, rid)
                pair = [m for m in messages if m.get('turnId') == current['turnId']]
                assert len(pair) == 2 and {m['id'] for m in pair} == {current['userMessageId'], current['assistantMessageId']}
            page.set_viewport_size({'width': 390, 'height': 844})
            assert drawer.evaluate('(e) => e.scrollWidth <= e.clientWidth')
            assert not drawer.locator('.chat-voice-requests').count()
            (out / 'receipt.json').write_text(json.dumps({'assertions': 7, 'actualCanonicalPairs': 6, 'thirdPartyASRAndChatStandIns': True, 'generatedAudio': True, 'syntheticPacketFraming': True, 'linguisticOrHardwareAccuracyTested': False, 'MossResponsesIntercepted': False, 'serviceWorkersBlocked': True, 'productionOrPhoneOperations': False, 'providerCalls': records}, indent=2))
            step(8, 'All six voice turns have exactly their reserved saved pair; narrow transcript layout passed; NORMAL CHAT LIVE PASS')
        except Exception:
            (out / 'failure.txt').write_text(traceback.format_exc())
            if 'page' in locals():
                try:
                    (out / 'failure-dom.txt').write_text(page.locator('body').inner_text(timeout=5000))
                except Exception as diagnostic_error:
                    (out / 'failure-diagnostic.txt').write_text(str(diagnostic_error))
            (out / 'requests.json').write_text(json.dumps(records, indent=2))
            raise
        finally:
            release_busy.set()
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
    subprocess.run(['devports', 'release', str(port)], check=True)
