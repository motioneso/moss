"""Private container stdio transport; not a public arbitrary-CDP endpoint."""
import json
import sys
from urllib.request import urlopen
import websocket

with urlopen('http://127.0.0.1:9222/json/list', timeout=3) as response:
    targets = json.load(response)
target = next(t for t in targets if t['type'] == 'page' and
              t['url'].startswith(('http://127.0.0.1:8080', 'chrome://sandbox')))
command = json.load(sys.stdin)
connection = websocket.create_connection(target['webSocketDebuggerUrl'], timeout=5,
                                         suppress_origin=True)
try:
    connection.send(json.dumps({'id': 1, **command}))
    while True:
        result = json.loads(connection.recv())
        if result.get('id') == 1:
            if 'error' in result:
                raise RuntimeError('CDP probe command failed')
            print(json.dumps(result['result']))
            break
finally:
    connection.close()
