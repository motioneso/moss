#!/usr/bin/env python3
"""Test-only TLS file registry; called by the explicit HTTPS integration proof."""
import functools,http.server,pathlib,ssl,sys
root,cert,key,port,ready=sys.argv[1:]
handler=functools.partial(http.server.SimpleHTTPRequestHandler,directory=root)
server=http.server.ThreadingHTTPServer(('0.0.0.0',int(port)),handler)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(cert,key)
server.socket=context.wrap_socket(server.socket,server_side=True)
pathlib.Path(ready).write_text('ready')
server.serve_forever()
