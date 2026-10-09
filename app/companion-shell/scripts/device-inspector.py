"""Serve a physical iPhone's Web Inspector as Chrome DevTools Protocol, on loopback only.

    device-inspector.py <udid> <port>

pymobiledevice3's own CDP bridge (`webinspector cdp`), reached over USB
through the Mac's usbmuxd, with two things it does not do itself:

- it binds 127.0.0.1 and takes no host to bind instead. `ios_webkit_debug_proxy`
  listens on every interface with no bind option, so a debug build's webview
  -- the Device's Noise key, a live Workstation connection -- was drivable
  from the LAN (companion-device-inspector-loopback-only.md).
- it refuses a request whose Host is not this loopback address, and a
  WebSocket whose Origin is anything but this server. Loopback alone still
  lets a web page in a browser on this Mac in: a WebSocket carries no CORS,
  and a rebound DNS name reads /json. The bridge checks neither.

A release build's webviews are not inspectable, so this reaches a debug
build only. `device-drive.sh ios-device <udid> inspector` runs it and then
proves the port refuses the Mac's LAN addresses.
"""
import asyncio
import sys

import uvicorn
from pymobiledevice3.exceptions import DeviceNotFoundError
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.web_protocol.cdp_server import app, find_chrome
from pymobiledevice3.services.webinspector import WebinspectorService

HOST = "127.0.0.1"


def guarded(inner, port: int):
    hosts = {f"{HOST}:{port}".encode(), f"localhost:{port}".encode()}
    origins = {b"http://" + h for h in hosts}

    async def guard(scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = dict(scope["headers"])
            ok = headers.get(b"host") in hosts
            # DevTools tools (Playwright, Puppeteer, websocat) send no Origin;
            # the DevTools frontend this server serves sends its own.
            if scope["type"] == "websocket" and b"origin" in headers:
                ok = ok and headers[b"origin"] in origins
            if not ok:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await send({"type": "http.response.start", "status": 403, "headers": []})
                    await send({"type": "http.response.body", "body": b"refused: not this loopback server\n"})
                return
        await inner(scope, receive, send)

    return guard


async def main(udid: str, port: int) -> int:
    try:
        lockdown = await create_using_usbmux(serial=udid)
    except DeviceNotFoundError:
        print(f"{udid} is not connected over USB", file=sys.stderr)
        return 2
    app.state.inspector = WebinspectorService(lockdown=lockdown)
    disconnected = asyncio.Event()
    app.state.inspector.on_connection_lost = disconnected.set
    app.state.chrome_path = find_chrome(None)
    app.state.pause_new_targets = False
    await app.state.inspector.connect()
    server = uvicorn.Server(uvicorn.Config(guarded(app, port), host=HOST, port=port, ws_ping_timeout=None, ws="wsproto", log_level="warning"))
    serving = asyncio.ensure_future(server.serve())
    gone = asyncio.ensure_future(disconnected.wait())
    await asyncio.wait({serving, gone}, return_when=asyncio.FIRST_COMPLETED)
    if disconnected.is_set():
        print(f"{udid} disconnected", file=sys.stderr)
        server.should_exit = True
        await serving
        return 1
    gone.cancel()
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(64)
    sys.exit(asyncio.run(main(sys.argv[1], int(sys.argv[2]))))
