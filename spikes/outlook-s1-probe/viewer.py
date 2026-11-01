"""One-time-token browser viewer for the S1 sign-in. Tailnet address only.

Usage: viewer.py PORT. Prints the token once. The token works for exactly one first
visit, which sets a session cookie; the viewer exits on Finish or after 60 minutes.
"""
import asyncio
import base64
from http import HTTPStatus
import json
import os
import secrets
import subprocess
import sys
import time

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from common import STATE, Cdp, record

LIFETIME = 60 * 60
START_URL = 'https://outlook.office.com/calendar/'
KEYS = {'Enter': (13, '\r'), 'Backspace': (8, ''), 'Tab': (9, ''), 'Escape': (27, ''),
        'ArrowLeft': (37, ''), 'ArrowUp': (38, ''), 'ArrowRight': (39, ''),
        'ArrowDown': (40, ''), 'Delete': (46, ''), 'Home': (36, ''), 'End': (35, '')}

PAGE = r"""<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Sign-in window</title>
<style>
body{margin:0;font:15px system-ui,sans-serif;background:#1c1c1c;color:#eee}
#bar{display:flex;gap:8px;padding:8px;flex-wrap:wrap;align-items:center;background:#2a2a2a}
button,input{font:inherit;padding:6px 10px}
#shot{display:block;max-width:100%;margin:0 auto;cursor:pointer;touch-action:manipulation}
#st{opacity:.7;margin-left:auto}
</style>
<div id=bar>
<button id=open>Open Outlook calendar</button>
<input id=txt placeholder="Type here for phones" size=22><button id=send>Send</button>
<button data-k=Enter>Enter</button><button data-k=Tab>Tab</button><button data-k=Backspace>Backspace</button>
<button id=done>Finished</button><span id=st>connecting</span></div>
<img id=shot alt="" draggable=false tabindex=0>
<script>
const shot=document.getElementById('shot'),st=document.getElementById('st');
const ws=new WebSocket((location.protocol=='https:'?'wss://':'ws://')+location.host+'/ws');
ws.binaryType='blob';
const send=o=>ws.readyState==1&&ws.send(JSON.stringify(o));
ws.onopen=()=>st.textContent='connected';ws.onclose=()=>st.textContent='closed';
ws.onmessage=e=>{if(typeof e.data=='string'){st.textContent=e.data;return}
 const u=URL.createObjectURL(e.data);const old=shot.src;shot.onload=()=>URL.revokeObjectURL(old);shot.src=u};
const pos=e=>{const r=shot.getBoundingClientRect();return{x:(e.clientX-r.left)*shot.naturalWidth/r.width,
 y:(e.clientY-r.top)*shot.naturalHeight/r.height}};
shot.addEventListener('click',e=>{shot.focus();send({t:'click',...pos(e)})});
shot.addEventListener('wheel',e=>{e.preventDefault();send({t:'wheel',...pos(e),dy:e.deltaY})},{passive:false});
window.addEventListener('keydown',e=>{if(e.target.tagName=='INPUT')return;
 if(e.ctrlKey||e.metaKey){if(e.key=='a')send({t:'cmd',c:'selectAll'});return}
 e.preventDefault();send({t:'key',key:e.key})});
window.addEventListener('paste',e=>{if(e.target.tagName=='INPUT')return;
 const t=e.clipboardData.getData('text');if(t)send({t:'text',text:t})});
document.getElementById('send').onclick=()=>{const i=document.getElementById('txt');
 if(i.value)send({t:'text',text:i.value});i.value=''};
document.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>send({t:'key',key:b.dataset.k}));
document.getElementById('open').onclick=()=>send({t:'open'});
document.getElementById('done').onclick=()=>send({t:'done'});
</script>"""


class Viewer:
    def __init__(self, host, port):
        self.origin = f'http://{host}:{port}'
        self.token = secrets.token_urlsafe(24)
        self.session = None
        self.cdp = None
        self.page = None
        self.deadline = time.monotonic() + LIFETIME
        self.stop = asyncio.Event()

    def respond(self, status, body, kind='text/html; charset=utf-8', extra=()):
        headers = Headers([('Content-Type', kind), ('Content-Length', str(len(body))),
                           ('Cache-Control', 'no-store'), ('Referrer-Policy', 'no-referrer'),
                           *extra])
        return Response(status.value, status.phrase, headers, body)

    def cookie_ok(self, request):
        for part in request.headers.get('Cookie', '').split(';'):
            name, _, value = part.strip().partition('=')
            if name == 'viewer' and self.session and secrets.compare_digest(value, self.session):
                return True
        return False

    async def process_request(self, connection, request):
        path, _, query = request.path.partition('?')
        if path == '/ws':
            if self.cookie_ok(request) and request.headers.get('Origin') == self.origin:
                return None
            return self.respond(HTTPStatus.FORBIDDEN, b'no')
        if path == '/' and query.startswith('t=') and self.session is None and \
                secrets.compare_digest(query[2:], self.token):
            self.session = secrets.token_urlsafe(24)
            self.token = None
            return self.respond(HTTPStatus.FOUND, b'', extra=[
                ('Location', '/'),
                ('Set-Cookie', f'viewer={self.session}; HttpOnly; SameSite=Strict; Path=/')])
        if path == '/' and self.cookie_ok(request):
            return self.respond(HTTPStatus.OK, PAGE.encode())
        return self.respond(HTTPStatus.FORBIDDEN, b'no')

    async def key(self, session, name):
        if name in KEYS:
            code, text = KEYS[name]
            for kind in ('rawKeyDown', 'keyUp'):
                params = {'type': kind, 'key': name, 'windowsVirtualKeyCode': code}
                if text and kind == 'rawKeyDown':
                    params['text'] = text
                await self.cdp.call('Input.dispatchKeyEvent', params, session=session)
        elif len(name) == 1:
            await self.cdp.call('Input.dispatchKeyEvent', {
                'type': 'keyDown', 'key': name, 'text': name}, session=session)
            await self.cdp.call('Input.dispatchKeyEvent', {
                'type': 'keyUp', 'key': name}, session=session)

    async def handle_input(self, session, data):
        kind = data.get('t')
        if kind == 'click':
            point = {'x': float(data['x']), 'y': float(data['y']), 'button': 'left',
                     'clickCount': 1}
            await self.cdp.call('Input.dispatchMouseEvent', {'type': 'mousePressed', **point},
                                session=session)
            await self.cdp.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', **point},
                                session=session)
        elif kind == 'wheel':
            await self.cdp.call('Input.dispatchMouseEvent', {
                'type': 'mouseWheel', 'x': float(data['x']), 'y': float(data['y']),
                'deltaX': 0, 'deltaY': float(data['dy'])}, session=session)
        elif kind == 'key':
            await self.key(session, str(data['key']))
        elif kind == 'text':
            await self.cdp.call('Input.insertText', {'text': str(data['text'])[:512]},
                                session=session)
        elif kind == 'cmd' and data.get('c') == 'selectAll':
            await self.cdp.call('Input.dispatchKeyEvent', {
                'type': 'rawKeyDown', 'key': 'a', 'modifiers': 2, 'commands': ['selectAll'],
                'windowsVirtualKeyCode': 65}, session=session)
        elif kind == 'open':
            await self.cdp.call('Page.navigate', {'url': START_URL}, session=session)
        elif kind == 'done':
            self.stop.set()

    async def frames(self, ws, session):
        last = b''
        while not self.stop.is_set():
            try:
                shot = await self.cdp.call('Page.captureScreenshot',
                                           {'format': 'jpeg', 'quality': 60}, session=session)
                image = base64.b64decode(shot['data'])
                if image != last:
                    last = image
                    await ws.send(image)
            except (RuntimeError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(0.35)

    async def handler(self, ws):
        if self.cdp is not None:
            await ws.close()
            return
        self.cdp = Cdp()
        await self.cdp.open()
        try:
            _, session = await self.cdp.page_session()
            await self.cdp.call('Page.enable', session=session)
            sender = asyncio.create_task(self.frames(ws, session))
            async for message in ws:
                try:
                    await self.handle_input(session, json.loads(message))
                except (RuntimeError, ValueError, KeyError, TypeError, asyncio.TimeoutError):
                    pass
            sender.cancel()
            await self.cdp.call('Target.detachFromTarget', {'sessionId': session})
        finally:
            self.cdp.close()
            self.cdp = None

    async def run(self, host, port):
        async with serve(self.handler, host, port, process_request=self.process_request,
                         max_size=1 << 16):
            print(f'{self.origin}/?t={self.token}', flush=True)
            try:
                await asyncio.wait_for(self.stop.wait(), LIFETIME)
            except asyncio.TimeoutError:
                pass


def main():
    port = int(sys.argv[1])
    host = subprocess.run(['tailscale', 'ip', '-4'], capture_output=True, text=True,
                          check=True).stdout.split()[0]
    lock = STATE / 'viewer.lock'
    lock.write_text(str(os.getpid()))
    record('viewer opened')
    try:
        asyncio.run(Viewer(host, port).run(host, port))
    finally:
        lock.unlink(missing_ok=True)
        record('viewer closed')


if __name__ == '__main__':
    main()
