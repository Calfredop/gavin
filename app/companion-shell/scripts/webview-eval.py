"""Evaluate script in a debug build's webview on a physical iPhone, over USB.

    webview-eval.py <udid> <url-prefix>     (the script on stdin)

Finds the Companion's inspectable page whose URL starts with the prefix
(`gavin-bundle://` for a Workstation's bundle, `capacitor://localhost` for
the hub), evaluates the script there, awaits it if it returns a promise,
and prints the result as a string. It never navigates the page.

It talks to the Web Inspector service through the Mac's own usbmuxd and
opens no port, unlike `ios_webkit_debug_proxy`, which listens on every
interface (companion-device-inspector-loopback-only.md). A release build's
webviews are not inspectable, so this reaches a debug build only.
"""
import asyncio
import sys

from pymobiledevice3.cli.webinspector import webinspector_service
from pymobiledevice3.exceptions import DeviceNotFoundError
from pymobiledevice3.lockdown import create_using_usbmux

APP = "com.gavin.companion"


async def main(udid: str, prefix: str, script: str) -> int:
    try:
        lockdown = await create_using_usbmux(serial=udid)
    except DeviceNotFoundError:
        print(f"{udid} is not connected over USB")
        return 2
    async with webinspector_service(lockdown) as inspector:
        pages = await inspector.get_open_application_pages(timeout=2)
        pages = [p for p in pages if p.application.bundle == APP and (p.page.web_url or "").startswith(prefix)]
        if not pages:
            print(f"no {APP} page at {prefix}: is a debug build open there, unlocked, with Web Inspector on?")
            return 2
        page = pages[0]
        session = await inspector.inspector_session(page.application, page.page)
        await session.runtime_enable()
        # The result is parked on the page and polled: an evaluation that
        # awaits a promise does not come back over this service.
        wrapped = (
            "(async () => { return " + script.strip().rstrip(";") + " })()"
            ".then(v => { window.__evalResult = typeof v === 'string' ? v : JSON.stringify(v); return 1 },"
            " e => { window.__evalResult = 'ERR ' + (e && e.message || e); return 1 })"
        )
        await session.runtime_evaluate("window.__evalResult = undefined", return_by_value=True)
        await session.runtime_evaluate(wrapped, return_by_value=False)
        for _ in range(100):
            result = await session.runtime_evaluate("window.__evalResult", return_by_value=True)
            if result is not None and result != "undefined":
                print(result)
                return 0
            await asyncio.sleep(0.2)
        print("no answer from the page in 20 s")
        return 1


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(64)
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2], sys.stdin.read())))
